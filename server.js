import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

// Simple CORS middleware
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
const SHIPDAY_API_KEY = process.env.SHIPDAY_API_KEY || "";

function getTimeHHMMSS() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function shipdayHeaders() {
  return {
    Authorization: `Basic ${SHIPDAY_API_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function parseMoney(text) {
  if (text == null) return 0;
  const cleaned = String(text).replace(/[^0-9.-]/g, "");
  return Number(cleaned || 0);
}

function mapPublicBillToShipday(publicBillJson) {
  const bill = publicBillJson?.bill || {};
  const customer = bill?.customer?.object || {};
  const headerParts = Array.isArray(bill?.header_parts) ? bill.header_parts : [];
  const totalParts = Array.isArray(bill?.total_parts) ? bill.total_parts : [];
  const lines = Array.isArray(bill?.bill_lines) ? bill.bill_lines : [];

  const headerMap = Object.fromEntries(headerParts.map((p) => [p.key, p.value]));
  const totalMap = Object.fromEntries(totalParts.map((p) => [p.key, p.value]));

  const orderItems = lines.map((line) => ({
    name: line?.variant?.name || "Item",
    unitPrice: parseMoney(line?.total_text),
    quantity: Number(String(line?.quantity_text || "1").match(/[0-9.]+/)?.[0] || 1),
    addOns: [],
  }));

  const payload = {
    orderNumber:
      headerMap["Bill Number"] ||
      bill?.number ||
      bill?.client_bill_id ||
      "",
    customerName: customer?.name || "FFGR Customer",
    customerPhoneNumber: customer?.mobile || "",
    customerAddress: process.env.DEFAULT_CUSTOMER_ADDRESS || "Address not provided",
    restaurantName: process.env.RESTAURANT_NAME || "FFGR",
    totalOrderCost: parseMoney(totalMap["Total"] || bill?.total_text),
    expectedPickupTime: getTimeHHMMSS(),
    pickupAddress:
      process.env.FFGR_PICKUP_ADDRESS ||
      "Fast Food Gourmet Restaurant, Hithadhoo, Addu City",
    orderItems,
    notes: [
      `Ewity Public Bill ID: ${publicBillJson?.id || ""}`,
      `Ewity Client Bill ID: ${bill?.client_bill_id || ""}`,
      `Payment Status: ${headerMap["Payment Status"] || bill?.payment_status || ""}`,
      `Date: ${headerMap["Date"] || ""}`,
    ].filter(Boolean).join(" | "),
  };

  if (process.env.FFGR_PICKUP_LAT) {
    payload.pickupLatitude = Number(process.env.FFGR_PICKUP_LAT);
  }

  if (process.env.FFGR_PICKUP_LNG) {
    payload.pickupLongitude = Number(process.env.FFGR_PICKUP_LNG);
  }

  return payload;
}

async function sendToShipday(payload) {
  if (!SHIPDAY_API_KEY) {
    throw new Error("SHIPDAY_API_KEY is missing");
  }

  const response = await axios.post(
    "https://api.shipday.com/orders",
    payload,
    {
      headers: shipdayHeaders(),
      timeout: 20000,
    }
  );

  return response.data;
}

app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "ewity-browser-json-to-shipday",
    shipday_api_key: SHIPDAY_API_KEY ? "available" : "missing",
  });
});

app.post("/test-public-bill-json", (req, res) => {
  try {
    const publicBillJson = req.body;
    const shipdayPayload = mapPublicBillToShipday(publicBillJson);

    res.json({
      success: true,
      received: publicBillJson,
      shipdayPayload,
    });
  } catch (err) {
    console.error("test-public-bill-json error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.post("/send-public-bill-json-to-shipday", async (req, res) => {
  try {
    const publicBillJson = req.body;
    const shipdayPayload = mapPublicBillToShipday(publicBillJson);
    const shipdayResponse = await sendToShipday(shipdayPayload);

    res.json({
      success: true,
      shipdayPayload,
      shipdayResponse,
    });
  } catch (err) {
    console.error("send-public-bill-json-to-shipday error:", err.response?.data || err.message);
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
