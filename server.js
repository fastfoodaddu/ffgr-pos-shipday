import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const EWITY_BASE = "https://app.ewitypos.com/api/v1";
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

function parseMoney(text) {
  if (text == null) return 0;
  const cleaned = String(text).replace(/[^0-9.-]/g, "");
  return Number(cleaned || 0);
}

function extractPublicBillId(dr3Response) {
  const url = dr3Response?.data?.url || dr3Response?.url || "";
  if (!url) return null;

  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "b" && parts[1]) return parts[1];
    return null;
  } catch {
    return null;
  }
}

async function fetchEwityDr3Bill(clientBillId) {
  const response = await axios.post(
    `${EWITY_BASE}/ebills/dr3-bill`,
    { client_bill_id: clientBillId },
    { headers: ewityHeaders(), timeout: 20000 }
  );
  return response.data;
}

async function fetchEwityPublicBillJson(publicId) {
  const publicPageUrl = `https://my.ewity.com/b/${encodeURIComponent(publicId)}`;

  const response = await axios.get(publicPageUrl, {
    params: {
      _data: "routes/b/$id",
    },
    headers: {
      Accept: "application/json",
      Referer: publicPageUrl,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      "X-Requested-With": "XMLHttpRequest",
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Public bill JSON failed with status ${response.status}: ${JSON.stringify(response.data)}`
    );
  }

  return response.data;
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

  return {
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
    expectedPickupTime: new Date().toISOString(),
    pickupAddress:
      process.env.FFGR_PICKUP_ADDRESS ||
      "Fast Food Gourmet Restaurant, Hithadhoo, Addu City",
    orderItems,
    notes: [
      `Ewity Public Bill ID: ${publicBillJson?.id || ""}`,
      `Ewity Client Bill ID: ${bill?.client_bill_id || ""}`,
      `Payment Status: ${headerMap["Payment Status"] || bill?.payment_status || ""}`,
      `Date: ${headerMap["Date"] || ""}`,
    ]
      .filter(Boolean)
      .join(" | "),
  };
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
    service: "ewity-shipday-bridge",
    ewity_bearer: EWITY_BEARER ? "available" : "missing",
    shipday_api_key: SHIPDAY_API_KEY ? "available" : "missing",
  });
});

app.get("/test-ewity-public-bill", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const data = await fetchEwityPublicBillJson(id);
    res.json(data);
  } catch (err) {
    console.error("test-ewity-public-bill error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get("/test-ewity-bill-from-client", async (req, res) => {
  try {
    const client_bill_id = req.query.client_bill_id;
    if (!client_bill_id) {
      return res.status(400).json({ error: "client_bill_id is required" });
    }

    const dr3 = await fetchEwityDr3Bill(client_bill_id);
    const publicId = extractPublicBillId(dr3);

    if (!publicId) {
      return res.status(500).json({
        success: false,
        error: "Could not extract public bill ID from dr3 response",
        dr3,
      });
    }

    const publicBill = await fetchEwityPublicBillJson(publicId);

    res.json({
      success: true,
      client_bill_id,
      publicId,
      dr3,
      publicBill,
    });
  } catch (err) {
    console.error("test-ewity-bill-from-client error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get("/test-shipday-payload", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const publicBill = await fetchEwityPublicBillJson(id);
    const shipdayPayload = mapPublicBillToShipday(publicBill);

    res.json({
      success: true,
      publicBill,
      shipdayPayload,
    });
  } catch (err) {
    console.error("test-shipday-payload error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

app.get("/send-public-bill-to-shipday", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const publicBill = await fetchEwityPublicBillJson(id);
    const shipdayPayload = mapPublicBillToShipday(publicBill);
    const shipdayResponse = await sendToShipday(shipdayPayload);

    res.json({
      success: true,
      publicBill,
      shipdayPayload,
      shipdayResponse,
    });
  } catch (err) {
    console.error("send-public-bill-to-shipday error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
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
