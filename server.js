import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

console.log("DEPLOY VERSION 2026-04-16-ewity-pull-and-shipday-push");

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
const SHIPDAY_API_KEY = process.env.SHIPDAY_API_KEY || "";

function ewityHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${EWITY_BEARER}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    ...extra,
  };
}

function shipdayHeaders() {
  return {
    Authorization: `Basic ${SHIPDAY_API_KEY}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function getTimeHHMMSS() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function parseMoney(text) {
  if (text == null) return 0;
  const cleaned = String(text).replace(/[^0-9.-]/g, "");
  return Number(cleaned || 0);
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
app.get("/ewity-orders", async (req, res) => {
  try {
    const location = req.query.location || "Fastfood1";

    const response = await axios.get(
      "https://app.ewitypos.com/api/ecom-v1/orders",
      {
        params: { location },
        headers: {
          Authorization: `Bearer ${process.env.EWITY_BEARER}`,
          "X-Ewity-Platform": "web",
          Accept: "application/json"
        }
      }
    );

    res.json({
      success: true,
      location,
      data: response.data
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});
app.get("/send-by-bill-number", async (req, res) => {
  try {
    const billNumber = req.query.bill;

    if (!billNumber) {
      return res.status(400).json({
        success: false,
        error: "bill query is required. Example: ?bill=1/000007"
      });
    }

    console.log("Processing bill:", billNumber);

    // STEP 1 — Get DR3 Bill
    const dr3 = await fetchDr3Bill(billNumber);

    const publicUrl = dr3?.data?.url || dr3?.url || null;

    if (!publicUrl) {
      return res.json({
        success: false,
        error: "No public bill URL returned from Ewity"
      });
    }

    console.log("Public URL:", publicUrl);

    // STEP 2 — Build MINIMUM Shipday payload
    const shipdayPayload = {
      orderNumber: billNumber,
      customerName: "Walk-in / Ewity Order",
      customerPhoneNumber: "",
      customerAddress: process.env.DEFAULT_CUSTOMER_ADDRESS || "Address not provided",
      restaurantName: process.env.RESTAURANT_NAME || "FFGR",
      totalOrderCost: 0,
      expectedPickupTime: getTimeHHMMSS(),
      pickupAddress: process.env.FFGR_PICKUP_ADDRESS,
      orderItems: [
        {
          name: "Ewity Order",
          unitPrice: 0,
          quantity: 1,
          addOns: []
        }
      ],
      notes: `Ewity Bill: ${billNumber} | URL: ${publicUrl}`
    };

    // STEP 3 — Send to Shipday
    const shipdayResponse = await sendToShipday(shipdayPayload);

    res.json({
      success: true,
      billNumber,
      publicUrl,
      shipdayPayload,
      shipdayResponse
    });

  } catch (err) {
    console.error("send-by-bill-number error:", err.response?.data || err.message);

    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});
app.get("/", (req, res) => {
  res.json({
    status: "running",
    service: "ewity-pull-and-shipday-push",
    ewity_bearer: EWITY_BEARER ? "available" : "missing",
    shipday_api_key: SHIPDAY_API_KEY ? "available" : "missing",
  });
});

app.get("/version", (req, res) => {
  res.json({
    version: "2026-04-16-ewity-pull-and-shipday-push",
  });
});

/* ---------------------------
   EWITY PRIVATE API PULL ROUTES
---------------------------- */

app.get("/test-ewity-orders", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 5);
    const data = await fetchAsyncTasks(limit);

    res.json({
      success: true,
      endpoint: "GET https://app.ewitypos.com/api/v1/async-tasks/my?limit=N",
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
      endpoint: "POST https://app.ewitypos.com/api/v1/ebills/dr3-bill",
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
      endpoint: "POST https://app.ewitypos.com/api/v1/ebills/dr3-bill",
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
      note: "Full public bill JSON from my.ewity.com was not reliable server-to-server from Railway due to 403. Use browser-posted JSON for Shipday push.",
    });
  } catch (err) {
    console.error("pull-order-chain error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

/* ---------------------------
   SHIPDAY PUSH ROUTES
---------------------------- */

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

app.post("/debug-public-bill-json", (req, res) => {
  try {
    const publicBillJson = req.body;
    const shipdayPayload = mapPublicBillToShipday(publicBillJson);

    res.json({
      success: true,
      expectedPickupTimeValue: shipdayPayload.expectedPickupTime,
      shipdayPayload,
    });
  } catch (err) {
    console.error("debug-public-bill-json error:", err.message);
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
    console.error(
      "send-public-bill-json-to-shipday error:",
      err.response?.data || err.message
    );
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
