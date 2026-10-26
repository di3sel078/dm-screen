// Load Express and Node's built-in helpers
const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
// Shared D&D rules (same file the DM page uses)
const R = require("./private/rules.js");
const app = express();
// Port and save folder can be overridden (used for testing); the defaults are what you normally want
const port = process.env.PORT || 3000;

// ---------- DM password ----------

// Read the DM password from the environment, never from the code
const DM_PASSWORD = process.env.DM_PASSWORD;
if (!DM_PASSWORD) {
  console.error("No DM password set. Start the server with one of these:");
  console.error("  DM_PASSWORD=yourpassword node app.js");
  console.error("  node --env-file=.env app.js   (with DM_PASSWORD=yourpassword in .env)");
  process.exit(1);
}

// Login sessions last this long
const SESSION_MS = 12 * 60 * 60 * 1000;

// Failed login limit per address
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

// Logged-in tokens: token -> expiry time
const sessions = new Map();

// Failed logins: address -> { fails, lockedUntil }
const failedLogins = new Map();

// Password lock. When it is off, the DM page opens without a password, so only
// turn it off on a network you trust (like home). It is saved, so it stays off
// after a restart until you turn it back on in Settings.
let locked = true;

// Compare two strings without leaking timing information
function safeEqual(a, b) {
  // Hash both so they are the same length, as timingSafeEqual requires
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Read one cookie value from the request
function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";");
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      return rest.join("=");
    }
  }
  return null;
}

// Check if the request has a valid login token
function hasValidToken(req) {
  const token = getCookie(req, "dm_token");
  if (!token || !sessions.has(token)) {
    return false;
  }
  if (sessions.get(token) < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Logged in, or the password lock is off
function isLoggedIn(req) {
  return !locked || hasValidToken(req);
}

// Block DM-only requests that are not logged in
function requireDm(req, res, next) {
  if (isLoggedIn(req)) {
    return next();
  }
  // API calls get an error, pages get sent to the login form
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(401).json({ error: "Not logged in" });
  }
  res.redirect("/login.html");
}

// ---------- Saved DM data (library, encounters, settings) ----------

// Saved to a file so it survives restarts and is shared by every DM device
const SAVE_DIR = process.env.DM_SAVE_DIR || path.join(__dirname, "saves");
const SAVE_FILE = path.join(SAVE_DIR, "state.json");

// rev goes up by one on every save, so a device can tell if it is out of date
let saved = { rev: 0, savedAt: 0, state: null };

// The lock setting lives in its own small file next to the saved data
const SETTINGS_FILE = path.join(SAVE_DIR, "settings.json");

function loadSettings() {
  try {
    const file = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    locked = file.locked !== false;
  } catch {
    locked = true;
  }
  if (!locked) {
    console.warn("WARNING: the password lock is OFF. Anyone who can reach this server can open the DM page.");
    console.warn("Turn it back on in the DM page Settings.");
  }
}

function saveSettings() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ locked }));
}
loadSettings();

// Read the save file at startup. A broken file is kept aside, never overwritten.
function loadSaved() {
  let text;
  try {
    text = fs.readFileSync(SAVE_FILE, "utf8");
  } catch {
    return;
  }
  try {
    const file = JSON.parse(text);
    saved = {
      rev: Number.isInteger(file.rev) ? file.rev : 1,
      savedAt: Number(file.savedAt) || 0,
      state: R.migrateState(file.state),
    };
    // Keep a copy of what we started from, in case something goes wrong later
    fs.writeFileSync(SAVE_FILE + ".bak", text);
  } catch (err) {
    console.error("Could not read saves/state.json, starting empty:", err.message);
    fs.writeFileSync(SAVE_FILE + ".broken", text);
  }
}

