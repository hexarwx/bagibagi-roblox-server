import express from "express";
import { createHmac, timingSafeEqual } from "crypto";
import axios from "axios";

const app = express();
app.use(express.json());

// ENV VARIABLES (set in Render)
const WEBHOOK_TOKEN = process.env.BAGIBAGI_WEBHOOK_TOKEN;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

// In-memory donation storage
let donations = [];

// Validate BagiBagi Signature
function validateSig(body, signature) {
    const hmac = createHmac("sha256", WEBHOOK_TOKEN)
        .update(JSON.stringify(body))
        .digest("hex");

    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(hmac, "hex");

    return a.length === b.length && timingSafeEqual(a, b);
}

// Webhook Receiver
app.post("/bagibagi-webhook", async (req, res) => {
    const sig = req.headers["x-bagibagi-signature"];

    if (!sig || !validateSig(req.body, sig)) {
        return res.status(401).send("Invalid signature");
    }

    const donation = {
        id: req.body.transaction_id,
        name: req.body.name,
        amount: req.body.amount,
        message: req.body.message || "",
        time: Date.now()
    };

    // Store for Roblox
    donations.push(donation);

    // Send to Discord
    if (DISCORD_WEBHOOK) {
        await axios.post(DISCORD_WEBHOOK, {
            embeds: [
                {
                    title: "💸 New Donation!",
                    description: `**${donation.name}** donated **Rp ${donation.amount}**\n\n*${donation.message}*`,
                    color: 0x00ff00,
                }
            ]
        });
    }

    console.log("Donation received:", donation);

    res.send("OK");
});

// Roblox polls this
app.get("/roblox/latest", (req, res) => {
    res.json(donations);
    donations = []; // Clear after sending
});

// Default check
app.get("/", (req, res) => {
    res.send("Bagibagi → Roblox bridge server is running.");
});

app.listen(3000, () => {
    console.log("Running on port 3000");
});
