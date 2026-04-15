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
  Accept: "application/json",
  "Content-Type": "application/json"
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

// Probe likely Ewity sales endpoints
app.get("/probe-sales", async (req, res) => {
  const endpoints = [
    "/v1/sales/bills",
    "/v1/sales",
    "/v1/sales/orders",
    "/v1/orders",
    "/v1/bills"
  ];

  const results = [];

  for (const ep of endpoints) {
    try {
      const r = await axios.get(`${BASE}${ep}`, { headers });
      results.push({
        endpoint: ep,
        ok: true,
        status: r.status,
        sample: r.data
      });
    } catch (err) {
      results.push({
        endpoint: ep,
        ok: false,
        status: err.response?.status || 500,
        error: err.response?.data || err.message
      });
    }
  }

  res.json(results);
});

// Test one bill by QR if you have a valid Ewity bill QR link
app.get("/bill-from-qr", async (req, res) => {
  try {
    const qr = req.query.qr;
    if (!qr) {
      return res.status(400).json({ error: "Missing qr parameter" });
    }

    const encodedQr = encodeURIComponent(qr);
    const r = await axios.get(`${BASE}/v1/sales/bills/from-qr?qr=${encodedQr}`, {
      headers
    });

    res.json(r.data);
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
