require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, res, buf) {
  if (buf && buf.length) req.rawBody = buf;
}

const PORT = process.env.PORT || 8080;
const SHIPDAY_BASE = 'https://api.shipday.com';

// In-memory duplicate protection for current runtime
const processedReceipts = new Set();

// Track latest successful poll window
let lastPollIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ffgr-pos-shipday-bridge' });
});

app.get('/debug/loyverse', async (_req, res) => {
  try {
    const data = await fetchLoyverseReceipts(true);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      details: err.response?.data || null
    });
  }
});

app.post('/webhooks/woocommerce/order-created', async (req, res) => {
  try {
    verifyWooWebhook(req);

    const order = req.body;
    if (!isDeliveryOrder(order)) {
      return res.status(200).json({ ok: true, skipped: 'not delivery' });
    }

    const shipdayOrder = mapWooOrder(order);
    const result = await sendToShipday(shipdayOrder);

    return res.status(200).json({ ok: true, shipday: result });
  } catch (err) {
    console.error('WC create error:', err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/webhooks/woocommerce/order-updated', async (_req, res) => {
  return res.status(200).json({ ok: true });
});

function verifyWooWebhook(req) {
  const secret = process.env.WC_WEBHOOK_SECRET;
  if (!secret) throw new Error('WC_WEBHOOK_SECRET not configured');

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

function isDeliveryOrder(order) {
  const shippingMethod = (order.shipping_lines || [])
    .map(x => (x.method_title || '').toLowerCase())
    .join(' ');
  return Boolean(order.shipping?.address_1) || shippingMethod.includes('delivery');
}

function mapWooOrder(order) {
  const billing = order.billing || {};
  const shipping = order.shipping || {};

  const address = [
    shipping.address_1,
    shipping.address_2,
    shipping.city,
    shipping.state,
    shipping.postcode,
    shipping.country
  ]
    .filter(Boolean)
    .join(', ');

  return {
    orderNumber: String(order.id),
    customerName: [billing.first_name, billing.last_name].filter(Boolean).join(' ') || 'Customer',
    customerAddress: address || 'Address not provided',
    customerPhoneNumber: billing.phone || '',
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
    restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
    restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE || '',
    orderItem: (order.line_items || []).map(i => ({
      name: i.name || 'Item',
      quantity: Number(i.quantity || 1)
    })),
    totalOrderCost: parseFloat(order.total || 0)
  };
}

async function fetchLoyverseReceipts(debugMode = false) {
  if (!process.env.LOYVERSE_API_KEY) {
    throw new Error('LOYVERSE_API_KEY not configured');
  }

  const nowIso = new Date().toISOString();

  const response = await axios.get('https://api.loyverse.com/v1.0/receipts', {
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
  const summary = receipts.map(r => ({
    id: r.id,
    receipt_number: r.receipt_number,
    note: r.note || null,
    comment: r.comment || null,
    customer_name:
      r.customer?.name ||
      r.customer_name ||
      null,
    phone:
      r.customer?.phone_number ||
      r.customer?.phone ||
      r.phone_number ||
      null,
    total_money: r.total_money ?? null,
    line_items_count: Array.isArray(r.line_items) ? r.line_items.length : 0
  }));

  if (!debugMode) {
    console.log(`Loyverse returned ${receipts.length} receipts since ${lastPollIso}`);
    for (const s of summary.slice(0, 10)) {
      console.log(
        `Receipt ${s.receipt_number || s.id} | note=${JSON.stringify(s.note || s.comment || '')} | phone=${JSON.stringify(s.phone || '')}`
      );
    }
  }

  lastPollIso = nowIso;

  return { count: receipts.length, receipts, summary };
}

async function pollLoyverseAndSend() {
  try {
    const { receipts } = await fetchLoyverseReceipts(false);

    for (const receipt of receipts) {
      if (!receipt?.id) continue;
      if (processedReceipts.has(receipt.id)) {
        console.log(`Skipping duplicate receipt ${receipt.id}`);
        continue;
      }

      const noteText = [
        receipt.note,
        receipt.comment,
        receipt.customer_note,
        receipt.delivery_note
      ]
        .filter(Boolean)
        .join(' ')
        .trim();

      // Keep this rule simple for FFGR:
      // only receipts marked with DELIVERY in note/comment go to Shipday
      if (!noteText.toLowerCase().includes('delivery')) {
        console.log(`Skipping non-delivery receipt ${receipt.receipt_number || receipt.id}`);
        continue;
      }

      const customerName =
        receipt.customer?.name ||
        receipt.customer_name ||
        'Customer';

      const phone =
        receipt.customer?.phone_number ||
        receipt.customer?.phone ||
        receipt.phone_number ||
        '';

      const items = (receipt.line_items || []).map(item => ({
        name:
          item.item_name ||
          item.name ||
          item.item?.item_name ||
          'Item',
        quantity: Number(item.quantity || 1)
      }));

      const shipdayOrder = {
        orderNumber: String(receipt.receipt_number || receipt.id),
        customerName,
        customerPhoneNumber: phone,
        customerAddress: noteText || 'Address not provided',
        restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
        restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
        restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE || '',
        orderItem: items,
        totalOrderCost: parseFloat(receipt.total_money || 0)
      };

      console.log('Sending to Shipday:', JSON.stringify(shipdayOrder));

      const result = await sendToShipday(shipdayOrder);
      processedReceipts.add(receipt.id);

      console.log(`Sent receipt ${receipt.receipt_number || receipt.id} to Shipday`, result);
    }
  } catch (err) {
    console.error('Loyverse poll error:', err.response?.data || err.message);
  }
}

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

// Poll every 60 seconds
setInterval(pollLoyverseAndSend, 60000);

// Run one poll shortly after startup
setTimeout(pollLoyverseAndSend, 5000);

app.listen(PORT, () => {
  console.log(`FFGR bridge running on port ${PORT}`);
});
