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

const PORT = process.env.PORT || 8080;
const SHIPDAY_BASE = 'https://api.shipday.com';

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ffgr-pos-shipday-bridge' });
});


// ==============================
// 🔹 WooCommerce - Order Created
// ==============================
app.post('/webhooks/woocommerce/order-created', async (req, res) => {
  try {
    verifyWooWebhook(req);

    const order = req.body;

    if (!isDeliveryOrder(order)) {
      return res.status(200).json({ ok: true, skipped: 'not delivery' });
    }

    const shipdayOrder = mapWooOrder(order);
    const result = await createShipdayOrder(shipdayOrder);

    return res.status(200).json({ ok: true, shipday: result });

  } catch (err) {
    console.error('WC create error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});


// ==============================
// 🔹 WooCommerce Signature Check
// ==============================
function verifyWooWebhook(req) {
  const secret = process.env.WC_WEBHOOK_SECRET;
  const signature = req.get('x-wc-webhook-signature');

  if (!signature) {
    console.log('No signature - skipping');
    return true;
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');

  if (digest !== signature) {
    throw new Error('Invalid signature');
  }

  return true;
}


// ==============================
// 🔹 Check if Delivery Order
// ==============================
function isDeliveryOrder(order) {
  return (order.shipping?.address_1 || '').length > 0;
}


// ==============================
// 🔹 Map Woo → Shipday
// ==============================
function mapWooOrder(order) {
  return {
    orderNumber: String(order.id),
    customerName: `${order.billing.first_name} ${order.billing.last_name}`,
    customerAddress: order.shipping.address_1,
    customerPhoneNumber: order.billing.phone,
    restaurantName: "FFGR",
    restaurantAddress: "Addu City, Maldives",
    orderItem: (order.line_items || []).map(i => ({
      name: i.name,
      quantity: i.quantity
    })),
    totalOrderCost: parseFloat(order.total)
  };
}


// ==============================
// 🔹 Loyverse → Shipday
// ==============================
app.post('/webhooks/loyverse/receipt', async (req, res) => {
  try {
    console.log('Loyverse receipt webhook received');

    const receipt = req.body.receipt;
    if (!receipt) return res.status(200).send('No receipt');

    // Only DELIVERY orders
    if (!receipt.note || !receipt.note.toLowerCase().includes('delivery')) {
      console.log('Not delivery, skipping');
      return res.status(200).send('Skipped');
    }

    const items = (receipt.line_items || []).map(item => ({
      name: item.item_name,
      quantity: item.quantity,
    }));

    const orderData = {
      orderNumber: receipt.receipt_number,
      customerName: receipt.customer?.name || "Customer",
      customerPhoneNumber: receipt.customer?.phone || "",
      customerAddress: receipt.note,
      restaurantName: "FFGR",
      restaurantAddress: "Addu City, Maldives",
      orderItem: items,
      totalOrderCost: parseFloat(receipt.total_money || 0)
    };

    console.log('Sending to Shipday:', orderData);

    const result = await axios.post(`${SHIPDAY_BASE}/orders`, orderData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${process.env.SHIPDAY_API_KEY}`
      }
    });

    console.log('Shipday response:', result.data);

    return res.status(200).send('Sent to Shipday');

  } catch (err) {
    console.error('Loyverse error:', err.response?.data || err.message);
    return res.status(500).send('Error');
  }
});


// ==============================
// 🔹 Shipday Order Creator
// ==============================
async function createShipdayOrder(data) {
  const res = await axios.post(`${SHIPDAY_BASE}/orders`, data, {
    headers: {
      'Authorization': `Basic ${process.env.SHIPDAY_API_KEY}`
    }
  });
  return res.data;
}


// ==============================
// 🔹 Start Server
// ==============================
app.listen(PORT, () => {
  console.log(`FFGR bridge running on port ${PORT}`);
});
