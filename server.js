require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

console.log('FFGR BUILD: loyverse-webhook-reconcile-v2');

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
const RECONCILE_INTERVAL_MS = Number(
  process.env.LOYVERSE_RECONCILE_INTERVAL_MS || 900000
);

// in-memory tracking
const sentOrderKeys = new Set();
const failedQueue = new Map();
let lastReconcileIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

app.get('/', (_req, res) => {
  res.send('FFGR bridge is running');
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    build: 'loyverse-webhook-reconcile-v2',
    reconcileEveryMs: RECONCILE_INTERVAL_MS,
  });
});

app.get('/test/shipday', async (_req, res) => {
  try {
    const payload = {
      orderNumber: `TEST-${Date.now()}`,
      customerName: `${process.env.SHIPDAY_DEFAULT_CUSTOMER_NAME || 'Test Customer'} - ${process.env.SHIPDAY_DEFAULT_PHONE || '7739160'}`,
      customerPhoneNumber: process.env.SHIPDAY_DEFAULT_PHONE || '7739160',
      customerAddress: `${process.env.SHIPDAY_DEFAULT_ADDRESS || 'Hithadhoo'} - ${process.env.SHIPDAY_DEFAULT_NOTE || 'Leave at door'}`,
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

// -----------------------------
// WooCommerce
// -----------------------------
app.post('/webhooks/woocommerce/order-created', async (req, res) => {
  try {
    verifyWooWebhook(req);

    const order = req.body || {};
    const payload = mapWooOrderToShipday(order);
    const key = `woo-created-${payload.orderNumber}`;

    console.log('WC CREATED -> SHIPDAY:', JSON.stringify(payload));
    await safeDispatchToShipday(key, payload, 'woocommerce-created');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('WC CREATED ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

app.post('/webhooks/woocommerce/order-updated', async (req, res) => {
  try {
    verifyWooWebhook(req);

    const order = req.body || {};
    const payload = mapWooOrderToShipday(order);
    const key = `woo-updated-${payload.orderNumber}-${order.status || 'unknown'}`;

    console.log('WC UPDATED -> SHIPDAY:', JSON.stringify(payload));
    await safeDispatchToShipday(key, payload, 'woocommerce-updated');

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('WC UPDATED ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
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

  const baseAddress =
    [
      shipping.address_1,
      shipping.address_2,
      shipping.city,
      shipping.state,
      shipping.postcode,
      shipping.country,
    ]
      .filter(Boolean)
      .join(', ') ||
    process.env.SHIPDAY_DEFAULT_ADDRESS ||
    'Hithadhoo';

  const note = order.customer_note || process.env.SHIPDAY_DEFAULT_NOTE || '';
  const customerName =
    [billing.first_name, billing.last_name].filter(Boolean).join(' ') ||
    process.env.SHIPDAY_DEFAULT_CUSTOMER_NAME ||
    'Customer';
  const customerPhone =
    billing.phone || process.env.SHIPDAY_DEFAULT_PHONE || '7739160';

  return {
    orderNumber: String(order.id || Date.now()),
    customerName: `${customerName} - ${customerPhone}`,
    customerPhoneNumber: customerPhone,
    customerAddress: note ? `${baseAddress} - ${note}` : baseAddress,
    deliveryInstruction: note,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
    restaurantAddress:
      process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
    restaurantPhoneNumber:
      process.env.SHIPDAY_RESTAURANT_PHONE || '+9607739160',
    orderItem: (order.line_items || []).map((item) => ({
      name: item.name || 'Item',
      quantity: Number(item.quantity || 1),
    })),
    totalOrderCost: parseFloat(order.total || 0) || 1,
    paymentMethod: 'cash',
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
    return res
      .status(500)
      .send('LOYVERSE_CLIENT_ID or LOYVERSE_REDIRECT_URI not configured');
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

    if (
      process.env.LOYVERSE_OAUTH_STATE &&
      state !== process.env.LOYVERSE_OAUTH_STATE
    ) {
      return res.status(400).json({ ok: false, error: 'Invalid state' });
    }
app.get('/webhooks/loyverse/receipt', (_req, res) => {
  res.status(200).send('Loyverse webhook endpoint is live. Use POST, not GET.');
});

app.post('/webhooks/loyverse/receipt', async (req, res) => {
  try {
    console.log('LOYVERSE WEBHOOK RAW:', JSON.stringify(req.body));

    const receipts = extractLoyverseReceiptsFromWebhook(req.body);

    if (!receipts.length) {
      return res.status(200).json({ ok: true, skipped: 'no receipts found' });
    }

    for (const receipt of receipts) {
      const payload = mapLoyverseReceiptToShipday(receipt);
      const key = `loyverse-webhook-${payload.orderNumber}`;

      console.log('LOYVERSE WEBHOOK -> SHIPDAY:', JSON.stringify(payload));
      await safeDispatchToShipday(key, payload, 'loyverse-webhook');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('LOYVERSE WEBHOOK ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});
    const tokenRes = await axios.post(
      `${LOYVERSE_API_BASE}/oauth/token`,
      new URLSearchParams({
        client_id: process.env.LOYVERSE_CLIENT_ID,
        client_secret: process.env.LOYVERSE_CLIENT_SECRET,
        redirect_uri: process.env.LOYVERSE_REDIRECT_URI,
        code: String(code),
        grant_type: 'authorization_code',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        timeout: 20000,
      }
    );

    console.log('Loyverse OAuth token response:', tokenRes.data);

    return res.status(200).json({
      ok: true,
      message:
        'Copy access_token into LOYVERSE_API_KEY and refresh_token into LOYVERSE_REFRESH_TOKEN',
      token: tokenRes.data,
    });
  } catch (err) {
    console.error(
      'Loyverse OAuth callback error:',
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

app.post('/auth/loyverse/refresh', async (_req, res) => {
  try {
    if (!process.env.LOYVERSE_REFRESH_TOKEN) {
      return res
        .status(400)
        .json({ ok: false, error: 'LOYVERSE_REFRESH_TOKEN not configured' });
    }

    const tokenRes = await axios.post(
      `${LOYVERSE_API_BASE}/oauth/token`,
      new URLSearchParams({
        client_id: process.env.LOYVERSE_CLIENT_ID,
        client_secret: process.env.LOYVERSE_CLIENT_SECRET,
        refresh_token: process.env.LOYVERSE_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        timeout: 20000,
      }
    );

    console.log('Loyverse refresh token response:', tokenRes.data);

    return res.status(200).json({
      ok: true,
      message:
        'Update LOYVERSE_API_KEY and LOYVERSE_REFRESH_TOKEN in Railway with these new values',
      token: tokenRes.data,
    });
  } catch (err) {
    console.error(
      'Loyverse token refresh error:',
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// -----------------------------
// Loyverse direct webhook
// -----------------------------
app.post('/webhooks/loyverse/receipt', async (req, res) => {
  try {
    console.log('LOYVERSE WEBHOOK RAW:', JSON.stringify(req.body));

    const receipts = extractLoyverseReceiptsFromWebhook(req.body);

    if (!receipts.length) {
      return res.status(200).json({ ok: true, skipped: 'no receipts found' });
    }

    for (const receipt of receipts) {
      const payload = mapLoyverseReceiptToShipday(receipt);
      const key = `loyverse-webhook-${payload.orderNumber}`;

      console.log('LOYVERSE WEBHOOK -> SHIPDAY:', JSON.stringify(payload));
      await safeDispatchToShipday(key, payload, 'loyverse-webhook');
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('LOYVERSE WEBHOOK ERROR:', err.response?.data || err.message);
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

// -----------------------------
// Loyverse reconcile + debug
// -----------------------------
app.get('/debug/loyverse', async (_req, res) => {
  try {
    const data = await fetchLoyverseReceipts({ debug: true });
    return res.json({ ok: true, ...data });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null,
    });
  }
});

async function fetchLoyverseReceipts({ debug = false } = {}) {
  if (!process.env.LOYVERSE_API_KEY) {
    throw new Error('LOYVERSE_API_KEY not configured');
  }

  const response = await axios.get(`${LOYVERSE_API_BASE}/v1.0/receipts`, {
    headers: {
      Authorization: `Bearer ${process.env.LOYVERSE_API_KEY}`,
      Accept: 'application/json',
    },
    params: {
      updated_at_min: lastReconcileIso,
      limit: 100,
    },
    timeout: 20000,
  });

  const receipts = response.data?.receipts || [];
  const cursor = response.data?.cursor || null;

  if (!debug) {
    console.log(
      `Loyverse reconcile fetched ${receipts.length} receipts since ${lastReconcileIso}`
    );
  }

  return { count: receipts.length, cursor, receipts };
}

function extractLoyverseReceiptsFromWebhook(body) {
  if (!body) return [];
  if (Array.isArray(body.receipts)) return body.receipts;
  if (body.receipt && typeof body.receipt === 'object') return [body.receipt];
  if (body.object && typeof body.object === 'object') return [body.object];
  if (body.data?.receipt && typeof body.data.receipt === 'object') {
    return [body.data.receipt];
  }
  if (body.data && typeof body.data === 'object' && body.data.receipt_number) {
    return [body.data];
  }
  if (body.receipt_number) return [body];
  return [];
}

function getReceiptId(receipt) {
  return receipt.id || receipt.receipt_id || receipt.receipt_number || null;
}

function parseAddressAndNotes(rawText) {
  const clean = String(rawText || '').trim();

  if (!clean) {
    return {
      address: process.env.SHIPDAY_DEFAULT_ADDRESS || 'Hithadhoo',
      notes: process.env.SHIPDAY_DEFAULT_NOTE || '',
    };
  }

  const parts = clean.split('-').map((x) => x.trim()).filter(Boolean);

  if (parts.length >= 2) {
    return {
      address: parts[0],
      notes: parts.slice(1).join(' - '),
    };
  }

  return {
    address: clean,
    notes: process.env.SHIPDAY_DEFAULT_NOTE || '',
  };
}

function mapLoyverseReceiptToShipday(receipt) {
  const customerNameRaw =
    receipt.customer?.name ||
    receipt.customer_name ||
    process.env.SHIPDAY_DEFAULT_CUSTOMER_NAME ||
    'Customer';

  const customerPhone =
    receipt.customer?.phone_number ||
    receipt.customer?.phone ||
    receipt.phone_number ||
    process.env.SHIPDAY_DEFAULT_PHONE ||
    '7739160';

  const noteText =
    receipt.note ||
    receipt.comment ||
    receipt.customer?.address ||
    receipt.customer_address ||
    '';

  const parsed = parseAddressAndNotes(noteText);

  let items = (receipt.line_items || []).map((item) => ({
    name: item.item_name || item.name || item.item?.item_name || 'Item',
    quantity: Number(item.quantity || 1),
  }));

  if (!items.length) {
    items = [{ name: 'Order', quantity: 1 }];
  }

  return {
    orderNumber: String(receipt.receipt_number || getReceiptId(receipt) || Date.now()),
    customerName: `${customerNameRaw} - ${customerPhone}`,
    customerPhoneNumber: customerPhone,
    customerAddress: parsed.notes
      ? `${parsed.address} - ${parsed.notes}`
      : parsed.address,
    deliveryInstruction: parsed.notes,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
    restaurantAddress:
      process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
    restaurantPhoneNumber:
      process.env.SHIPDAY_RESTAURANT_PHONE || '+9607739160',
    orderItem: items,
    totalOrderCost: parseFloat(receipt.total_money || 0) || 1,
    paymentMethod: 'cash',
  };
}

async function reconcileLoyverseMissingOrders() {
  try {
    const { receipts } = await fetchLoyverseReceipts();

    for (const receipt of receipts) {
      const receiptId = getReceiptId(receipt);
      if (!receiptId) continue;

      const payload = mapLoyverseReceiptToShipday(receipt);
      const webhookKey = `loyverse-webhook-${payload.orderNumber}`;
      const reconcileKey = `loyverse-reconcile-${payload.orderNumber}`;

      if (sentOrderKeys.has(webhookKey) || sentOrderKeys.has(reconcileKey)) {
        continue;
      }

      console.log('LOYVERSE RECONCILE -> SHIPDAY:', JSON.stringify(payload));
      await safeDispatchToShipday(reconcileKey, payload, 'loyverse-reconcile');
    }

    lastReconcileIso = new Date().toISOString();
  } catch (err) {
    console.error('LOYVERSE RECONCILE ERROR:', err.response?.data || err.message);
  }
}

// -----------------------------
// Shipday dispatch + retry
// -----------------------------
async function safeDispatchToShipday(orderKey, payload, source) {
  if (sentOrderKeys.has(orderKey)) {
    console.log(`Skipping already sent order ${orderKey}`);
    return;
  }

  try {
    const result = await sendToShipday(payload);
    sentOrderKeys.add(orderKey);
    failedQueue.delete(orderKey);
    console.log(`${source.toUpperCase()} SENT:`, result);
    return result;
  } catch (err) {
    console.error(`${source.toUpperCase()} ERROR:`, err.response?.data || err.message);

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
      sentOrderKeys.add(orderKey);
      failedQueue.delete(orderKey);
      console.log(`RETRY SUCCESS ${orderKey}:`, result);
    } catch (err) {
      console.error(`RETRY FAILED ${orderKey}:`, err.response?.data || err.message);
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
  console.log('Starting background jobs...');
  console.log(
    `Loyverse reconcile every ${RECONCILE_INTERVAL_MS / 60000} minute(s)`
  );

  setInterval(async () => {
    try {
      await retryFailedOrders();
    } catch (err) {
      console.error('Retry loop error:', err);
    }
  }, RECONCILE_INTERVAL_MS);

  setInterval(async () => {
    try {
      await reconcileLoyverseMissingOrders();
    } catch (err) {
      console.error('Reconcile loop error:', err);
    }
  }, RECONCILE_INTERVAL_MS);
}

setTimeout(startJobs, 10000);