// Write the save file one at a time, through a temp file so a crash cannot half-write it
let writeQueue = Promise.resolve();
function writeSaved() {
  const text = JSON.stringify({ rev: saved.rev, savedAt: saved.savedAt, state: saved.state });
  writeQueue = writeQueue
    .then(async () => {
      await fs.promises.mkdir(SAVE_DIR, { recursive: true });
      await fs.promises.writeFile(SAVE_FILE + ".tmp", text);
      await fs.promises.rename(SAVE_FILE + ".tmp", SAVE_FILE);
    })
    .catch((err) => console.error("Could not write saves/state.json:", err.message));
  return writeQueue;
}

// ---------- Encounter state (in memory) ----------

// The encounter the DM has open, as sent by the DM page. null when none.
let activeEncounter = null;

// The encounter clock as the DM page last reported it: time shown then, whether it
// is running, and when we heard (our own clock, so device clocks never need to agree).
let clockSync = null;

// After a restart, bring back the open encounter from the save so the player display is not blank
loadSaved();
if (saved.state) {
  const open = saved.state.encounters.find((e) => e.id === saved.state.ui.activeEncounterId);
  activeEncounter = open ? { ...open, log: [] } : null;
  // Time banked before the restart; the DM page sets the running clock again when it reconnects
  clockSync = open ? { ms: open.clock.elapsedMs, running: false, at: Date.now() } : null;
}

// Player-safe view of the open encounter, built field by field by rules.js.
// Never contains enemy HP, stats, or any notes.
function getPlayerState() {
  if (!activeEncounter) {
    return null;
  }
  const view = R.playerProjection({
    encounters: [activeEncounter],
    ui: { activeEncounterId: activeEncounter.id },
  });
  // Add the vague bar width for each enemy band
  for (const c of view.combatants) {
    if (c.type === "enemy") {
      c.bar = R.HEALTH_BAND_BARS[c.band];
    }
  }
  // The players only see the time, ticking on from the last report while it runs
  view.clock = clockSync
    ? { ms: clockSync.ms + (clockSync.running ? Date.now() - clockSync.at : 0), running: clockSync.running }
    : null;
  return view;
}

// ---------- Live updates to the player page (Server-Sent Events) ----------

const MAX_PLAYER_CLIENTS = 20;
const playerClients = new Set();

// Send player-safe state to one open connection
function sendPlayerState(res) {
  res.write(`data: ${JSON.stringify(getPlayerState())}\n\n`);
}

// Send the new state to every player display
function broadcast() {
  for (const res of playerClients) {
    sendPlayerState(res);
  }
}

// Keep idle connections alive with a comment line every 25 seconds
setInterval(() => {
  for (const res of playerClients) {
    res.write(": ping\n\n");
  }
}, 25000);

// ---------- Middleware ----------

// Parse JSON bodies (DM API, encounters can be large). The saved DM data is
// bigger, so /api/state gets its own parser below, after the login check.
const jsonBody = express.json({ limit: "1mb" });
app.use((req, res, next) => (req.path === "/api/state" ? next() : jsonBody(req, res, next)));
app.use(express.urlencoded({ extended: false }));

// With the lock off there is nothing to log in to
app.get("/login.html", (req, res, next) => (locked ? next() : res.redirect("/dm.html")));

// Serve the public folder (player page, login page, shared CSS)
app.use(express.static(path.join(__dirname, "public")));

// ---------- Login and logout ----------

app.post("/login", (req, res) => {
  const address = req.ip;
  const record = failedLogins.get(address) || { fails: 0, lockedUntil: 0 };

  // Refuse while this address is locked out
  if (record.lockedUntil > Date.now()) {
    return res.redirect("/login.html?error=locked");
  }

  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";

  if (!safeEqual(password, DM_PASSWORD)) {
    // Count the failure and lock out after too many
    record.fails += 1;
    if (record.fails >= MAX_FAILED_LOGINS) {
      record.fails = 0;
      record.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    failedLogins.set(address, record);
    return res.redirect("/login.html?error=wrong");
  }

  // Correct password: clear failures and create a random token
  failedLogins.delete(address);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_MS);

  // HttpOnly hides the cookie from page scripts, SameSite blocks other sites
  res.setHeader(
    "Set-Cookie",
    `dm_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`
  );
  res.redirect("/dm.html");
});

