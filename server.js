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

// 🔥 Memory store (avoid duplicates)
const processedReceipts = new Set();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});


// ==============================
// 🔹 WooCommerce Order Created
// ==============================
app.post('/webhooks/woocommerce/order-created', async (req, res) => {
  try {
    verifyWooWebhook(req);

    const order = req.body;

    if (!isDeliveryOrder(order)) {
      return res.status(200).json({ skipped: true });
    }

    const data = mapWooOrder(order);
    await sendToShipday(data);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('WC error:', err.message);
    return res.status(500).send('Error');
  }
});


// ==============================
// 🔹 WooCommerce Signature
// ==============================
function verifyWooWebhook(req) {
  const secret = process.env.WC_WEBHOOK_SECRET;
  const signature = req.get('x-wc-webhook-signature');

  if (!signature) return true;

  const digest = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('base64');

  if (digest !== signature) throw new Error('Invalid signature');

  return true;
}


// ==============================
// 🔹 Woo Mapping
// ==============================
function isDeliveryOrder(order) {
  return (order.shipping?.address_1 || '').length > 0;
}

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
// 🔹 Loyverse API Pull
// ==============================
async function fetchLoyverseOrders() {
  try {
    console.log('Fetching Loyverse receipts...');

    const res = await axios.get(
      'https://api.loyverse.com/v1.0/receipts',
      {
        headers: {
          Authorization: `Bearer ${process.env.LOYVERSE_API_KEY}`
        }
      }
    );

    const receipts = res.data.receipts || [];

    for (const receipt of receipts) {

      // ❌ Skip duplicates
      if (processedReceipts.has(receipt.id)) continue;

      // Only DELIVERY orders
      if (!receipt.note || !receipt.note.toLowerCase().includes('delivery')) continue;

      console.log('Processing receipt:', receipt.receipt_number);

      const items = (receipt.line_items || []).map(item => ({
        name: item.item_name,
        quantity: item.quantity,
      }));

      const orderData = {
        orderNumber: receipt.receipt_number,
        customerName: receipt.customer?.name || "Customer",
        customerPhoneNumber: receipt.customer?.phone_number || "",
        customerAddress: receipt.note,
        restaurantName: "FFGR",
        restaurantAddress: "Addu City, Maldives",
        orderItem: items,
        totalOrderCost: parseFloat(receipt.total_money || 0)
      };

      await sendToShipday(orderData);

      processedReceipts.add(receipt.id);

      console.log('Sent to Shipday:', receipt.receipt_number);
    }

  } catch (err) {
    console.error('Loyverse API error:', err.response?.data || err.message);
  }
}


// ==============================
// 🔹 Send to Shipday
// ==============================
async function sendToShipday(data) {
  const res = await axios.post(`${SHIPDAY_BASE}/orders`, data, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${process.env.SHIPDAY_API_KEY}`
    }
  });

  console.log('Shipday response:', res.data);
  return res.data;
}


// ==============================
// 🔹 AUTO RUN (every 60 sec)
// ==============================
setInterval(fetchLoyverseOrders, 60000);


// ==============================
// 🔹 Start Server
// ==============================
app.listen(PORT, () => {
  console.log(`FFGR bridge running on port ${PORT}`);
});
