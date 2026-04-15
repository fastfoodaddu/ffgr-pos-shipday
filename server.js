require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const SHIPDAY_BASE = 'https://api.shipday.com';

const sent = new Set();
const failed = new Map();

function mapToShipday(order) {
  const phone =
    order.customer?.phone ||
    order.phone ||
    '7739160';

  const name =
    order.customer?.name ||
    order.customerName ||
    'Customer';

  const address =
    order.customer?.address ||
    order.address ||
    'Hithadhoo';

  const notes =
    order.notes ||
    order.comment ||
    '';

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
      name: i.name || 'Item',
      quantity: i.quantity || 1,
    })),
    totalOrderCost: order.total || 1,
    paymentMethod: 'cash',
  };
}

async function sendToShipday(payload) {
  return axios.post(`${SHIPDAY_BASE}/orders`, payload, {
    headers: {
      Authorization: `Basic ${process.env.SHIPDAY_API_KEY}`,
    },
  });
}

app.post('/webhooks/ewity/order', async (req, res) => {
  try {
    const auth = req.headers['authorization'];

    if (auth !== process.env.EWITY_WEBHOOK_AUTH) {
      return res.status(401).send('Unauthorized');
    }

    const order = req.body;

    console.log('EWITY WEBHOOK:', JSON.stringify(order));

    const key = `ewity-${order.id || Date.now()}`;

    if (sent.has(key)) {
      return res.status(200).send('Already processed');
    }

    const payload = mapToShipday(order);

    await sendToShipday(payload);

    sent.add(key);
    failed.delete(key);

    console.log('SENT TO SHIPDAY');

    res.status(200).send('OK');
  } catch (err) {
    console.error('ERROR:', err.response?.data || err.message);

    failed.set(Date.now(), req.body);

    res.status(500).send('Error');
  }
});

setInterval(async () => {
  for (const [key, order] of failed.entries()) {
    try {
      const payload = mapToShipday(order);
      await sendToShipday(payload);

      sent.add(key);
      failed.delete(key);

      console.log('RETRY SUCCESS');
    } catch {}
  }
}, 900000);

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
