import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

console.log("DEPLOY VERSION 2026-04-16-ewity-api-pull");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

const PORT = process.env.PORT || 3000;
const EWITY_BEARER = process.env.EWITY_BEARER || "";

function ewityHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${EWITY_BEARER}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

function extractPublicBillIdFromUrl(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "b" && parts[1]) {
      return parts[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchAsyncTasks(limit = 5) {
  const response = await axios.get(
    `https://app.ewitypos.com/api/v1/async-tasks/my?limit=${encodeURIComponent(limit)}`,
    {
      headers: ewityHeaders(),
      timeout: 20000,
    }
  );
  return response.data;
}

async function fetchDr3Bill(clientBillId) {
  const response = await axios.post(
    "https://app.ewitypos.com/api/v1/ebills/dr3-bill",
    {
      client_bill_id: clientBillId,
    },
    {
      headers: ewityHeaders(),
      timeout: 20000,
    }
  );
  return response.data;
}

app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "ewity-api-pull",
    ewity_bearer: EWITY_BEARER ? "available" : "missing",
  });
});

app.get("/version", (req, res) => {
  res.json({
    version: "2026-04-16-ewity-api-pull",
  });
});

app.get("/test-ewity-orders", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 5);
    const data = await fetchAsyncTasks(limit);

    res.json({
      success: true,
      endpoint: "GET /api/v1/async-tasks/my",
      data,
    });
  } catch (err) {
    console.error("test-ewity-orders error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.post("/test-dr3-bill", async (req, res) => {
  try {
    const { client_bill_id } = req.body;

    if (!client_bill_id) {
      return res.status(400).json({
        success: false,
        error: "client_bill_id is required",
      });
    }

    const data = await fetchDr3Bill(client_bill_id);
    const publicUrl = data?.data?.url || data?.url || null;
    const publicBillId = extractPublicBillIdFromUrl(publicUrl);

    res.json({
      success: true,
      endpoint: "POST /api/v1/ebills/dr3-bill",
      client_bill_id,
      publicUrl,
      publicBillId,
      data,
    });
  } catch (err) {
    console.error("test-dr3-bill error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.get("/test-dr3-bill-get", async (req, res) => {
  try {
    const client_bill_id = req.query.client_bill_id;

    if (!client_bill_id) {
      return res.status(400).json({
        success: false,
        error: "client_bill_id is required",
      });
    }

    const data = await fetchDr3Bill(client_bill_id);
    const publicUrl = data?.data?.url || data?.url || null;
    const publicBillId = extractPublicBillIdFromUrl(publicUrl);

    res.json({
      success: true,
      endpoint: "POST /api/v1/ebills/dr3-bill",
      client_bill_id,
      publicUrl,
      publicBillId,
      data,
    });
  } catch (err) {
    console.error("test-dr3-bill-get error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.get("/pull-order-chain", async (req, res) => {
  try {
    const client_bill_id = req.query.client_bill_id;

    if (!client_bill_id) {
      return res.status(400).json({
        success: false,
        error: "client_bill_id is required",
      });
    }

    const dr3 = await fetchDr3Bill(client_bill_id);
    const publicUrl = dr3?.data?.url || dr3?.url || null;
    const publicBillId = extractPublicBillIdFromUrl(publicUrl);

    res.json({
      success: true,
      client_bill_id,
      dr3,
      publicUrl,
      publicBillId,
      note: "Public bill details route on my.ewity.com was not reliable server-to-server from Railway due to 403.",
    });
  } catch (err) {
    console.error("pull-order-chain error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
