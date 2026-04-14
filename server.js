require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

console.log('FFGR BUILD: live-send-v2');

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
const LOYVERSE_API_BASE = 'https://api.loyverse.com';
const POLL_INTERVAL_MS = Number(process.env.LOYVERSE_POLL_INTERVAL_MS || 60000);

const processedWooOrders = new Set();
const processedReceipts = new Set();
let lastPollIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

app.get('/', (_req, res) => {
  res.send('FFGR bridge is running');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'ffgr-pos-shipday-bridge',
    build: 'live-send-v2'
  });
});

app.get('/test/shipday', async (_req, res) => {
  try {
    const payload = {
      orderNumber: `TEST-${Date.now()}`,
      customerName: 'Test Customer',
      customerPhoneNumber: process.env.SHIPDAY_DEFAULT_PHONE || '7739160',
      customerAddress: process.env.SHIPDAY_DEFAULT_ADDRESS || 'Hithadhoo',
      restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
      restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
      restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE || '+9607739160',
      orderItem: [{ name: 'Test Item', quantity: 1 }],
      totalOrderCost: 1
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
      details: err.response?.data || null
    });
  }
});

// -----------------------------
// WooCommerce webhooks
// -----------------------------
app.post('/webhooks/woocommerce/order-created', async (req, res) => {
  try {
    verifyWooWebhook(req);
    const order = req.body || {};
    const orderId = String(order.id || '');

    console.log('WC CREATED RAW:', JSON.stringify(order));

    if (!orderId) {
      return res.status(200).json({ ok: true, skipped: 'missing order id' });
    }

    const dedupeKey = `woo-${orderId}`;
    if (processedWooOrders.has(dedupeKey)) {
      console.log(`Skipping duplicate Woo created order ${orderId}`);
      return res.status(200).json({ ok: true, skipped: 'duplicate' });
    }

    const payload = mapWooOrderToShipday(order);
    console.log('WC CREATED -> SHIPDAY:', JSON.stringify(payload));

    const result = await sendToShipday(payload);
    processedWooOrders.add(dedupeKey);

    console.log('WC CREATED SENT:', result);
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('WC CREATED ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});

app.post('/webhooks/woocommerce/order-updated', async (req, res) => {
  try {
    verifyWooWebhook(req);
    const order = req.body || {};
    const orderId = String(order.id || '');

    console.log('WC UPDATED RAW:', JSON.stringify(order));

    if (!orderId) {
      return res.status(200).json({ ok: true, skipped: 'missing order id' });
    }

    const dedupeKey = `woo-${orderId}`;
    if (processedWooOrders.has(dedupeKey)) {
      console.log(`Skipping duplicate Woo updated order ${orderId}`);
      return res.status(200).json({ ok: true, skipped: 'duplicate' });
    }

    const payload = mapWooOrderToShipday(order);
    console.log('WC UPDATED -> SHIPDAY:', JSON.stringify(payload));

    const result = await sendToShipday(payload);
    processedWooOrders.add(dedupeKey);

    console.log('WC UPDATED SENT:', result);
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('WC UPDATED ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});

function verifyWooWebhook(req) {
  const secret = process.env.WC_WEBHOOK_SECRET;
  if (!secret) {
    console.log('WC_WEBHOOK_SECRET missing, skipping verification');
    return true;
  }

  const signature = req.get('x-wc-webhook-signature');
  if (!signature) {
    console.log('No WooCommerce signature header, skipping verification');
    return true;
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');

  if (digest !== signature) {
    throw new Error('Invalid WooCommerce webhook signature');
  }

  return true;
}

function mapWooOrderToShipday(order) {
  const billing = order.billing || {};
  const shipping = order.shipping || {};

  const address =
    [
      shipping.address_1,
      shipping.address_2,
      shipping.city,
      shipping.state,
      shipping.postcode,
      shipping.country
    ]
      .filter(Boolean)
      .join(', ') ||
    process.env.SHIPDAY_DEFAULT_ADDRESS ||
    'Hithadhoo';

  return {
    orderNumber: String(order.id || Date.now()),
    customerName:
      [billing.first_name, billing.last_name].filter(Boolean).join(' ') ||
      process.env.SHIPDAY_DEFAULT_CUSTOMER_NAME ||
      'Customer',
    customerPhoneNumber:
      billing.phone ||
      process.env.SHIPDAY_DEFAULT_PHONE ||
      '7739160',
    customerAddress: address,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
    restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
    restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE || '+9607739160',
    orderItem: (order.line_items || []).map((item) => ({
      name: item.name || 'Item',
      quantity: Number(item.quantity || 1)
    })),
    totalOrderCost: parseFloat(order.total || 0) || 1
  };
}

// -----------------------------
// Loyverse OAuth
// -----------------------------
app.get('/auth/loyverse', (_req, res) => {
  const clientId = process.env.LOYVERSE_CLIENT_ID;
  const redirectUri = process.env.LOYVERSE_REDIRECT_URI;
  const state = process.env.LOYVERSE_OAUTH_STATE || 'ffgr123';
  const scope = encodeURIComponent(
    process.env.LOYVERSE_SCOPE || 'RECEIPTS_READ STORES_READ MERCHANT_READ'
  );

  if (!clientId || !redirectUri) {
    return res.status(500).send('LOYVERSE_CLIENT_ID or LOYVERSE_REDIRECT_URI not configured');
  }

  const authUrl =
    `${LOYVERSE_API_BASE}/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${scope}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ ok: false, error: 'Missing code' });
    }

    if (process.env.LOYVERSE_OAUTH_STATE && state !== process.env.LOYVERSE_OAUTH_STATE) {
      return res.status(400).json({ ok: false, error: 'Invalid state' });
    }

    const tokenRes = await axios.post(
      `${LOYVERSE_API_BASE}/oauth/token`,
      new URLSearchParams({
        client_id: process.env.LOYVERSE_CLIENT_ID,
        client_secret: process.env.LOYVERSE_CLIENT_SECRET,
        redirect_uri: process.env.LOYVERSE_REDIRECT_URI,
        code: String(code),
        grant_type: 'authorization_code'
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        timeout: 20000
      }
    );

    console.log('Loyverse OAuth token response:', tokenRes.data);

    return res.status(200).json({
      ok: true,
      message: 'Copy access_token into LOYVERSE_API_KEY and refresh_token into LOYVERSE_REFRESH_TOKEN',
      token: tokenRes.data
    });
  } catch (err) {
    console.error('Loyverse OAuth callback error:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});

app.post('/auth/loyverse/refresh', async (_req, res) => {
  try {
    if (!process.env.LOYVERSE_REFRESH_TOKEN) {
      return res.status(400).json({ ok: false, error: 'LOYVERSE_REFRESH_TOKEN not configured' });
    }

    const tokenRes = await axios.post(
      `${LOYVERSE_API_BASE}/oauth/token`,
      new URLSearchParams({
        client_id: process.env.LOYVERSE_CLIENT_ID,
        client_secret: process.env.LOYVERSE_CLIENT_SECRET,
        refresh_token: process.env.LOYVERSE_REFRESH_TOKEN,
        grant_type: 'refresh_token'
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        timeout: 20000
      }
    );

    console.log('Loyverse refresh token response:', tokenRes.data);

    return res.status(200).json({
      ok: true,
      message: 'Update LOYVERSE_API_KEY and LOYVERSE_REFRESH_TOKEN in Railway with these new values',
      token: tokenRes.data
    });
  } catch (err) {
    console.error('Loyverse token refresh error:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});

// -----------------------------
// Loyverse debug + polling
// -----------------------------
app.get('/debug/loyverse', async (_req, res) => {
  try {
    const data = await fetchLoyverseReceipts({ debug: true });
    return res.json({ ok: true, ...data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});

async function fetchLoyverseReceipts({ debug = false } = {}) {
  if (!process.env.LOYVERSE_API_KEY) {
    throw new Error('LOYVERSE_API_KEY not configured');
  }

  const nowIso = new Date().toISOString();

  const response = await axios.get(`${LOYVERSE_API_BASE}/v1.0/receipts`, {
    headers: {
      Authorization: `Bearer ${process.env.LOYVERSE_API_KEY}`,
      Accept: 'application/json'
    },
    params: {
      updated_at_min: lastPollIso,
      limit: 100
    },
    timeout: 20000
  });

  const receipts = response.data?.receipts || [];
  const cursor = response.data?.cursor || null;

  if (!debug) {
    console.log(`Loyverse returned ${receipts.length} receipts since ${lastPollIso}`);
  }

  const summary = receipts.map((r) => ({
    id: r.id,
    receipt_number: r.receipt_number,
    note: r.note || null,
    comment: r.comment || null,
    total_money: r.total_money ?? null,
    customer_name: r.customer?.name || r.customer_name || null,
    customer_phone: r.customer?.phone_number || r.customer?.phone || r.phone_number || null,
    items_count: Array.isArray(r.line_items) ? r.line_items.length : 0
  }));

  if (!debug) {
    for (const s of summary.slice(0, 10)) {
      console.log(
        `Receipt ${s.receipt_number || s.id} | note=${JSON.stringify(s.note || s.comment || '')} | phone=${JSON.stringify(s.customer_phone || '')}`
      );
    }
  }

  lastPollIso = nowIso;
  return { count: receipts.length, cursor, summary, receipts };
}

async function pollLoyverseAndSend() {
  try {
    const { receipts } = await fetchLoyverseReceipts();

    for (const receipt of receipts) {
      if (!receipt?.id) continue;

      if (processedReceipts.has(receipt.id)) {
        console.log(`Skipping duplicate receipt ${receipt.id}`);
        continue;
      }

      console.log('PROCESSING RECEIPT:', receipt.receipt_number);

      const payload = {
        orderNumber: String(receipt.receipt_number || receipt.id),
        customerName:
          receipt.customer?.name || 'Customer',
        customerPhoneNumber:
          receipt.customer?.phone_number ||
          receipt.phone_number ||
          process.env.SHIPDAY_DEFAULT_PHONE ||
          '7739160',
        customerAddress:
          receipt.note ||
          process.env.SHIPDAY_DEFAULT_ADDRESS ||
          'Hithadhoo',
        restaurantName: process.env.SHIPDAY_RESTAURANT_NAME,
        restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS,
        restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE,
        orderItem: (receipt.line_items || []).map(item => ({
          name: item.item_name || 'Item',
          quantity: Number(item.quantity || 1)
        })),
        totalOrderCost: parseFloat(receipt.total_money || 0) || 1
      };

      console.log('LOYVERSE -> SHIPDAY:', JSON.stringify(payload));

      try {
        const result = await sendToShipday(payload);
        processedReceipts.add(receipt.id);
        console.log('LOYVERSE SENT:', result);
      } catch (err) {
        console.error('LOYVERSE ERROR:', err.response?.data || err.message);
      }
    }

    // 🔥 IMPORTANT: update AFTER processing
    if (receipts.length > 0) {
      lastPollIso = new Date().toISOString();
    }

  } catch (err) {
    console.error('Loyverse poll error:', err.response?.data || err.message);
  }
}
// -----------------------------
// Shipday
// -----------------------------
async function sendToShipday(payload) {
  const { data } = await axios.post(`${SHIPDAY_BASE}/orders`, payload, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${process.env.SHIPDAY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  return data;
}

// -----------------------------
// Start + scheduler
// -----------------------------
app.listen(PORT, () => {
  console.log(`FFGR bridge running on port ${PORT}`);
});

function startPolling() {
  console.log('Starting Loyverse polling...');

  setInterval(async () => {
    try {
      await pollLoyverseAndSend();
    } catch (err) {
      console.error('Polling loop error:', err);
    }
  }, POLL_INTERVAL_MS);
}

setTimeout(startPolling, 10000);
