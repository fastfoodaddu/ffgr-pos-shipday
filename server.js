import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE = "https://api.ewitypos.com";
const TOKEN = process.env.EWITY_API_TOKEN;

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/json"
};

app.get("/", (req, res) => {
  res.json({
    status: "running",
    token: TOKEN ? "available" : "missing"
  });
});

app.get("/test-ewity", async (req, res) => {
  try {
    const r = await axios.get(`${BASE}/v1/ui/payment-types`, { headers });
    res.json({ success: true, data: r.data });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
