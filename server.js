// server.js
// Replace your existing file with this. Uses ESM imports (Node 18+/22+).
import express from "express";
import { createHmac } from "crypto";
import axios from "axios";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(express.json({ limit: "1mb" }));

// Config from environment
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const BAGIBAGI_TOKEN = process.env.BAGIBAGI_TOKEN || process.env.BAGIBAGI_WEBHOOK_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || process.env.DB_URL || null;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

// Basic validation
if (!BAGIBAGI_TOKEN) {
  console.warn("[startup] Warning: BAGIBAGI_TOKEN is not set. Webhook signature verification will fail.");
}
if (!DATABASE_URL) {
  console.error("[startup] ERROR: DATABASE_URL is not set. The server cannot run without DB.");
  // do not exit; let pool construction throw a clear error in logs
}

// Create Postgres pool (compatible with Supabase pooler)
// Accepts connection string like: postgresql://...:password@host:5432/postgres?sslmode=require
const pool = new Pool({
  connectionString: DATABASE_URL,
  // for safety with many providers; Postgres (node-postgres) detects ssl query param, but include fallback:
  ssl: DATABASE_URL && DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Utility: HMAC signature verification (sha256 hex)
function verifyBagibagiSignature(bodyString, signatureHex) {
  if (!BAGIBAGI_TOKEN) return false;
  try {
    const h = createHmac("sha256", BAGIBAGI_TOKEN).update(bodyString).digest("hex");
    return h === signatureHex;
  } catch (e) {
    console.warn("[verify] error", e && e.message);
    return false;
  }
}

// Helper: extract @username from message
function extractAtUsername(message) {
  if (!message || typeof message !== "string") return null;
  const m = message.match(/@([A-Za-z0-9_.]{1,20})/);
  return m ? m[1] : null;
}

// Helper: lookup Roblox username -> displayName via Roblox public API
async function lookupRobloxUsername(username) {
  if (!username) return null;
  try {
    const res = await axios.post(
      "https://users.roblox.com/v1/usernames/users",
      { usernames: [username], excludeBannedUsers: true },
      { headers: { "Content-Type": "application/json" }, timeout: 5000 }
    );
    if (res.data && Array.isArray(res.data.data) && res.data.data.length > 0) {
      const u = res.data.data[0];
      return { id: u.id, name: u.name, displayName: u.displayName };
    }
  } catch (err) {
    console.warn("[roblox lookup] failed for", username, err && err.message ? err.message : err);
  }
  return null;
}

// Upsert donation logic (stores/accumulates totals, caches roblox_display_name)
async function upsertDonation(payload) {
  // payload fields expected: transaction_id, name (bagibagi_name), amount, message, created_at
  // Build a stable donor_key; prefer bagibagi's provided identifier if any
  const bagibagiName = payload.name || payload.bagibagi_name || null;
  const amount = Number(payload.amount || 0);
  const lastMsg = payload.message || null;
  const lastTime = payload.created_at ? new Date(payload.created_at).toISOString() : new Date().toISOString();

  // Extract @username from message (if present)
  const atUsername = extractAtUsername(lastMsg);

  // donorKey: if the message included @username we might want to use that as identifier;
  // otherwise use bagibagi_name + transaction id as fallback
  const donorKey = atUsername ? `user:${atUsername}` : (payload.donor_key || `bagibagi:${payload.transaction_id}`);

  // Attempt to use cached roblox info if present
  let cached = null;
  try {
    const sel = await pool.query(`SELECT roblox_username, roblox_display_name FROM donations WHERE donor_key = $1 LIMIT 1`, [donorKey]);
    if (sel.rows && sel.rows.length > 0) cached = sel.rows[0];
  } catch (err) {
    console.warn("[upsert] DB select cached error:", err && err.message ? err.message : err);
  }

  let robloxUsernameToStore = null;
  let robloxDisplayNameToStore = null;
  let robloxUserId = null;

  if (atUsername) {
    robloxUsernameToStore = atUsername;

    if (cached && cached.roblox_username === robloxUsernameToStore && cached.roblox_display_name) {
      robloxDisplayNameToStore = cached.roblox_display_name;
    } else {
      const info = await lookupRobloxUsername(robloxUsernameToStore);
      if (info) {
        robloxDisplayNameToStore = info.displayName || null;
        robloxUserId = info.id || null;
      } else {
        robloxDisplayNameToStore = null;
      }
    }
  } else {
    // No @username provided -> keep roblox fields null
    robloxUsernameToStore = null;
    robloxDisplayNameToStore = null;
  }

  // Upsert into donations table: insert first-time, or update existing totals
  try {
    const q = `
      INSERT INTO donations (donor_key, roblox_username, roblox_display_name, bagibagi_name, total_rp, last_donation_rp, last_message, last_time)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (donor_key)
      DO UPDATE SET
        roblox_username = COALESCE(EXCLUDED.roblox_username, donations.roblox_username),
        roblox_display_name = COALESCE(EXCLUDED.roblox_display_name, donations.roblox_display_name),
        bagibagi_name = COALESCE(EXCLUDED.bagibagi_name, donations.bagibagi_name),
        total_rp = donations.total_rp + EXCLUDED.last_donation_rp,
        last_donation_rp = EXCLUDED.last_donation_rp,
        last_message = EXCLUDED.last_message,
        last_time = EXCLUDED.last_time
      RETURNING *;
    `;

    const params = [
      donorKey,
      robloxUsernameToStore,
      robloxDisplayNameToStore,
      bagibagiName,
      amount, // initial total for new row
      amount, // last_donation_rp
      lastMsg,
      lastTime,
    ];

    const res = await pool.query(q, params);
    return res.rows[0];
  } catch (err) {
    console.error("[upsert] DB upsert error:", err && err.message ? err.message : err);
    throw err;
  }
}

// ROUTES

// root (health)
app.get("/", (req, res) => {
  res.type("text").send("Bagibagi → Roblox bridge server is running.");
});

// leaderboard: top N donors (default 10)
app.get("/leaderboard/top", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 10;
    const q = `
      SELECT donor_key, bagibagi_name, roblox_username, roblox_display_name, total_rp, last_donation_rp, last_message, last_time
      FROM donations
      ORDER BY total_rp DESC
      LIMIT $1;
    `;
    const result = await pool.query(q, [limit]);
    res.json(result.rows || []);
  } catch (err) {
    console.error("[leaderboard] error:", err && err.message ? err.message : err);
    res.status(500).json({ error: "failed" });
  }
});

