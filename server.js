// server.js
import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

// Environment variables
const PORT = process.env.PORT || 3000;
const BAGIBAGI_WEBHOOK_TOKEN = process.env.BAGIBAGI_WEBHOOK_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DATABASE_URL = process.env.DATABASE_URL;

// Crash on missing secrets
if (!BAGIBAGI_WEBHOOK_TOKEN) {
  console.error("❌ Missing BAGIBAGI_WEBHOOK_TOKEN");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL");
  process.exit(1);
}

// PostgreSQL Pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Express App
const app = express();
app.use(express.json({ limit: "200kb" }));

let pendingDonations = []; // in-memory queue for Roblox

// Signature validation
function computeSig(body) {
  return crypto
    .createHmac("sha256", BAGIBAGI_WEBHOOK_TOKEN)
    .update(JSON.stringify(body))
    .digest("hex");
}

function safeEqual(a, b) {
  try {
    const x = Buffer.from(a, "hex");
    const y = Buffer.from(b, "hex");
    if (x.length !== y.length) return false;
    return crypto.timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

// Extract @username
function extractAtUsername(message) {
  if (!message) return null;
  const m = message.match(/@([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

// DB UPSERT
async function upsertDonation({
  donor_key,
  roblox_username,
  bagibagi_name,
  amount,
  message,
  timeISO
}) {
  const client = await pool.connect();
  try {
    const q = `
      INSERT INTO bagibagi_leaderboard (
        donor_key, roblox_username, bagibagi_name,
        total_rp, last_donation_rp, last_message, last_time
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (donor_key) DO UPDATE
      SET
        total_rp = bagibagi_leaderboard.total_rp + EXCLUDED.last_donation_rp,
        last_donation_rp = EXCLUDED.last_donation_rp,
        last_message = EXCLUDED.last_message,
        last_time = EXCLUDED.last_time,
        roblox_username = COALESCE(EXCLUDED.roblox_username, bagibagi_leaderboard.roblox_username),
        bagibagi_name = COALESCE(EXCLUDED.bagibagi_name, bagibagi_leaderboard.bagibagi_name)
      RETURNING donor_key, total_rp;
    `;
    const vals = [
      donor_key,
      roblox_username,
      bagibagi_name,
      amount,
      amount,
      message,
      timeISO
    ];

    const res = await client.query(q, vals);
    return res.rows[0];
  } finally {
    client.release();
  }
}

// WEBHOOK — main handler
app.post("/bagibagi-webhook", async (req, res) => {
  try {
    // 1. Validate signature
    const theirSig = req.headers["x-bagibagi-signature"] || "";
    const expected = computeSig(req.body);

    if (!safeEqual(theirSig, expected)) {
      console.warn("❌ Invalid signature attempt");
      return res.status(401).send("Invalid signature");
    }

    const payload = req.body;

    // 2. Parse payload
    const amount = Number(payload.amount) || 0;
    const bagibagiName = payload.name || "Anonymous";
    const message = payload.message || "";
    const timeISO = payload.created_at || new Date().toISOString();

    // 3. Username detection
    const atUser = extractAtUsername(message);

    let donor_key, roblox_username;

    if (atUser) {
      donor_key = `user:${atUser.toLowerCase()}`;
      roblox_username = atUser;
    } else {
      donor_key = `anon:${bagibagiName.toLowerCase().replace(/\s+/g, "_")}`;
    }

    // 4. DB write
    const result = await upsertDonation({
      donor_key,
      roblox_username,
      bagibagi_name: bagibagiName,
      amount,
      message,
      timeISO
    });

    console.log("💾 Stored donation:", result);

    // 5. Add to Roblox queue
    pendingDonations.push({
      id: payload.transaction_id,
      name: bagibagiName,
      amount,
      message,
      created_at: timeISO
    });

    // 6. Discord forwarding (optional)
    if (DISCORD_WEBHOOK_URL) {
      axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: "💸 New BagiBagi Donation",
            description: `**${bagibagiName}** donated **Rp ${amount}**\n${message}`,
            timestamp: timeISO
          }
        ]
      }).catch(() => {});
    }

    res.send("ok");
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("server error");
  }
});

// Roblox polling endpoint
app.get("/roblox/latest", (req, res) => {
  const copy = pendingDonations.slice();
  pendingDonations = [];
  res.json(copy);
});

// Leaderboard API
app.get("/leaderboard/top", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT donor_key, roblox_username, bagibagi_name,
              total_rp, last_donation_rp, last_message, last_time
       FROM bagibagi_leaderboard
       ORDER BY total_rp DESC
       LIMIT 10`
    );
    res.json(r.rows);
  } catch (err) {
    console.error("❌ Leaderboard error:", err);
    res.status(500).send("server error");
  }
});

// Health Check
app.get("/", (req, res) => {
  res.send("Bagibagi → Roblox bridge server is running.");
});

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