app.post("/logout", (req, res) => {
  const token = getCookie(req, "dm_token");
  if (token) {
    sessions.delete(token);
  }
  res.setHeader("Set-Cookie", "dm_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.redirect("/login.html");
});

// ---------- DM page and its files (login required) ----------

// Stop the browser from caching DM files
function noStore(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

app.get("/dm.html", requireDm, noStore, (req, res) => {
  res.sendFile(path.join(__dirname, "private", "dm.html"));
});

// Scripts and styles for the DM page
app.use("/dm-assets", requireDm, noStore, express.static(path.join(__dirname, "private")));

// Search and filter icons used by the DM page
app.use("/dm-icons", requireDm, express.static(path.join(__dirname, "assets")));

// ---------- Player live stream (open, player-safe only) ----------

app.get("/events", (req, res) => {
  if (playerClients.size >= MAX_PLAYER_CLIENTS) {
    return res.status(503).end();
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send the current state right away, then on every change
  sendPlayerState(res);
  playerClients.add(res);

  // Forget the connection when the display closes
  req.on("close", () => {
    playerClients.delete(res);
  });
});

// ---------- DM API (login required for everything under /api) ----------

app.use("/api", requireDm);

// The saved DM data can be big (many creatures and logs), so it gets a higher limit
app.use("/api/state", express.json({ limit: "20mb" }));

// The DM page sends its open encounter after every change
app.post("/api/encounter", (req, res) => {
  const body = req.body || {};
  const enc = body.encounter;

  // The DM page reports the clock already worked out, so its device clock does not matter here
  const clock = body.clock;
  clockSync =
    enc && clock && Number.isFinite(clock.ms)
      ? { ms: Math.max(0, clock.ms), running: !!clock.running, at: Date.now() }
      : null;

  if (enc === null) {
    // No encounter open
    activeEncounter = null;
  } else if (typeof enc === "object" && !Array.isArray(enc)) {
    // Clean up every field the same way the DM page does
    activeEncounter = R.normalizeEncounter(enc);
  } else {
    return res.status(400).json({ error: "Encounter must be an object or null." });
  }

  broadcast();
  res.json({ ok: true });
});

// Password lock: read it, or turn it on or off (needs login while the lock is on)
app.get("/api/lock", (req, res) => {
  res.json({ locked, signedIn: hasValidToken(req) });
});

app.post("/api/lock", (req, res) => {
  if (typeof (req.body || {}).locked !== "boolean") {
    return res.status(400).json({ error: "locked must be true or false." });
  }
  locked = req.body.locked;
  try {
    saveSettings();
  } catch (err) {
    console.error("Could not write settings.json:", err.message);
  }
  res.json({ locked, signedIn: hasValidToken(req) });
});

// The DM page loads its saved data from here when it opens
app.get("/api/state", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(saved);
});

// The DM page saves its data here after changes. baseRev is the version it last saw;
// if another device saved since, the server refuses and sends its copy back instead.
app.put("/api/state", async (req, res) => {
  const body = req.body || {};
  if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
    return res.status(400).json({ error: "State must be an object." });
  }
  if (saved.state && !body.force && body.baseRev !== saved.rev) {
    return res.status(409).json({ error: "conflict", ...saved });
  }

  // Clean it up the same way the DM page does before keeping it
  let clean;
  try {
    clean = R.migrateState(body.state);
  } catch {
    return res.status(400).json({ error: "Could not read that state." });
  }
  saved = { rev: saved.rev + 1, savedAt: Date.now(), state: clean };
  await writeSaved();
  res.json({ ok: true, rev: saved.rev, savedAt: saved.savedAt });
});

// Reply with a short JSON error instead of a stack trace
app.use((err, req, res, next) => {
  if (err.status) {
    return res.status(err.status).json({ error: "Bad request." });
  }
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

// Start the server
app.listen(port, () => {
  console.log(`Tracker running at http://localhost:${port}`);
  console.log(`DM page: http://localhost:${port}/dm.html`);
});
