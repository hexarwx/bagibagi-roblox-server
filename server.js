// Add near top of file (imports)
import axios from "axios";

// helper: extract @username (returns string or null)
function extractAtUsername(message) {
  if (!message || typeof message !== "string") return null;
  // match @username (Roblox usernames use letters, digits, underscore, and periods; keep it permissive)
  const m = message.match(/@([A-Za-z0-9_.]{1,20})/);
  return m ? m[1] : null;
}

// helper: ask Roblox for displayName (returns { id, name, displayName } or null)
async function lookupRobloxUsername(username) {
  try {
    const res = await axios.post(
      "https://users.roblox.com/v1/usernames/users",
      { usernames: [username], excludeBannedUsers: true },
      { headers: { "Content-Type": "application/json" }, timeout: 5000 }
    );

    if (res.data && Array.isArray(res.data.data) && res.data.data.length > 0) {
      const u = res.data.data[0];
      // u has { id, name, displayName, ... }
      return { id: u.id, name: u.name, displayName: u.displayName };
    }
  } catch (err) {
    // don't throw — caller will proceed without displayName
    console.warn("Roblox lookup failed for", username, err.message || err);
  }
  return null;
}

// Replace / update the upsertDonation function with something like this:
async function upsertDonation(payload) {
  // payload: { transaction_id, name (bagibagi_name), amount, message, created_at }
  const donorKey = `user:${payload.roblox_username ?? payload.name ?? "bagibagi:" + payload.transaction_id}`;

  // prefer: if payload includes something identifying (bagibagi provides a name, and we detect @username)
  const bagibagiName = payload.name || payload.bagibagi_name || null;
  const amount = Number(payload.amount || 0);
  const lastMsg = payload.message || null;
  const lastTime = payload.created_at ? new Date(payload.created_at).toISOString() : new Date().toISOString();

  // extract @username from message if present
  const atUsername = extractAtUsername(lastMsg);

  // Attempt to reuse cached displayName if a row exists for this donor_key
  let cached = null;
  try {
    const sel = await pool.query(`SELECT roblox_username, roblox_display_name FROM donations WHERE donor_key = $1 LIMIT 1`, [donorKey]);
    if (sel.rows && sel.rows.length > 0) cached = sel.rows[0];
  } catch (err) {
    console.warn("DB select cached error:", err.message || err);
  }

  let robloxUsernameToStore = null;
  let robloxDisplayNameToStore = null;
  let robloxUserId = null;

  if (atUsername) {
    // prefer the username from the message
    robloxUsernameToStore = atUsername;

    // if cached displayName exists for same username, reuse
    if (cached && cached.roblox_username === robloxUsernameToStore && cached.roblox_display_name) {
      robloxDisplayNameToStore = cached.roblox_display_name;
    } else {
      // lookup Roblox API
      const info = await lookupRobloxUsername(robloxUsernameToStore);
      if (info) {
        robloxDisplayNameToStore = info.displayName || null;
        robloxUserId = info.id || null;
      } else {
        // fallback: store the username but no displayName
        robloxDisplayNameToStore = null;
      }
    }
  } else {
    // No @username found: keep roblox fields null (we only have bagibagi_name)
    // Optionally you could attempt to match bagibagi_name -> roblox but that is not reliable
    robloxUsernameToStore = null;
    robloxDisplayNameToStore = null;
  }

  // Now perform UPSERT into donations table. Adjust column names if yours differ.
  // Use integer for amounts (total_rp is expected to be int8 in your DB)
  try {
    // Upsert: insert or update totals
    // We'll add last_message, last_time, last_donation_rp, bagibagi_name, roblox_username, roblox_display_name
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

    // If we want to add incoming donation amount to existing total, we need to set total_rp appropriately.
    // Here we supply total_rp as current donation amount for the EXCLUDED row; the ON CONFLICT uses existing donation.total_rp + EXCLUDED.last_donation_rp
    const params = [
      donorKey,
      robloxUsernameToStore,
      robloxDisplayNameToStore,
      bagibagiName,
      amount,      // used as EXCLUDED.total_rp (will be treated as last_donation_rp for initial insert)
      amount,      // last_donation_rp
      lastMsg,
      lastTime
    ];

    const res = await pool.query(q, params);
    return res.rows[0];
  } catch (err) {
    console.error("DB upsert error:", err);
    throw err;
  }
}
