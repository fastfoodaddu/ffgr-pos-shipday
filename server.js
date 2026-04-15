require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

console.log('FFGR BUILD: ewity-webhook-shipday-v1');

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

const app = express();
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, _res, buf) {
  if (buf && buf.length) req.rawBody = buf;
}

const PORT = Number(process.env.PORT || 8080);
const SHIPDAY_BASE = 'https://api.shipday.com';
const EWITY_RETRY_INTERVAL_MS = Number(
  process.env.EWITY_RETRY_INTERVAL_MS || 900000
); // 15 min

const sentKeys = new Set();
const failedQueue = new Map();

app.get('/', (_req, res) => {
  res.send('FFGR Ewity bridge is running');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    build: 'ewity-webhook-shipday-v1',
    retryEveryMs: EWITY_RETRY_INTERVAL_MS,
  });
});

app.get('/test/shipday', async (_req, res) => {
  try {
    const payload = {
      orderNumber: `TEST-${Date.now()}`,
      customerName: `${process.env.SHIPDAY_DEFAULT_CUSTOMER_NAME || 'Test Customer'} - ${process.env.SHIPDAY_DEFAULT_PHONE || '7739160'}`,
      customerPhoneNumber: process.env.SHIPDAY_DEFAULT_PHONE || '7739160',
      customerAddress: formatAddressLine(
        process.env.SHIPDAY_DEFAULT_ADDRESS || 'Hithadhoo',
        process.env.SHIPDAY_DEFAULT_NOTE || 'Leave at door'
      ),
      deliveryInstruction: process.env.SHIPDAY_DEFAULT_NOTE || 'Leave at door',
      restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
      restaurantAddress:
        process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
      restaurantPhoneNumber:
        process.env.SHIPDAY_RESTAURANT_PHONE || '+9607739160',
      orderItem: [{ name: 'Test Item', quantity: 1 }],
      totalOrderCost: 1,
      paymentMethod: 'cash',
    };

    console.log('TEST Shipday payload:', JSON.stringify(payload));
    const result = await sendToShipday(payload);
    console.log('TEST Shipday success:', result);

    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('TEST Shipday failed:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// optional browser check
app.get('/webhooks/ewity/order', (_req, res) => {
  res.status(200).send('Ewity webhook endpoint is live. Use POST.');
});

// main Ewity webhook
app.post('/webhooks/ewity/order', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || '';

    if (
      process.env.EWITY_WEBHOOK_AUTH &&
      authHeader !== process.env.EWITY_WEBHOOK_AUTH
    ) {
      console.log('Unauthorized Ewity webhook');
      return res.status(401).send('Unauthorized');
    }

    console.log('EWITY WEBHOOK RAW:', JSON.stringify(req.body));

    const orderLike = extractEwityOrder(req.body);
    const payload = mapEwityToShipday(orderLike);
    const key = `ewity-${payload.orderNumber}`;

    console.log('EWITY -> SHIPDAY:', JSON.stringify(payload));
    await safeDispatchToShipday(key, payload, 'ewity-webhook');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('EWITY WEBHOOK ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// -----------------------------
// helpers
// -----------------------------
function extractEwityOrder(body) {
  if (!body) return {};

  // flexible extraction to handle different Ewity payload shapes
  if (body.order && typeof body.order === 'object') return body.order;
  if (body.bill && typeof body.bill === 'object') return body.bill;
  if (body.data && typeof body.data === 'object') {
    if (body.data.order && typeof body.data.order === 'object') return body.data.order;
    if (body.data.bill && typeof body.data.bill === 'object') return body.data.bill;
    return body.data;
  }

  return body;
}

function parseAddressAndNotes(rawAddress, rawNotes) {
  const address = String(
    rawAddress || process.env.SHIPDAY_DEFAULT_ADDRESS || 'Hithadhoo'
  ).trim();

  const notes = String(rawNotes || process.env.SHIPDAY_DEFAULT_NOTE || '').trim();

  return {
    address,
    notes,
  };
}

function formatAddressLine(address, notes) {
  const a = String(address || '').trim();
  const n = String(notes || '').trim();
  return a && n ? `${a} - ${n}` : a || n || 'Hithadhoo';
}

function mapEwityToShipday(order) {
  // try multiple common field names
  const orderNumber =
    order.orderNumber ||
    order.order_number ||
    order.billNumber ||
    order.bill_number ||
    order.invoiceNumber ||
    order.invoice_number ||
    order.id ||
    order._id ||
    Date.now();

  const customerNameRaw =
    order.customerName ||
    order.customer_name ||
    order.customer?.name ||
    order.client?.name ||
    process.env.SHIPDAY_DEFAULT_CUSTOMER_NAME ||
    'Customer';

  const customerPhone =
    order.customerPhoneNumber ||
    order.customer_phone ||
    order.phone ||
    order.phoneNumber ||
    order.customer?.phone ||
    order.customer?.phone_number ||
    order.client?.phone ||
    process.env.SHIPDAY_DEFAULT_PHONE ||
    '7739160';

  const rawAddress =
    order.customerAddress ||
    order.customer_address ||
    order.address ||
    order.deliveryAddress ||
    order.delivery_address ||
    order.customer?.address ||
    order.client?.address ||
    process.env.SHIPDAY_DEFAULT_ADDRESS ||
    'Hithadhoo';

  const rawNotes =
    order.ticketNotes ||
    order.ticket_notes ||
    order.notes ||
    order.note ||
    order.comments ||
    order.comment ||
    process.env.SHIPDAY_DEFAULT_NOTE ||
    '';

  const parsed = parseAddressAndNotes(rawAddress, rawNotes);

  let itemsSource =
    order.items ||
    order.line_items ||
    order.products ||
    order.details ||
    [];

  if (!Array.isArray(itemsSource)) {
    itemsSource = [];
  }

  let orderItem = itemsSource.map((item) => ({
    name:
      item.name ||
      item.item_name ||
      item.product_name ||
      item.title ||
      'Item',
    quantity: Number(
      item.quantity ||
      item.qty ||
      item.count ||
      1
    ),
  }));

  if (!orderItem.length) {
    orderItem = [{ name: 'Order', quantity: 1 }];
  }

  const totalOrderCost = parseFloat(
    order.total ||
    order.total_amount ||
    order.grand_total ||
    order.amount ||
    0
  ) || 1;

  return {
    orderNumber: String(orderNumber),
    customerName: `${customerNameRaw} - ${customerPhone}`,
    customerPhoneNumber: String(customerPhone),
    customerAddress: formatAddressLine(parsed.address, parsed.notes),
    deliveryInstruction: parsed.notes,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
    restaurantAddress:
      process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
    restaurantPhoneNumber:
      process.env.SHIPDAY_RESTAURANT_PHONE || '+9607739160',
    orderItem,
    totalOrderCost,
    paymentMethod: 'cash',
  };
}

// -----------------------------
// Shipday dispatch + retry
// -----------------------------
async function safeDispatchToShipday(orderKey, payload, source) {
  if (sentKeys.has(orderKey)) {
    console.log(`Skipping already sent order ${orderKey}`);
    return;
  }

  try {
    const result = await sendToShipday(payload);
    sentKeys.add(orderKey);
    failedQueue.delete(orderKey);
    console.log(`${source.toUpperCase()} SENT:`, result);
    return result;
  } catch (err) {
    console.error(
      `${source.toUpperCase()} ERROR:`,
      err.response?.data || err.message
    );

    failedQueue.set(orderKey, {
      payload,
      source,
      failedAt: new Date().toISOString(),
      attempts: (failedQueue.get(orderKey)?.attempts || 0) + 1,
    });

    throw err;
  }
}

async function retryFailedOrders() {
  if (!failedQueue.size) return;

  console.log(`Retrying ${failedQueue.size} failed order(s)...`);

  for (const [orderKey, entry] of failedQueue.entries()) {
    try {
      const result = await sendToShipday(entry.payload);
      sentKeys.add(orderKey);
      failedQueue.delete(orderKey);
      console.log(`RETRY SUCCESS ${orderKey}:`, result);
    } catch (err) {
      console.error(
        `RETRY FAILED ${orderKey}:`,
        err.response?.data || err.message
      );
      entry.attempts += 1;
      entry.lastError = err.response?.data || err.message;
      failedQueue.set(orderKey, entry);
    }
  }
}

async function sendToShipday(payload) {
  const { data } = await axios.post(`${SHIPDAY_BASE}/orders`, payload, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${process.env.SHIPDAY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });

  return data;
}

// -----------------------------
// Start + scheduler
// -----------------------------
app.listen(PORT, () => {
  console.log(`FFGR bridge running on port ${PORT}`);
});

function startJobs() {
  console.log(
    `Retry failed Ewity orders every ${EWITY_RETRY_INTERVAL_MS / 60000} minute(s)`
  );

  setInterval(async () => {
    try {
      await retryFailedOrders();
    } catch (err) {
      console.error('Retry loop error:', err);
    }
  }, EWITY_RETRY_INTERVAL_MS);
}

setTimeout(startJobs, 10000);
