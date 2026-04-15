const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// 🔥 Shipday config
const SHIPDAY_API_KEY = "YOUR_API_KEY";
const SHIPDAY_URL = "https://api.shipday.com/orders";

// Maldives timezone fix
function getMaldivesTime() {
  return new Date().toLocaleString("en-US", { timeZone: "Indian/Maldives" });
}

// 👉 Ewity webhook endpoint
app.post("/ewity-webhook", async (req, res) => {
  try {
    const order = req.body;

    // ⚠️ Adjust based on Ewity structure
    const shipdayPayload = {
      orderNumber: order.invoice_no || order.id,
      customerName: order.customer?.name || "Customer",
      customerPhoneNumber: order.customer?.phone || "",
      customerAddress: order.customer?.address || "Unknown",
      orderSource: "EWITY",
      deliveryFee: 0,
      orderItems: (order.items || []).map(i => ({
        name: i.name,
        quantity: i.qty,
        unitPrice: i.price
      })),
      totalOrderCost: order.total || 0,
      expectedPickupTime: getMaldivesTime()
    };

    const response = await axios.post(
      SHIPDAY_URL,
      shipdayPayload,
      {
        headers: {
          Authorization: `Bearer ${SHIPDAY_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Sent to Shipday:", response.data);
    res.send("OK");

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
