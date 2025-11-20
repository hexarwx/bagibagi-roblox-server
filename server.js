// server.js
import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const PORT = process.env.PORT || 3000;
const BAGIBAGI_WEBHOOK_TOKEN = process.env.BAGIBAGI_WEBHOOK_TOKEN;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const DATABASE_URL = process.env.DATABASE_URL;

if (!BAGIBAGI_WEBHOOK_TOKEN) {
  console.error("Missing BAGIBAGI_WEBHOOK_TOKEN in environment.");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL in environment.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Supabase requires rejectUnauthorized false on some environments:
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(express.json({ limit: "100kb" })); // small payloads expected

// In-memory queue for Roblox polling (kept small)
let pendingDonations = [];

/** security: compute expected signature */
function computeSig(body) {
  return crypto.createHmac("sha256", BAGIBAGI_WEBHOOK_TOKEN).update(JSON.stringify(body)).digest("hex");
}

/** safe timing-attack resistant compare */
function safeCompareHex(aHex, bHex) {
  try {
    const a = Buffer.from(aHex, "hex");
    const b = Buffer.from(bHex, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/** extract @username if present — returns username or null */
function extractAtUsername(message) {
  if (!message || typeof message !== "string") return null;
  const m = message.match(/@([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

/** Upsert donation into PostgreSQL */
async function upsertDonation({ donor_key, bagibagi_name, roblox_username, amount, message, timeISO }) {
  const client = await pool.connect();
  try {
    const q = `
      INSERT INTO bagibagi_leaderboard (
        donor_key, roblox_username, bagibagi_name, total_rp, last_donation_rp, last_message, last_time
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (donor_key) DO UPDATE
      SET
        total_rp = bagibagi_leaderboard.total_rp + EXCLUDED.last_donation_rp,
        last_donation_rp = EXCLUDED.last_donation_rp,
        last_message = EXCLUDED.last_message,
        last_time = EXCLUDED.last_time,
        roblox_username = COALESCE(EXCLUDED.roblox_username, bagibagi_leaderboard.roblox_username),
        bagibagi_name = COALESCE(EXCLUDED.bagibagi_name, bagibagi_leaderboard.bagibagi_name)
      RETURNING donor_key, roblox_username, bagibagi_name, total_rp, last_donation_rp, last_message, last_time;
    `;
    const vals = [donor_key, roblox_username, bagibagi_name, amount, amount, message, timeISO];
    const res = await client.query(q, vals);
    return res.rows[0];
  } finally {
    client.release();
  }
}

/** Endpoint: BagiBagi webhook */
app.post("/bagibagi-webhook", async (req, res) => {
  try {
    const sigHeader = (req.headers["x-bagibagi-signature"] || "").toString();
    const expected = computeSig(req.body);
    if (!safeCompareHex(sigHeader, expected)) {
      console.warn("Invalid signature attempt");
      return res.status(401).send("Invalid signature");
    }

    const payload = req.body;
    const amount = Number(payload.amount) || 0;
    const bagibagiName = (payload.name || "Anonymous").toString();
    const message = (payload.message || "").toString();
    const timeISO = payload.created_at || new Date().toISOString();

    // Determine donor key for aggregation
    const atUsername = extractAtUsername(message);
    let donor_key, roblox_username = null;
    if (atUsername) {
      donor_key = `user:${atUsername.toLowerCase()}`;
      roblox_username = atUsername;
    } else {
      const safe = bagibagiName.trim() || "anonymous";
      donor_key = `anon:${safe.toLowerCase().replace(/\s+/g, "_")}`;
    }

    // Store in DB
    const row = await upsertDonation({
      donor_key,
      bagibagi_name: bagibagiName,
      roblox_username,
      amount,
      message,
      timeISO
    });

    // Push to in-memory queue (for Roblox polling)
    pendingDonations.push({
      id: payload.transaction_id || `local-${Date.now()}`,
      name: bagibagiName,
      amount,
      message,
      created_at: timeISO
    });

    // Optional: forward to Discord
    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          embeds: [
            {
              title: "💸 New BagiBagi Donation",
              description: `**${bagibagiName}** donated **Rp ${amount}**\n${message || ""}`,
              timestamp: new Date(timeISO).toISOString()
            }
          ]
        });
      } catch (err) {
        console.warn("Discord webhook failed:", err.message);
      }
    }

    console.log("Stored donation:", row.donor_key, "total_rp:", row.total_rp);
    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).send("server error");
  }
});

/** Endpoint: Roblox polls this to get pending donations (then this clears them) */
app.get("/roblox/latest", (req, res) => {
  try {
    const out = pendingDonations.slice();
    pendingDonations = [];
    res.json(out);
  } catch (err) {
    console.error("roblox/latest error:", err);
    res.status(500).send("server error");
  }
});

/** Endpoint: Top 10 leaderboard (from DB) */
app.get("/leaderboard/top", async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const q = `
        SELECT donor_key, roblox_username, roblox_display_name, bagibagi_name, total_rp, last_donation_rp, last_message, last_time
        FROM bagibagi_leaderboard
        ORDER BY total_rp DESC
        LIMIT 10;
      `;
      const r = await client.query(q);
      res.json(r.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("leaderboard error:", err);
    res.status(500).send("server error");
  }
});

/** Health check */
app.get("/", (req, res) => res.send("Bagibagi bridge (leaderboard) running"));

app.listen(PORT, () => console.log("Server listening on port", PORT));
