import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
let EWITY_TOKEN = null;

// Login function with crash protection
async function loginEwity() {
  try {
    const res = await axios.post("https://api.ewitypos.com/auth/login", {
      username: process.env.EWITY_USER,
      password: process.env.EWITY_PASS,
    });

    EWITY_TOKEN = res.data.access_token;
    console.log("Ewity token updated");
    return true;
  } catch (err) {
    console.error("EWITY LOGIN FAILED:");
    console.error(err.response?.data || err.message);
    return false;
  }
}

// Health route
app.get("/", (req, res) => {
  res.json({
    status: "running",
    ewity_token: EWITY_TOKEN ? "available" : "missing",
  });
});

// Test login route
app.get("/test-login", async (req, res) => {
  const ok = await loginEwity();
  if (!ok) {
    return res.status(500).json({ error: "Ewity login failed" });
  }
  res.json({ success: true });
});

// Orders route
app.get("/orders", async (req, res) => {
  try {
    if (!EWITY_TOKEN) {
      const ok = await loginEwity();
      if (!ok) {
        return res.status(500).json({ error: "Could not get Ewity token" });
      }
    }

    const response = await axios.get("https://api.ewitypos.com/orders", {
      headers: {
        Authorization: `Bearer ${EWITY_TOKEN}`,
      },
    });

    res.json(response.data);
  } catch (err) {
    console.error("ORDERS FETCH FAILED:");
    console.error(err.response?.data || err.message);
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

// Start server safely
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Refresh token periodically without crashing app
setInterval(async () => {
  await loginEwity();
}, 30 * 60 * 1000);

// Prevent Railway crash on unhandled promise rejection
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
