import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

let EWITY_TOKEN = "";

// 🔐 Login to Ewity
async function loginEwity() {
    const res = await axios.post("https://api.ewitypos.com/auth/login", {
        username: process.env.EWITY_USER,
        password: process.env.EWITY_PASS
    });

    EWITY_TOKEN = res.data.access_token;
    console.log("Ewity token updated");
}

// 📥 Fetch Orders
app.get("/orders", async (req, res) => {
    try {
        const response = await axios.get("https://api.ewitypos.com/orders", {
            headers: {
                Authorization: `Bearer ${EWITY_TOKEN}`
            }
        });

        res.json(response.data);
    } catch (err) {
        res.status(500).json(err.response?.data || err.message);
    }
});

// 🔄 Refresh token every 30 min
setInterval(loginEwity, 30 * 60 * 1000);

// Start
app.listen(3000, async () => {
    await loginEwity();
    console.log("Server running on port 3000");
});