// helper: get total for a specific username (roblox username)
app.get("/roblox/get-player-total/:username", async (req, res) => {
  const username = req.params.username;
  try {
    const q = `SELECT total_rp FROM donations WHERE roblox_username = $1 LIMIT 1;`;
    const r = await pool.query(q, [username]);
    if (r.rows && r.rows.length > 0) {
      return res.json({ username, total_rp: r.rows[0].total_rp });
    }
    // fallback: try donor_key
    const q2 = `SELECT total_rp FROM donations WHERE donor_key = $1 LIMIT 1;`;
    const r2 = await pool.query(q2, [`user:${username}`]);
    if (r2.rows && r2.rows.length > 0) return res.json({ username, total_rp: r2.rows[0].total_rp });
    return res.json({ username, total_rp: 0 });
  } catch (err) {
    console.error("[get-player-total] error:", err && err.message ? err.message : err);
    res.status(500).json({ error: "failed" });
  }
});

// webhook receiver for Bagibagi
app.post("/bagibagi-webhook", async (req, res) => {
  // Body is JSON
  const body = req.body || {};
  const rawBody = JSON.stringify(body);
  const sig = req.header("X-Bagibagi-Signature") || req.header("x-bagibagi-signature") || "";

  // Verify signature
  if (BAGIBAGI_TOKEN) {
    const ok = verifyBagibagiSignature(rawBody, sig);
    if (!ok) {
      console.warn("[webhook] signature invalid");
      return res.status(401).json({ error: "invalid signature" });
    }
  } else {
    console.warn("[webhook] no BAGIBAGI_TOKEN configured; skipping signature verification");
  }

  // Process donation payload
  try {
    const stored = await upsertDonation(body);

    // Optional: send Discord notification (if configured)
    if (DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(DISCORD_WEBHOOK_URL, {
          content: `New donation: ${body.name || body.bagibagi_name || "Anon"} donated ${body.amount} (message: ${body.message || "-"})`,
        });
      } catch (dErr) {
        console.warn("[discord] notify failed:", dErr && dErr.message ? dErr.message : dErr);
      }
    }

    console.log("[webhook] stored donation:", stored ? stored.donor_key : "(no row)");
    res.json({ ok: true, stored });
  } catch (err) {
    console.error("[webhook] processing error:", err && err.message ? err.message : err);
    res.status(500).json({ error: "processing failed" });
  }
});

// Basic ping endpoint for uptime monitoring
app.get("/ping", (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// global error handlers
process.on("unhandledRejection", (err) => {
  console.error("[process] unhandledRejection", err && err.message ? err.message : err);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException", err && err.stack ? err.stack : err);
});

// start server
app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});

export {}; // keep ESM module happy
