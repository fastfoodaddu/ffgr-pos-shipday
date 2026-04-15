import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

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

function getClientBillIdFromTask(task) {
  return (
    task?.client_bill_id ||
    task?.bill?.id ||
    task?.data?.client_bill_id ||
    task?.meta?.client_bill_id ||
    null
  );
}

function mapEwityBillToShipdayPayload(billResponse) {
  const bill = billResponse?.bill || billResponse?.data?.bill || billResponse?.data || billResponse;

  const customer = bill?.customer || {};
  const table = bill?.table || {};
  const lines = Array.isArray(bill?.bill_lines) ? bill.bill_lines : [];

  const customerName =
    customer?.name ||
    customer?.full_name ||
    customer?.display_name ||
    "FFGR Customer";

  const customerPhone =
    customer?.mobile ||
    customer?.phone ||
    customer?.contact ||
    customer?.telephone ||
    "";

  const customerAddress =
    customer?.address ||
    customer?.street ||
    customer?.full_address ||
    table?.name_text ||
    "Address not provided";

  const orderNumber =
    bill?.invoice_number ||
    bill?.temp_number ||
    bill?.number ||
    bill?.id;

  const totalOrderCost =
    Number(bill?.total ?? 0);

  const orderItems = lines.map((line) => ({
    name:
      line?.name ||
      line?.product_name ||
      line?.item_name ||
      "Item",
    unitPrice:
      Number(line?.sales_price ?? line?.price ?? line?.unit_price ?? 0),
    quantity:
      Number(line?.quantity ?? line?.qty ?? 1),
    addOns: [],
  }));

  return {
    orderNumber: String(orderNumber || ""),
    customerName: String(customerName || ""),
    customerAddress: String(customerAddress || ""),
    customerPhoneNumber: String(customerPhone || ""),
    restaurantName: "FFGR",
    totalOrderCost,
    expectedPickupTime: new Date().toISOString(),
    pickupAddress: process.env.FFGR_PICKUP_ADDRESS || "Fast Food Gourmet Restaurant, Hithadhoo, Addu City",
    pickupLatitude: process.env.FFGR_PICKUP_LAT ? Number(process.env.FFGR_PICKUP_LAT) : undefined,
    pickupLongitude: process.env.FFGR_PICKUP_LNG ? Number(process.env.FFGR_PICKUP_LNG) : undefined,
    orderItems,
    notes: `Ewity Bill ID: ${bill?.id || ""}`,
  };
}

async function fetchEwityTasks(limit = 5) {
  const response = await axios.get(
    `${EWITY_BASE}/async-tasks/my?limit=${encodeURIComponent(limit)}`,
    {
      headers: ewityHeaders(),
    }
  );
  return response.data;
}

async function fetchEwityBill(clientBillId) {
  const response = await axios.post(
    `${EWITY_BASE}/ebills/dr3-bill`,
    { client_bill_id: clientBillId },
    { headers: ewityHeaders() }
  );
  return response.data;
}

async function sendToShipday(shipdayPayload) {
  if (!SHIPDAY_API_KEY) {
    throw new Error("SHIPDAY_API_KEY is missing");
  }

  const response = await axios.post(
    "https://api.shipday.com/orders",
    shipdayPayload,
    {
      headers: shipdayHeaders(),
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

app.get("/test-ewity-orders", async (req, res) => {
  try {
    const data = await fetchEwityTasks(5);
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.post("/test-ewity-bill", async (req, res) => {
  try {
    const { client_bill_id } = req.body;

    if (!client_bill_id) {
      return res.status(400).json({ error: "client_bill_id is required" });
    }

    const data = await fetchEwityBill(client_bill_id);
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.get("/sync-ewity", async (req, res) => {
  try {
    const tasksData = await fetchEwityTasks(5);
    const tasks = Array.isArray(tasksData?.data) ? tasksData.data : [];

    const results = [];

    for (const task of tasks) {
      const clientBillId = getClientBillIdFromTask(task);

      if (!clientBillId) {
        results.push({
          task,
          skipped: true,
          reason: "client_bill_id not found in task",
        });
        continue;
      }

      const billData = await fetchEwityBill(clientBillId);

      results.push({
        client_bill_id: clientBillId,
        bill: billData,
      });
    }

    res.json({
      success: true,
      count: results.length,
      results,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.post("/sync-one-to-shipday", async (req, res) => {
  try {
    const { client_bill_id } = req.body;

    if (!client_bill_id) {
      return res.status(400).json({ error: "client_bill_id is required" });
    }

    const billData = await fetchEwityBill(client_bill_id);
    const shipdayPayload = mapEwityBillToShipdayPayload(billData);
    const shipdayResponse = await sendToShipday(shipdayPayload);

    res.json({
      success: true,
      client_bill_id,
      billData,
      shipdayPayload,
      shipdayResponse,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.get("/sync-all-to-shipday", async (req, res) => {
  try {
    const tasksData = await fetchEwityTasks(5);
    const tasks = Array.isArray(tasksData?.data) ? tasksData.data : [];

    const results = [];

    for (const task of tasks) {
      const clientBillId = getClientBillIdFromTask(task);

      if (!clientBillId) {
        results.push({
          skipped: true,
          reason: "client_bill_id not found in task",
          task,
        });
        continue;
      }

      const billData = await fetchEwityBill(clientBillId);
      const shipdayPayload = mapEwityBillToShipdayPayload(billData);
      const shipdayResponse = await sendToShipday(shipdayPayload);

      results.push({
        client_bill_id: clientBillId,
        shipdayPayload,
        shipdayResponse,
      });
    }

    res.json({
      success: true,
      count: results.length,
      results,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
