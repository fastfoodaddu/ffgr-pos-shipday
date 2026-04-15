require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TIME_ZONE = 'Indian/Maldives';

const EWITY_BASE = 'https://app.ewitypos.com/api/ecom-v1';
const SHIPDAY_BASE = 'https://api.shipday.com';

const POLL_INTERVAL = 30000; // 30 sec
const RETRY_INTERVAL = 900000; // 15 min

let lastPoll = new Date(Date.now() - 10 * 60 * 1000).toISOString();

const sent = new Set();
const failed = new Map();

function now() {
  return new Date().toLocaleString('en-US', { timeZone: TIME_ZONE });
}

// -----------------------------
// FETCH EWITY ORDERS (IMPORTANT)
// -----------------------------
async function fetchOrders() {
  try {
    const res = await axios.get(`${EWITY_BASE}/orders`, {
      headers: {
        'X-Ewity-Platform': process.env.EWITY_PLATFORM,
        Authorization: `Bearer ${process.env.EWITY_API_TOKEN}`,
      },
      params: {
        updated_at_min: lastPoll,
      },
    });

    const orders = res.data?.data || [];

    console.log(`[${now()}] Ewity returned ${orders.length} orders`);

    return orders;
  } catch (err) {
    console.error('EWITY FETCH ERROR:', err.response?.data || err.message);
    return [];
  }
}

// -----------------------------
// MAP TO SHIPDAY
// -----------------------------
function mapToShipday(order) {
  const phone = order.customer?.phone || '7739160';
  const name = order.customer?.name || 'Customer';

  const address = order.customer?.address || 'Hithadhoo';
  const notes = order.notes || '';

  return {
    orderNumber: String(order.id || Date.now()),
    customerName: `${name} - ${phone}`,
    customerPhoneNumber: phone,
    customerAddress: notes ? `${address} - ${notes}` : address,
    deliveryInstruction: notes,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME,
    restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS,
    restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE,
    orderItem: (order.items || []).map(i => ({
      name: i.name,
      quantity: i.quantity || 1,
    })),
    totalOrderCost: order.total || 1,
    paymentMethod: 'cash',
  };
}

// -----------------------------
// SEND TO SHIPDAY
// -----------------------------
async function sendToShipday(payload) {
  return axios.post(`${SHIPDAY_BASE}/orders`, payload, {
    headers: {
      Authorization: `Basic ${process.env.SHIPDAY_API_KEY}`,
    },
  });
}

// -----------------------------
// MAIN POLLING
// -----------------------------
async function poll() {
  const orders = await fetchOrders();
  const nowIso = new Date().toISOString();

  for (const order of orders) {
    const key = `ewity-${order.id}`;

    if (sent.has(key)) continue;

    try {
      const payload = mapToShipday(order);

      console.log('SENDING TO SHIPDAY:', payload);

      await sendToShipday(payload);

      sent.add(key);
      failed.delete(key);

      console.log('SUCCESS:', order.id);
    } catch (err) {
      console.error('FAILED:', err.response?.data || err.message);

      failed.set(key, order);
    }
  }

  lastPoll = nowIso;
}

// -----------------------------
// RETRY FAILED
// -----------------------------
async function retryFailed() {
  for (const [key, order] of failed.entries()) {
    try {
      const payload = mapToShipday(order);

      await sendToShipday(payload);

      sent.add(key);
      failed.delete(key);

      console.log('RETRY SUCCESS:', key);
    } catch (err) {
      console.error('RETRY FAILED:', key);
    }
  }
}

// -----------------------------
// START
// -----------------------------
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

setInterval(poll, POLL_INTERVAL);
setInterval(retryFailed, RETRY_INTERVAL);
