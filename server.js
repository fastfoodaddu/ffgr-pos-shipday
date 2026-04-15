require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const TIME_ZONE = 'Indian/Maldives';

const EWITY_BASE = process.env.EWITY_API_BASE_URL;
const EWITY_ORDERS_PATH = process.env.EWITY_ORDERS_PATH || '/bills';
const SHIPDAY_BASE = 'https://api.shipday.com';

const POLL_INTERVAL = 30000; // 30 sec
const RETRY_INTERVAL = 900000; // 15 min

let lastPoll = new Date(Date.now() - 10 * 60 * 1000).toISOString();

const sent = new Set();
const failed = new Map();

function now() {
  return new Date().toLocaleString('en-US', {
    timeZone: TIME_ZONE,
    hour12: false,
  });
}

async function fetchOrders() {
  try {
    const url = `${EWITY_BASE}${EWITY_ORDERS_PATH}`;
    console.log(`[${now()}] Fetching Ewity from: ${url}`);

    const res = await axios.get(url, {
      headers: {
        'X-Ewity-Platform': process.env.EWITY_PLATFORM,
        Authorization: `Bearer ${process.env.EWITY_API_TOKEN}`,
      },
      params: {
        updated_at_min: lastPoll,
      },
      timeout: 20000,
    });

    const orders =
      res.data?.data ||
      res.data?.orders ||
      res.data?.bills ||
      res.data?.sales ||
      [];

    console.log(`[${now()}] Ewity returned ${orders.length} orders`);
    return orders;
  } catch (err) {
    console.error(
      `[${now()}] EWITY FETCH ERROR:`,
      err.response?.data || err.message
    );
    return [];
  }
}

function mapToShipday(order) {
  const phone =
    order.customer?.phone ||
    order.customerPhoneNumber ||
    order.customer_phone ||
    '7739160';

  const name =
    order.customer?.name ||
    order.customerName ||
    order.customer_name ||
    'Customer';

  const address =
    order.customer?.address ||
    order.customerAddress ||
    order.customer_address ||
    'Hithadhoo';

  const notes =
    order.notes ||
    order.note ||
    order.comments ||
    '';

  const items =
    order.items ||
    order.line_items ||
    order.products ||
    [];

  return {
    orderNumber: String(
      order.id ||
      order.billNumber ||
      order.bill_number ||
      order.orderNumber ||
      Date.now()
    ),
    customerName: `${name} - ${phone}`,
    customerPhoneNumber: phone,
    customerAddress: notes ? `${address} - ${notes}` : address,
    deliveryInstruction: notes,
    restaurantName: process.env.SHIPDAY_RESTAURANT_NAME || 'FFGR',
    restaurantAddress: process.env.SHIPDAY_RESTAURANT_ADDRESS || 'Addu City, Maldives',
    restaurantPhoneNumber: process.env.SHIPDAY_RESTAURANT_PHONE || '+9607739160',
    orderItem: Array.isArray(items) && items.length
      ? items.map(i => ({
          name: i.name || i.item_name || 'Item',
          quantity: i.quantity || i.qty || 1,
        }))
      : [{ name: 'Order', quantity: 1 }],
    totalOrderCost:
      Number(
        order.total ||
        order.total_amount ||
        order.grand_total ||
        1
      ) || 1,
    paymentMethod: 'cash',
  };
}

async function sendToShipday(payload) {
  return axios.post(`${SHIPDAY_BASE}/orders`, payload, {
    headers: {
      Authorization: `Basic ${process.env.SHIPDAY_API_KEY}`,
    },
    timeout: 20000,
  });
}

async function poll() {
  const orders = await fetchOrders();
  const nowIso = new Date().toISOString();

  for (const order of orders) {
    const key = `ewity-${order.id || order.billNumber || order.orderNumber}`;

    if (sent.has(key)) continue;

    try {
      const payload = mapToShipday(order);
      console.log(`[${now()}] SENDING TO SHIPDAY:`, JSON.stringify(payload));

      await sendToShipday(payload);

      sent.add(key);
      failed.delete(key);

      console.log(`[${now()}] SUCCESS:`, key);
    } catch (err) {
      console.error(
        `[${now()}] FAILED:`,
        err.response?.data || err.message
      );
      failed.set(key, order);
    }
  }

  lastPoll = nowIso;
}

async function retryFailed() {
  for (const [key, order] of failed.entries()) {
    try {
      const payload = mapToShipday(order);
      await sendToShipday(payload);

      sent.add(key);
      failed.delete(key);

      console.log(`[${now()}] RETRY SUCCESS:`, key);
    } catch (err) {
      console.error(`[${now()}] RETRY FAILED:`, key);
    }
  }
}

app.get('/', (_req, res) => {
  res.send('Ewity bridge is running');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ewityPath: EWITY_ORDERS_PATH });
});

app.get('/debug/ewity', async (_req, res) => {
  try {
    const url = `${EWITY_BASE}${EWITY_ORDERS_PATH}`;
    const r = await axios.get(url, {
      headers: {
        'X-Ewity-Platform': process.env.EWITY_PLATFORM,
        Authorization: `Bearer ${process.env.EWITY_API_TOKEN}`,
      },
      timeout: 20000,
    });

    res.json(r.data);
  } catch (err) {
    res.status(500).json(err.response?.data || { error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

setInterval(poll, POLL_INTERVAL);
setInterval(retryFailed, RETRY_INTERVAL);
