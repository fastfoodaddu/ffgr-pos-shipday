require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(express.json({ verify: rawBodySaver }));

function rawBodySaver(req, res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf;
  }
}

const PORT = process.env.PORT || 3000;
const SHIPDAY_BASE = 'https://api.shipday.com';

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ffgr-pos-shipday-bridge' });
});

app.post('/webhooks/woocommerce/order-created', async (req, res) => {
  try {
    verifyWooWebhook(req);
    const payload = req.body;
    if (!isDeliveryOrder(payload)) {
      return res.status(200).json({ ok: true, skipped: 'not a delivery order' });
    }
    const shipdayOrder = mapWooOrderToShipday(payload);
    const result = await createShipdayOrder(shipdayOrder);

    if (process.env.SHIPDAY_AUTO_ASSIGN === 'true' && process.env.SHIPDAY_CARRIER_NAME) {
      await assignShipdayOrder(result.orderId || result.id, process.env.SHIPDAY_CARRIER_NAME);
    }

    return res.status(200).json({ ok: true, shipday: result });
  } catch (error) {
    console.error('WC create webhook error:', error.response?.data || error.message);
    return res.status(500).json({ ok: false, error: error.message, details: error.response?.data || null });
  }
});

app.post('/webhooks/woocommerce/order-updated', async (req, res) => {
  try {
    verifyWooWebhook(req);
    const payload = req.body;
    return res.status(200).json({ ok: true, note: 'implement update logic after persisting Shipday order ids' });
  } catch (error) {
    console.error('WC update webhook error:', error.response?.data || error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/webhooks/shipday/status', async (req, res) => {
  try {
    const payload = req.body;
    await handleShipdayStatus(payload);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Shipday status webhook error:', error.response?.data || error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/webhooks/loyverse', async (req, res) => {
  try {
    // Keep as stub until your exact Loyverse event payload is confirmed.
    // Add signature verification here once you create the webhook via Loyverse OAuth/app flow.
    const payload = req.body;
    if (!shouldDispatchFromLoyverse(payload)) {
      return res.status(200).json({ ok: true, skipped: 'not marked for delivery dispatch' });
    }
    const shipdayOrder = mapLoyverseReceiptToShipday(payload);
    const result = await createShipdayOrder(shipdayOrder);
    return res.status(200).json({ ok: true, shipday: result });
  } catch (error) {
    console.error('Loyverse webhook error:', error.response?.data || error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});
function verifyWooWebhook(req) {
  const secret = process.env.WC_WEBHOOK_SECRET;
  if (!secret) throw new Error('WC_WEBHOOK_SECRET not configured');

  const signature = req.get('x-wc-webhook-signature');

  // WooCommerce test/save requests may arrive without signature.
  // Accept them so the webhook can be saved.
  if (!signature) {
    console.log('No x-wc-webhook-signature header, skipping verification');
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
  const shippingMethod = (order.shipping_lines || []).map(x => (x.method_title || '').toLowerCase()).join(' ');
  const meta = (order.meta_data || []).map(x => `${x.key}:${x.value}`.toLowerCase()).join(' | ');
  return shippingMethod.includes('delivery') || meta.includes('delivery') || !!order.shipping?.address_1;
}

function mapWooOrderToShipday(order) {
  const billing = order.billing || {};
  const shipping = order.shipping || {};
  const destAddress = compactAddress([
    shipping.address_1,
    shipping.address_2,
    shipping.city,
    shipping.state,
    shipping.postcode,
    shipping.country
  ]);

  const items = (order.line_items || []).map(item => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: parseFloat(item.price || 0)
  }));

  const now = new Date();
  const pickup = new Date(now.getTime() + 10 * 60000);
  const delivery = new Date(now.getTime() + Number(process.env.SHIPDAY_DEFAULT_DELIVERY_MINUTES || 45) * 60000);

  return {
    orderNumber: String(order.id),
    customerName: fullName(shipping.first_name, shipping.last_name) || fullName(billing.first_name, billing.last_name) || 'Customer',
    customerAddress: destAddress,
    customerEmail: billing.email || undefined,
    customerPhoneNumber: billing.phone || undefined,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME,
    restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS,
    restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE,
    expectedDeliveryDate: toDateUTC(now),
    expectedPickupTime: toTimeUTC(pickup),
    expectedDeliveryTime: toTimeUTC(delivery),
    pickupLatitude: parseFloatOrUndefined(process.env.SHIPDAY_DEFAULT_PICKUP_LAT),
    pickupLongitude: parseFloatOrUndefined(process.env.SHIPDAY_DEFAULT_PICKUP_LNG),
    orderItem: items,
    tax: parseFloat(order.total_tax || 0),
    discountAmount: parseFloat(order.discount_total || 0),
    deliveryFee: parseFloat((order.shipping_lines || []).reduce((sum, x) => sum + parseFloat(x.total || 0), 0)),
    totalOrderCost: parseFloat(order.total || 0),
    orderSource: 'WooCommerce',
    paymentMethod: normalizePaymentMethod(order.payment_method),
    deliveryInstruction: (order.customer_note || '').slice(0, 250) || undefined,
    additionalId: String(order.id),
    isCatering: false
  };
}

function shouldDispatchFromLoyverse(payload) {
  const s = JSON.stringify(payload).toLowerCase();
  return s.includes('delivery');
}

function mapLoyverseReceiptToShipday(payload) {
  // Adjust once you confirm the exact Loyverse webhook payload.
  return {
    orderNumber: String(payload.id || payload.receipt_id || Date.now()),
    customerName: payload.customerName || payload.customer?.name || 'Customer',
    customerAddress: payload.customerAddress || payload.customer?.address || 'Address not provided',
    customerPhoneNumber: payload.customerPhoneNumber || payload.customer?.phone_number,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME,
    restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS,
    restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE,
    expectedDeliveryDate: toDateUTC(new Date()),
    expectedPickupTime: toTimeUTC(new Date(Date.now() + 10 * 60000)),
    expectedDeliveryTime: toTimeUTC(new Date(Date.now() + Number(process.env.SHIPDAY_DEFAULT_DELIVERY_MINUTES || 45) * 60000)),
    totalOrderCost: 0,
    orderSource: 'Loyverse',
    paymentMethod: 'cash'
  };
}

app.post('/webhooks/loyverse/receipt', async (req, res) => {
  try {
    console.log('Loyverse receipt webhook received');
    console.log(JSON.stringify(req.body, null, 2));
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Loyverse webhook error:', err);
    return res.status(500).send('Error');
  }
});

async function createShipdayOrder(payload) {
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

async function assignShipdayOrder(orderId, carrierName) {
  if (!orderId) throw new Error('Cannot assign Shipday order: missing orderId');
  const payload = { name: carrierName, orderId };
  const { data } = await axios.post(`${SHIPDAY_BASE}/on-demand/assign`, payload, {
    headers: {
      Authorization: `Basic ${process.env.SHIPDAY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });
  return data;
}

async function handleShipdayStatus(payload) {
  console.log('Shipday status event:', JSON.stringify(payload));
  if (!process.env.ORDER_STATUS_WEBHOOK_URL) return;
  await axios.post(process.env.ORDER_STATUS_WEBHOOK_URL, payload, { timeout: 10000 });
}

function normalizePaymentMethod(method) {
  const m = String(method || '').toLowerCase();
  if (m.includes('cash')) return 'cash';
  return 'credit_card';
}

function compactAddress(parts) {
  return parts.filter(Boolean).join(', ');
}

function fullName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim();
}

function toDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function toTimeUTC(date) {
  return date.toISOString().slice(11, 19);
}

function parseFloatOrUndefined(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

app.listen(PORT, () => {
  console.log(`FFGR bridge running on port ${PORT}`);
});
