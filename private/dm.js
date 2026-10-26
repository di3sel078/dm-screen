/* ==========================================================================
   DM Dashboard — Application Logic
   Rules (math, normalisation, migration, dice) live in rules.js as DMRules.
   Sections:
     1. Constants & utilities
     2. State & storage (load/migrate, save, commit, undo, log)
     3. Domain helpers (combatants, HP, turns, rests, clock)
     4. Rendering
     5. Dialogs (toast, prompt, confirm, choice, creature builder, detail, picker)
     6. Event wiring
     7. Boot
   ========================================================================== */

(() => {
  "use strict";

  /* ======================================================================
     1. Constants & utilities
     ====================================================================== */

  const R = window.DMRules;
  const {
    STAT_KEYS,
    STAT_NAMES,
    SKILLS,
    SKILL_BY_KEY,
    CONDITIONS,
    CONDITION_EFFECTS,
    CLASSES,
    CREATURE_TYPES,
    creatureTypeOf,
    CR_OPTIONS,
    DAMAGE_TYPES,
    uuid,
    toInt,
    clamp,
    modifier,
    formatMod,
    formatNum,
    profFromCr,
    profFromLevel,
    rechargeLabel,
    initBonusOf,
    skillBonus,
    saveBonus,
    normalizeAttack,
    normalizeTemplate,
    normalizeEncounter,
    normalizeInstance,
    instantiate,
    makeLair,
    uniqueName,
    sortEncounter,
  } = R;

  const STORAGE_KEY = "dm-dashboard-state-v2";
  const LEGACY_STORAGE_KEY = "dm-dashboard-state-v1";
  const SCHEMA_VERSION = 2;
  const UNDO_LIMIT = 30;
  const SRD = window.DM_SRD_STARTER || null;
  /** How long to wait after a change before sending it to the player display. */
  const SYNC_DELAY_MS = 150;
  const LEVEL_LABEL = { 1: "1st", 2: "2nd", 3: "3rd" };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const svg = (body, size = 15) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON_TRASH = svg(
    `<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/>`,
  );
  const ICON_EDIT = svg(
    `<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`,
  );
  const ICON_EXPAND = svg(`<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>`);
  const ICON_PLAY = svg(
    `<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>`,
    14,
  );
  const ICON_PAUSE = svg(
    `<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/>`,
    14,
  );
  const ICON_COPY = svg(
    `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`,
  );
  const ICON_VARIANT = svg(
    `<path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9"/>`,
  );
  const ICON_EYE = svg(
    `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  );
  const ICON_EYE_OFF = svg(
    `<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>`,
  );
  const ICON_LOCK = svg(
    `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
  );
  const ICON_UNLOCK = svg(
    `<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>`,
  );
  const ICON_SAVE = svg(`<path d="M6 3h12v18l-6-4-6 4z"/>`);

  const escapeHtml = (str) =>
    String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const ordinal = (n) => LEVEL_LABEL[n] || `${n}th`;
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const baseName = (name) => name.replace(/\s+\d+$/, "");

  /** "1d6+2 slashing" */
  function damageText(atk) {
    const bonus = toInt(atk.dmgBonus, 0);
    const signed =
      bonus > 0 ? `+${bonus}` : bonus < 0 ? `−${Math.abs(bonus)}` : "";
    const roll = atk.dmgDice
      ? `${atk.dmgDice}${signed}`
      : bonus
        ? String(bonus)
        : "";
    return [roll, atk.dmgType].filter(Boolean).join(" ");
  }

  /* ======================================================================
     2. State & storage
     ====================================================================== */

  let state = R.defaultState();

  const storageGet = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  /**
   * v2 if present; otherwise migrate v1 through the normalizers and write it
   * as v2. The v1 key is never touched, so it stays as a backup.
   */
  function loadState() {
    const raw = storageGet(STORAGE_KEY);
    const legacy = raw ? null : storageGet(LEGACY_STORAGE_KEY);
    if (!raw && !legacy) return R.defaultState();
    try {
      const migrated = R.migrateState(JSON.parse(raw || legacy));
      if (legacy) {
        state = migrated;
        saveState();
      }
      return migrated;
    } catch (err) {
      console.warn("Could not read saved state, starting fresh.", err);
      return R.defaultState();
    }
  }

  const serializeState = () =>
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      savedAt: Date.now(),
      serverRev,
      ...state,
    });

  let lastSavedAt = null;
  let saveError = null;
  let quotaWarned = false;

  /* ---------- Server save ----------
     The server keeps a copy of the library and encounters in a file, so they
     survive a restart and are shared by every DM device. This browser's copy
     stays as a cache. serverRev is the server version this device last saw. */
  const PUSH_DELAY_MS = 800;
  const PUSH_RETRY_MS = 10000;
  let serverRev = null;
  let serverReady = false;
  let serverOffline = false;
  let lastSyncedSig = null;
  let pushTimer = null;
  let pushing = false;
  let pushForce = false;

  /** Only the shared data goes to the server. Filters and view settings stay per device. */
  const dataPayload = () => ({
    creatureLibrary: state.creatureLibrary,
    encounters: state.encounters,
    ui: { activeEncounterId: state.ui.activeEncounterId },
  });
  const dataSignature = () => JSON.stringify(dataPayload());

  const isQuotaError = (err) =>
    !!err &&
    (err.name === "QuotaExceededError" ||
      err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      err.code === 22 ||
      err.code === 1014);

  function saveState() {
    // The player display updates even if browser storage fails
    syncPlayerDisplay();
    writeLocal();
    // Send to the server only when the shared data changed (not for filters or view settings)
    if (serverReady && dataSignature() !== lastSyncedSig) queuePush();
    renderSaved();
    snapshotActive();
  }

  /** Save this device's copy in the browser. */
  function writeLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, serializeState());
      lastSavedAt = Date.now();
      saveError = null;
      quotaWarned = false;
    } catch (err) {
      console.error("Could not persist state.", err);
      saveError = isQuotaError(err) ? "quota" : "other";
      if (saveError === "quota" && !quotaWarned) {
        quotaWarned = true;
        toast(
          "Browser storage is full, so changes are not being saved. Export a backup now, then delete old encounters or clear combat logs to free space.",
          { action: { label: "Export", run: exportData }, sticky: true },
        );
      } else if (saveError === "other") {
        toast(
          "Could not save to browser storage. Export a backup to be safe.",
          { action: { label: "Export", run: exportData } },
        );
      }
    }
  }

  function queuePush({ force = false } = {}) {
    pushForce = pushForce || force;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushState, PUSH_DELAY_MS);
  }

  /** Send the shared data to the server. The server refuses if another device saved first. */
  async function pushState() {
    if (!serverReady) return;
    if (pushing) {
      queuePush();
      return;
    }
    pushing = true;
    const sig = dataSignature();
    const force = pushForce;
    pushForce = false;
    let res = null;
    try {
      res = await fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: dataPayload(),
          baseRev: serverRev,
          force,
        }),
      });
    } catch {
      res = null;
    }
    pushing = false;

    if (res && res.status === 401) {
      location.href = "/login.html";
      return;
    }
    if (res && res.ok) {
      const out = await res.json();
      serverRev = out.rev;
      lastSyncedSig = sig;
      serverOffline = false;
      writeLocal();
      // More changes came in while sending
      if (dataSignature() !== lastSyncedSig) queuePush();
    } else if (res && res.status === 409) {
      resolveConflict(await res.json());
    } else {
      // Server not reachable: keep working, try again soon
      serverOffline = true;
      pushForce = pushForce || force;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushState, PUSH_RETRY_MS);
    }
    renderSaved();
  }

  const isEmptyData = (st) =>
    !st.creatureLibrary.pcs.length &&
    !st.creatureLibrary.enemies.length &&
    !st.encounters.length;

  /** Replace this device's data with the server's copy. The old copy is kept in the browser. */
  function adoptRemote(remote) {
    try {
      localStorage.setItem(`${STORAGE_KEY}-backup`, serializeState());
    } catch {
      /* storage may be full */
    }
    const incoming = R.migrateState(remote.state);
    // View settings stay as they are on this device; the open encounter follows the server
    incoming.ui = {
      ...state.ui,
      activeEncounterId: incoming.ui.activeEncounterId,
    };
    state = incoming;
    state.encounters.forEach(sortEncounter);
    serverRev = remote.rev;
    lastSyncedSig = dataSignature();
    undoStack.length = 0;
    snapshotActive();
    writeLocal();
    renderAll();
    syncPlayerDisplay();
  }

  /** The server has a version this device has not seen. Ask which copy to keep. */
  function resolveConflict(remote) {
    serverOffline = false;
    const useServer = confirm(
      "The server has data saved from another device (or an older visit) that differs from this device.\n\n" +
        "OK: load the server's copy here. This device's copy is kept as a backup in this browser.\n" +
        "Cancel: replace the server's copy with this device's.",
    );
    if (useServer) {
      adoptRemote(remote);
      toast(
        "Loaded the server's copy. The previous copy on this device is kept as a backup.",
      );
    } else {
      serverRev = remote.rev;
      queuePush({ force: true });
    }
  }

  /** On open: compare with the server and sync up. */
  async function pullFromServer() {
    let res = null;
    try {
      res = await fetch("/api/state", { cache: "no-store" });
    } catch {
      res = null;
    }
    if (res && res.status === 401) {
      location.href = "/login.html";
      return;
    }
    serverReady = true;
    if (!res || !res.ok) {
      serverOffline = true;
      renderSaved();
      queuePush();
      return;
    }
    const remote = await res.json();
    if (!remote.state || isEmptyData(R.migrateState(remote.state))) {
      // Nothing useful on the server yet: upload what this device has (if anything)
      serverRev = remote.rev || null;
      if (!isEmptyData(state)) queuePush({ force: true });
      renderSaved();
      return;
    }
    const remoteSig = JSON.stringify({
      creatureLibrary: remote.state.creatureLibrary,
      encounters: remote.state.encounters,
      ui: { activeEncounterId: remote.state.ui.activeEncounterId },
    });
    if (remoteSig === dataSignature()) {
      serverRev = remote.rev;
      lastSyncedSig = remoteSig;
      writeLocal();
    } else if (remote.rev === serverRev) {
      // Same version as last time, so these are edits made while the server was unreachable
      queuePush();
    } else if (isEmptyData(state)) {
      adoptRemote(remote);
    } else {
      resolveConflict(remote);
    }
    renderSaved();
  }

  /* ---------- Player display sync ----------
     After a change, send the active encounter to the server. The server builds
     the player-safe view itself and pushes it to the player display. Changes
     that land close together are sent once. */
  let syncTimer = null;
  let syncWarned = false;

  function syncPlayerDisplay() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sendActiveEncounter, SYNC_DELAY_MS);
  }

  async function sendActiveEncounter() {
    const enc = activeEncounter();
    // The combat log never reaches the players, so leave it out
    // The clock goes along already worked out, so the player display can show it
    const body = {
      encounter: enc ? { ...enc, log: [] } : null,
      clock: enc ? { ms: clockElapsed(enc), running: clockRunning(enc) } : null,
    };
    let res = null;
    try {
      res = await fetch("/api/encounter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      res = null;
    }
    // Login expired: go back to the login page (the encounter is safe in this browser)
    if (res && res.status === 401) {
      location.href = "/login.html";
      return;
    }
    if (res && res.ok) {
      syncWarned = false;
      return;
    }
    // Warn once until a send works again
    if (!syncWarned) {
      syncWarned = true;
      toast(
        "The player display did not update. Check that the server is running.",
      );
    }
  }

  /* ---------- Undo ----------
     After every save we keep a JSON copy of the active encounter. An undoable
     commit pushes that copy (the state before this mutation) onto the stack. */
  let lastSnapshot = null;
  const undoStack = [];

  function snapshotActive() {
    const enc = activeEncounter();
    lastSnapshot = enc ? { id: enc.id, json: JSON.stringify(enc) } : null;
  }

  /** Persist, then repaint. Every mutation funnels through here. */
  function commit({ undo = null } = {}) {
    if (undo && lastSnapshot) {
      undoStack.push({ ...lastSnapshot, label: undo });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    saveState();
    renderAll();
  }

  function undo() {
    while (undoStack.length) {
      const entry = undoStack.pop();
      const idx = state.encounters.findIndex((e) => e.id === entry.id);
      if (idx < 0) continue;
      const restored = normalizeEncounter(JSON.parse(entry.json));
      // The clock keeps running in real time; undo never rewinds it.
      restored.clock = state.encounters[idx].clock;
      state.encounters[idx] = restored;
      toast(`Undone: ${entry.label}`);
      saveState();
      renderAll();
      return true;
    }
    toast("Nothing to undo.");
    return false;
  }

  const libraryList = (type) =>
    type === "pc" ? state.creatureLibrary.pcs : state.creatureLibrary.enemies;
  const findTemplate = (id) =>
    state.creatureLibrary.pcs.find((t) => t.id === id) ||
    state.creatureLibrary.enemies.find((t) => t.id === id) ||
    null;
  const templateType = (id) =>
    state.creatureLibrary.pcs.some((t) => t.id === id) ? "pc" : "enemy";
  const findEncounter = (id) =>
    state.encounters.find((e) => e.id === id) || null;
  const activeEncounter = () => findEncounter(state.ui.activeEncounterId);
  const findCombatant = (id) =>
    activeEncounter()?.combatants.find((c) => c.instanceId === id) || null;

  /**
   * Record rule events in the encounter's log and toast them. Turn changes
   * are logged but not toasted; the banner already says it.
   */
  function announce(events, { enc = activeEncounter(), quiet = false } = {}) {
    (events || []).forEach((ev) => {
      if (enc) R.pushLog(enc, ev.kind, ev.text);
      if (!quiet && ev.kind !== "turn") toast(ev.text);
    });
  }
  const logEntry = (kind, text, enc = activeEncounter()) => {
    if (enc) R.pushLog(enc, kind, text);
  };

  /* ======================================================================
     3. Domain helpers
     ====================================================================== */

  /** Last choice of "Start hidden from the players" in the add dialogs (kept until the page reloads). */
  const startHidden = { pc: false, enemy: false };

  function addCombatantsFromTemplate(
    enc,
    templateId,
    initiative,
    count,
    hidden = false,
    asGroup = false,
  ) {
    const template = findTemplate(templateId);
    if (!template) return 0;
    const type = templateType(templateId);
    // A PC can only be in an encounter once
    if (type === "pc" && R.duplicatePc(enc, templateId, template.name)) {
      toast(`${template.name} is already in this encounter.`);
      return 0;
    }
    const n = type === "pc" ? 1 : clamp(toInt(count, 1), 1, 20);
    // Several enemies added together can be one group: shared initiative and stat block
    const groupId = asGroup && type === "enemy" && n > 1 ? uuid() : null;
    for (let i = 0; i < n; i++) {
      const inst = instantiate(template, type, initiative, templateId);
      // The DM types the d20 roll; the initiative bonus is added here
      inst.initiative = toInt(initiative, 0) + initBonusOf(inst);
      inst.name = uniqueName(enc, template.name);
      inst.hidden = hidden;
      inst.groupId = groupId;
      enc.combatants.push(inst);
    }
    sortEncounter(enc);
    logEntry(
      "info",
      `${n === 1 ? template.name : `${n} × ${template.name}${groupId ? " (group)" : ""}`} joined the encounter${hidden ? ", hidden from the players" : ""}.`,
      enc,
    );
    return n;
  }

  /** More enemies for an existing group: copies of its stat block at full HP, sharing its initiative. */
  function addToGroup(enc, lead, count) {
    const n = clamp(toInt(count, 1), 1, 20);
    const block = R.templateFromInstance(lead);
    for (let i = 0; i < n; i++) {
      const inst = instantiate(
        block,
        "enemy",
        lead.initiative,
        lead.templateId,
      );
      inst.name = uniqueName(enc, baseName(lead.name));
      inst.initRank = lead.initRank;
      inst.groupId = lead.groupId;
      inst.hidden = lead.hidden;
      enc.combatants.push(inst);
    }
    sortEncounter(enc);
    logEntry("info", `${n} × ${baseName(lead.name)} added to the group.`, enc);
    return n;
  }

  /* ---------- HP ---------- */
  /** Tell screen readers when a creature crosses an HP band (Hurt, Bloodied, Down…). */
  function sayHpBand(c, before) {
    const after = hpStateLabel(c);
    if (after !== before)
      liveSay(`${c.name} is now ${after}, ${c.hp.current} of ${c.hp.max} HP.`);
  }

  function damageCombatant(c, amount, { crit = false, type = "" } = {}) {
    const band = hpStateLabel(c);
    const r = R.applyDamage(c, amount, { crit, type });
    sayHpBand(c, band);
    const parts = [
      `${c.name} takes ${r.amount}${r.defense ? ` (${r.note})` : type ? ` ${type}` : ""}`,
    ];
    if (r.result.absorbedByTemp)
      parts.push(`${r.result.absorbedByTemp} absorbed by temp HP`);
    if (crit) parts.push("critical hit");
    const summary = parts.join(", ") + ".";
    toast(summary);
    logEntry("damage", summary);
    announce(r.events);
  }

  function healCombatant(c, amount) {
    if (R.isDead(c)) {
      toast(
        `${c.name} is dead. Healing has no effect; set HP directly if they are revived.`,
      );
      return false;
    }
    const band = hpStateLabel(c);
    const { result, events } = R.applyHealing(c, amount);
    sayHpBand(c, band);
    const summary = result.healed
      ? `${c.name} regains ${result.healed} HP${result.healed < amount ? ` (capped at max ${c.hp.max})` : ""}.`
      : `${c.name} is already at max HP.`;
    toast(summary);
    if (result.healed) logEntry("heal", summary);
    announce(events);
    return result.healed > 0;
  }

  function grantTemp(c, amount) {
    const r = R.grantTempHp(c, amount);
    const msg = r.applied
      ? `${c.name} gains ${r.value} temp HP.`
      : `${c.name} keeps ${r.previous} temp HP; the new ${r.value} was ignored (temp HP doesn't stack).`;
    toast(msg);
    if (r.applied) logEntry("heal", msg);
    return r.applied;
  }

  /* ---------- Encounter clock ---------- */
  const clockElapsed = (enc) =>
    enc.clock.elapsedMs +
    (enc.clock.startedAt ? Date.now() - enc.clock.startedAt : 0);
  const clockRunning = (enc) => !!enc.clock.startedAt;

  function startClock(enc) {
    if (!enc.clock.startedAt) enc.clock.startedAt = Date.now();
  }
  function pauseClock(enc) {
    if (!enc.clock.startedAt) return;
    enc.clock.elapsedMs = clockElapsed(enc);
    enc.clock.startedAt = null;
  }
  function resetClock(enc) {
    enc.clock = { elapsedMs: 0, startedAt: null };
  }

  function formatClock(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  /* ---------- Turn order ---------- */
  let roundBump = false;
  // Set by Next/Prev Turn: after the next repaint, scroll to whoever's turn it is
  let followTurn = false;
  const scrollBehavior = () => (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  function nextTurn(enc) {
    if (!enc.combatants.length) return;
    // The first Next Turn of a fresh encounter starts the clock.
    if (!clockRunning(enc) && enc.clock.elapsedMs === 0) startClock(enc);
    const { events, newRound } = R.nextTurn(enc);
    if (newRound) roundBump = true;
    followTurn = true;
    announce(events, { enc });
  }

  function prevTurn(enc) {
    const { events, newRound } = R.prevTurn(enc);
    if (newRound) roundBump = true;
    followTurn = true;
    announce(events, { enc });
  }

  function removeCombatant(enc, combatant) {
    const removedIdx = enc.combatants.indexOf(combatant);
    if (removedIdx < 0) return;
    enc.combatants.splice(removedIdx, 1);
    R.tidyGroups(enc);
    if (removedIdx < enc.currentTurnIndex) enc.currentTurnIndex -= 1;
    else if (
      removedIdx === enc.currentTurnIndex &&
      removedIdx >= enc.combatants.length
    )
      enc.currentTurnIndex = 0;
    sortEncounter(enc);
    logEntry("info", `${combatant.name} left the encounter.`, enc);
  }

  /* ---------- Data: export, import, starter content ---------- */
  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportData() {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadJson(R.exportPayload(state), `dm-dashboard-${stamp}.json`);
    toast("Exported all data as JSON.");
  }

  /** Swap in imported data; nothing is touched until the DM has confirmed. */
  function applyImport(data, mode) {
    if (mode === "replace") {
      state.creatureLibrary = data.creatureLibrary;
      state.encounters = data.encounters;
      if (!findEncounter(state.ui.activeEncounterId))
        state.ui.activeEncounterId = null;
      // Old snapshots point at encounters that no longer exist.
      undoStack.length = 0;
      seenCards.clear();
    } else {
      R.mergeImport(state, data);
    }
    commit();
  }

  function addStarterMonsters() {
    if (!SRD) return;
    const added = SRD.MONSTERS.map((m) => ({
      ...normalizeTemplate(R.clone(m), "enemy"),
      id: uuid(),
    }));
    state.creatureLibrary.enemies.push(...added);
    toast(`Added ${added.length} SRD monsters to the library.`);
    commit();
  }

  /**
   * Save a combatant's stat block to the library ("Goblin 2" saves as "Goblin").
   * If it came from a library entry that still exists, the DM picks update or new.
   */
  async function saveCombatantToLibrary(c) {
    const block = R.templateFromInstance(c);
    block.name = baseName(block.name) || block.name;
    const existing = c.templateId ? findTemplate(c.templateId) : null;
    let mode = "new";
    if (existing) {
      mode = await choiceDialog({
        title: `Save ${c.name} to the library`,
        text: `${c.name} came from the library entry "${existing.name}".`,
        options: [
          {
            label: `Update "${existing.name}"`,
            hint: "Replace its stat block with this one",
            value: "update",
          },
          {
            label: "Save as a new entry",
            hint: "Keep the old entry as well",
            value: "new",
          },
        ],
      });
      if (!mode) return;
    }
    if (mode === "update") {
      Object.assign(existing, block, { id: existing.id });
      toast(`${existing.name} updated in the library.`);
    } else {
      const t = { ...block, id: uuid() };
      libraryList(c.type).push(t);
      c.templateId = t.id;
      toast(`${t.name} saved to the library.`);
    }
    commit();
  }

  /** The player display is the server's open page at "/". */
  function openPlayerWindow() {
    const url = "/";
    const win = window.open(url, "dm-screen-player");
    if (!win)
      toast(
        `Your browser blocked the window. Open ${url} in a new tab instead.`,
      );
  }

  /* ======================================================================
     4. Rendering
     ====================================================================== */

  function renderAll() {
    renderTabs();
    renderEncounterList();
    renderActiveEncounter();
    renderLibrary();
    renderDetail();
    renderLog();
  }

  function renderTabs() {
    $$(".tab").forEach((tab) => {
      const on = tab.dataset.view === state.ui.view;
      tab.classList.toggle("is-active", on);
      if (on) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    $$(".view").forEach((view) =>
      view.classList.toggle("is-active", view.dataset.view === state.ui.view),
    );
  }

  /* ---------- Encounter list ---------- */
  function renderEncounterList() {
    const host = $("#encounter-list");
    if (!state.encounters.length) {
      host.innerHTML = `
        <div class="empty-state empty-state--wide">
          <div class="empty-ornament" aria-hidden="true">✦</div>
          <h2 class="empty-title">No encounters yet</h2>
          <p>Every great battle begins with a name.</p>
        </div>`;
      return;
    }
    host.innerHTML = state.encounters
      .map((enc) => {
        const isOpen = enc.id === state.ui.activeEncounterId;
        const pcs = enc.combatants.filter((c) => c.type === "pc").length;
        const enemies = enc.combatants.filter((c) => c.type === "enemy").length;
        return `
        <article class="encounter-card ${isOpen ? "is-open" : ""}" data-encounter-id="${enc.id}">
          ${isOpen ? `<span class="badge-open">Open</span>` : ""}
          <h3 class="encounter-card-title">${escapeHtml(enc.name)}</h3>
          <div class="encounter-meta">
            <span>Round <strong>${enc.round}</strong></span>
            <span><strong>${pcs}</strong> PC${pcs === 1 ? "" : "s"}</span>
            <span><strong>${enemies}</strong> ${enemies === 1 ? "enemy" : "enemies"}</span>
            <span><strong>${formatClock(clockElapsed(enc))}</strong></span>
          </div>
          <div class="encounter-actions">
            <button class="btn btn-primary btn-sm" type="button" data-action="open-encounter">
              ${isOpen ? "Resume" : "Open"}
            </button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="rename-encounter">Rename</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="duplicate-encounter" title="Copy with the same combatants and initiative, reset to round 1 at full health">Duplicate</button>
            <span class="spacer"></span>
            <button class="icon-btn icon-btn--danger" type="button" data-action="delete-encounter" title="Delete encounter" aria-label="Delete encounter ${escapeHtml(enc.name)}">${ICON_TRASH}</button>
          </div>
        </article>`;
      })
      .join("");
  }

  /* ---------- Active encounter ---------- */

  /** Cards already shown for an encounter, so only newcomers play the entrance animation. */
  const seenCards = new Map();
  /** Per-card overrides of the collapsible stats section (instanceId → open). */
  const moreOpen = new Map();
  /** The damage type last chosen on each card, kept across re-renders. */
  const lastDamageType = new Map();

  /** A selector for the focused card control, so focus survives a full re-render. */
  function focusKey(grid) {
    const el = document.activeElement;
    const card = el?.closest?.("[data-instance-id]");
    if (!card || !grid.contains(card) || el === card) return null;
    const attrs = Object.entries(el.dataset)
      .map(
        ([k, v]) =>
          `[data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${String(v).replace(/"/g, '\\"')}"]`,
      )
      .join("");
    return attrs
      ? `[data-instance-id="${card.dataset.instanceId}"] ${attrs}`
      : null;
  }

  function renderActiveEncounter() {
    const enc = activeEncounter();
    $("#active-empty").classList.toggle("hidden", !!enc);
    $("#active-content").classList.toggle("hidden", !enc);
    if (!enc) return;

    $("#active-name").textContent = enc.name;
    renderClock();
    renderDifficulty(enc);

    const roundEl = $("#round-number");
    roundEl.textContent = enc.round;
    if (roundBump) {
      roundBump = false;
      roundEl.classList.remove("bump");
      void roundEl.offsetWidth; // restart animation
      roundEl.classList.add("bump");
    }

    const hasCombatants = enc.combatants.length > 0;
    $("#btn-next-turn").disabled = !hasCombatants;
    // Nothing comes before the first turn of round 1
    $("#btn-prev-turn").disabled = !hasCombatants || R.atFirstTurn(enc);
    $("#btn-reset-round").disabled = enc.round <= 1;
    $$("[data-card-mode]").forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String(b.dataset.cardMode === state.ui.cardMode),
      ),
    );

    const count = enc.combatants.length;
    $("#tracker-count").textContent = count
      ? `${count} in initiative order`
      : "";

    renderBanner(enc);

    const grid = $("#combatant-cards");
    if (!hasCombatants) {
      grid.innerHTML = `
        <div class="empty-state empty-state--wide">
          <div class="empty-ornament" aria-hidden="true">⚔</div>
          <h2 class="empty-title">The field is empty</h2>
          <p>Add player characters and enemies to begin rolling initiative.</p>
        </div>`;
      return;
    }
    grid.classList.toggle("is-compact", state.ui.cardMode === "compact");
    const refocus = focusKey(grid);
    const seen = seenCards.get(enc.id) || new Set();
    const firstPaint = !seenCards.has(enc.id);
    const cardAt = (c, i) =>
      renderCard(
        c,
        i === enc.currentTurnIndex,
        enc,
        !firstPaint && !seen.has(c.instanceId),
      );
    // Each group of enemies is drawn inside one box; its colour follows the group's order
    const groupIds = [
      ...new Set(enc.combatants.map((c) => c.groupId).filter(Boolean)),
    ];
    const html = [];
    for (let i = 0; i < enc.combatants.length; ) {
      const c = enc.combatants[i];
      if (!c.groupId) {
        html.push(cardAt(c, i));
        i += 1;
        continue;
      }
      const start = i;
      const members = [];
      while (
        i < enc.combatants.length &&
        enc.combatants[i].groupId === c.groupId
      ) {
        members.push(enc.combatants[i]);
        i += 1;
      }
      html.push(
        groupBoxHtml(
          members,
          enc,
          start,
          groupIds.indexOf(c.groupId),
          firstPaint,
          seen,
        ),
      );
    }
    grid.innerHTML = html.join("");
    seenCards.set(enc.id, new Set(enc.combatants.map((c) => c.instanceId)));
    $$(".card.is-sized", grid).forEach(fitCard);
    matchCardHeights();
    if (refocus) $(refocus)?.focus();
    if (followTurn) {
      followTurn = false;
      // Center the acting card (an enemy inside a group rather than the group's shared card)
      const acting = $(".card--member.is-current", grid) || $(".card.is-current", grid);
      acting?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    }
  }

  /**
   * Cards that have not been resized by hand all take the height of the tallest one,
   * so the Cards view lines up. The enemies inside a group match each other the same way.
   * The List view is left alone.
   */
  function matchCardHeights() {
    const grid = $("#combatant-cards");
    const evenOut = (cards) => {
      cards.forEach((c) => { c.style.minHeight = ""; });
      if (state.ui.cardMode === "compact" || cards.length < 2) return;
      const tallest = Math.max(...cards.map((c) => c.offsetHeight));
      cards.forEach((c) => { c.style.minHeight = `${tallest}px`; });
    };
    evenOut($$(".card:not(.is-sized):not(.card--lair)", grid).filter((c) => c.parentElement === grid));
    // Each group's enemies match the tallest enemy of that group (minimized rows stay short)
    $$(".group-box", grid).forEach((box) => {
      const members = $$(".card--member", box);
      if (box.classList.contains("is-min")) members.forEach((c) => { c.style.minHeight = ""; });
      else evenOut(members);
    });
  }
  let matchTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(matchTimer);
    matchTimer = setTimeout(() => { if (state.ui.view === "active") matchCardHeights(); }, 150);
  });

  /** The box around a group: its shared card on top, then one slim card per enemy. */
  function groupBoxHtml(
    members,
    enc,
    startIndex,
    colorIndex,
    firstPaint,
    seen,
  ) {
    const lead = members[0];
    const n = members.length;
    const anyCurrent = members.some(
      (_, i) => startIndex + i === enc.currentTurnIndex,
    );
    const isNew = (c) => !firstPaint && !seen.has(c.instanceId);
    // Groups start minimized; only the ones the DM expanded are remembered
    const minimized = !state.ui.expandedGroups.includes(lead.groupId);
    return `
      <section class="group-box ${minimized ? "is-min" : ""}" data-color="${colorIndex % 5}" aria-label="Group of ${n} ${escapeHtml(baseName(lead.name))}">
        <header class="group-box-head">
          <span class="group-box-name">Group</span>
          <span class="group-box-note">Shared initiative and stat block, separate HP</span>
          <button class="btn btn-ghost btn-sm" type="button" data-group-add="${lead.instanceId}" title="Add more of this enemy to the group">+ Add enemy</button>
          <button class="btn btn-ghost btn-sm" type="button" data-group-min="${lead.instanceId}" aria-pressed="${minimized}"
                  title="${minimized ? "Show full cards" : "Show only name and HP for each enemy"}">${minimized ? "Expand" : "Minimize"}</button>
          <button class="btn btn-ghost btn-sm" type="button" data-group-edit="${lead.instanceId}">Edit group</button>
          <button class="icon-btn icon-btn--danger" type="button" data-group-delete="${lead.instanceId}" title="Delete the whole group from the encounter" aria-label="Delete the ${escapeHtml(baseName(lead.name))} group">×</button>
        </header>
        ${renderCard(lead, anyCurrent, enc, false, "group", members)}
        ${members.map((m, i) => renderCard(m, startIndex + i === enc.currentTurnIndex, enc, isNew(m), "member")).join("")}
      </section>`;
  }

  /**
   * A resized card hides its least important parts until the rest fits.
   * Parts carry data-fit: lower numbers hide first. Initiative never hides,
   * then name (14), HP (13) and AC (12) are the last to go.
   */
  function fitCard(el) {
    const parts = $$("[data-fit]", el);
    parts.forEach((p) => p.classList.remove("fit-hidden"));
    if (!el.classList.contains("is-sized") || state.ui.cardMode === "compact")
      return;
    parts.sort((a, b) => toInt(a.dataset.fit, 0) - toInt(b.dataset.fit, 0));
    const overflowing = () =>
      el.scrollHeight > el.clientHeight + 1 ||
      el.scrollWidth > el.clientWidth + 1;
    for (const part of parts) {
      if (!overflowing()) break;
      part.classList.add("fit-hidden");
    }
  }

  function renderBanner(enc) {
    const banner = $("#turn-banner");
    if (!enc.combatants.length) {
      banner.innerHTML = "";
      return;
    }
    const cur = enc.combatants[enc.currentTurnIndex];
    const next = enc.combatants[R.nextActorIndex(enc)];
    const status = vitalStatus(cur);
    const unconscious =
      cur.type !== "lair" &&
      R.hasCondition(cur, "Unconscious") &&
      status?.key !== "dead";
    const notes = [];
    if (status?.key === "dead") notes.push(["dead", "Dead"]);
    else {
      if (status && status.key !== "unconscious")
        notes.push([status.key, status.label]);
      if (unconscious) notes.push(["unconscious", "Unconscious"]);
      if (cur.surprised)
        notes.push(["surprised", "Surprised: no action or move this turn"]);
    }
    banner.classList.toggle("is-pc", cur.type === "pc");
    banner.innerHTML = `
      <span>Now acting:</span>
      <strong>${escapeHtml(cur.name)}</strong>
      ${notes.map(([k, label]) => `<span class="turn-note turn-note--${k}">${escapeHtml(label)}</span>`).join("")}
      <span class="turn-tag">Up next · ${escapeHtml(next.name)}</span>`;
  }

  /** Runs every second; touches only the clock so nothing else re-renders. */
  function renderClock() {
    const enc = activeEncounter();
    if (!enc) return;
    const running = clockRunning(enc);
    $("#clock-time").textContent = formatClock(clockElapsed(enc));
    $("#clock").classList.toggle("is-running", running);
    const toggle = $("#btn-clock-toggle");
    if (toggle.dataset.state !== String(running)) {
      toggle.dataset.state = String(running);
      toggle.innerHTML = running ? ICON_PAUSE : ICON_PLAY;
      toggle.title = running ? "Pause clock" : "Start clock";
      toggle.setAttribute("aria-label", toggle.title);
    }
  }

  function renderDifficulty(enc) {
    const el = $("#difficulty");
    const d = R.encounterDifficulty(enc);
    el.classList.toggle("hidden", !d);
    if (!d) return;
    const label = {
      under: "Under benchmark",
      approaching: "Approaching",
      over: "Over benchmark",
    }[d.tier];
    el.className = `difficulty difficulty--${d.tier}`;
    el.innerHTML = `
      <span class="difficulty-label">Benchmark:</span>
      <span>CR <b>${formatNum(d.totalCr)}</b> / ${formatNum(d.benchmark)}</span>
      <span class="difficulty-tier">${label}</span>
      ${d.dominant ? `<span class="difficulty-warn">Hint: ${escapeHtml(baseName(d.dominant.name))} may be a lot on its own</span>` : ""}`;
    el.setAttribute(
      "aria-label",
      `Encounter benchmark: ${label}. Click for details.`,
    );
  }

  /** The benchmark pill opens a window explaining the numbers behind it. */
  const benchmarkModal = $("#benchmark-modal");
  function openBenchmark() {
    const enc = activeEncounter();
    const d = enc && R.encounterDifficulty(enc);
    if (!d) return;
    const label = {
      under: "Under benchmark",
      approaching: "Approaching",
      over: "Over benchmark",
    }[d.tier];
    $("#benchmark-body").innerHTML = `
      <p class="detail-text">Lazy Encounter Benchmark (Sly Flourish): a rough heuristic, not the DMG XP budget.</p>
      <dl class="benchmark-list">
        <dt>Total enemy CR</dt><dd>${formatNum(d.totalCr)}</dd>
        <dt>Benchmark</dt><dd>${formatNum(d.benchmark)} <small>(${d.avgLevel >= 5 ? "½" : "¼"} of ${d.totalLevels} total PC levels)</small></dd>
        <dt>Result</dt><dd class="benchmark-tier benchmark-tier--${d.tier}">${label}</dd>
      </dl>
      <p class="detail-text">Over the benchmark, the fight may be deadly.</p>
      ${d.dominant ? `<p class="detail-text benchmark-hint">Hint: one monster type is above CR ${formatNum(d.singleCap)} and may be deadly by itself.</p>` : ""}`;
    openModal(benchmarkModal);
  }
  $("#difficulty").addEventListener("click", (e) => {
    // Brief flash so the click is felt even before the window appears
    const pill = e.currentTarget;
    pill.classList.remove("is-clicked");
    void pill.offsetWidth;
    pill.classList.add("is-clicked");
    openBenchmark();
  });
  $("#difficulty").addEventListener("animationend", (e) =>
    e.currentTarget.classList.remove("is-clicked"),
  );
  wireDialogChrome(benchmarkModal);

  /* ---------- Card fragments (shared with the detail modal) ---------- */
  /** The quick-info entries under a name, one string each. */
  function subtitleParts(c, withSpeed = false, withRace = false, withStats = false) {
    if (c.type === "lair") return ["Lair", "loses ties"];
    const speed = withSpeed && c.speed ? `Speed ${c.speed}` : "";
    if (c.type === "pc")
      return [
        "PC",
        `Lvl ${c.level}`,
        c.cls,
        withRace ? c.race : "",
        speed,
      ].filter(Boolean);
    // A group's shared card also shows the initiative bonus and passive Perception
    const stats = withStats
      ? [`Init ${formatMod(initBonusOf(c))}`, `P. Perception ${R.passivePerception(c)}`]
      : [];
    return ["Enemy", c.cr ? `CR ${c.cr}` : "", speed, ...stats].filter(Boolean);
  }
  const subtitleFor = (c, withSpeed = false, withRace = false, withStats = false) =>
    subtitleParts(c, withSpeed, withRace, withStats).join(" · ");

  /** Dead, Stable, Dying (PCs) or Down (monsters), or null when standing. */
  function vitalStatus(c) {
    if (c.type === "lair") return null;
    if (R.isDead(c)) return { key: "dead", label: "Dead" };
    if (c.hp.current > 0) return null;
    if (c.type !== "pc") return { key: "down", label: "Down" };
    if (R.isStable(c)) return { key: "stable", label: "Stable" };
    return { key: "dying", label: "Dying" };
  }

  /** The HP bar's colour name (ok, is-wounded or is-critical), also used for the status pill. */
  function hpTone(c) {
    const pct = c.hp.max > 0 ? (c.hp.current / c.hp.max) * 100 : 0;
    return pct <= 25 ? "is-critical" : pct <= 50 ? "is-wounded" : "ok";
  }

  /** A text equivalent of the HP bar colour. */
  function hpStateLabel(c) {
    const vs = vitalStatus(c);
    if (vs) return vs.label;
    const pct = c.hp.max > 0 ? c.hp.current / c.hp.max : 0;
    return pct >= 1
      ? "Unharmed"
      : pct > 0.5
        ? "Hurt"
        : pct > 0.25
          ? "Bloodied"
          : "Critical";
  }

  const exhaustionTitle = (level) =>
    R.exhaustionEffects(level)
      .map((e, i) => `${i + 1}: ${e}`)
      .join("\n");

  function conditionChip(cond, round) {
    const left = R.roundsLeft(cond, round);
    const effect = CONDITION_EFFECTS[cond.name] || "";
    const title =
      left === null
        ? effect
        : `${effect}\nEnds after ${left} more round${left === 1 ? "" : "s"} (last round ${cond.endsOnRound}).`;
    return `<span class="chip chip--cond" title="${escapeHtml(title)}">${cond.name}${left === null ? "" : ` <small>${left}r</small>`}</span>`;
  }

  function concCheckHtml(c, inDetail = false) {
    const check = c.concentrationCheck;
    if (!check || !c.concentration?.active) return "";
    return `
      <div class="conc-check" role="status">
        <span>Concentration save <b>DC ${check.dc}</b>${check.count > 1 ? ` <small>×${check.count} saves</small>` : ""}</span>
        ${
          inDetail
            ? `<button class="btn btn-ghost btn-sm" type="button" data-action="dismiss-conc-check">Dismiss</button>`
            : `<button class="icon-btn conc-check-dismiss" type="button" data-action="dismiss-conc-check" title="Dismiss" aria-label="Dismiss concentration save reminder">×</button>`
        }
      </div>`;
  }

  function statusChipsHtml(c, round) {
    const chips = [];
    if (c.concentration?.active) {
      chips.push(
        `<span class="chip chip--conc" title="Concentrating">◉ ${escapeHtml(c.concentration.spell || "Concentrating")}</span>`,
      );
    }
    (c.conditions || []).forEach((cond) =>
      chips.push(conditionChip(cond, round)),
    );
    if (c.exhaustion) {
      chips.push(
        `<span class="chip chip--exh" title="${escapeHtml(`Exhaustion (cumulative)\n${exhaustionTitle(c.exhaustion)}`)}">Exhaustion ${c.exhaustion}</span>`,
      );
    }
    return (
      (chips.length ? `<div class="card-status">${chips.join("")}</div>` : "") +
      concCheckHtml(c)
    );
  }

  function deathSavesHtml(c) {
    const ds = c.deathSaves;
    const pips = (kind) =>
      [0, 1, 2]
        .map(
          (i) => `
      <button class="pip pip--${kind} ${i < ds[kind] ? "is-full" : ""}" type="button"
              data-action="death-save" data-kind="${kind}" data-index="${i}"
              aria-pressed="${i < ds[kind]}" aria-label="Death save ${kind === "fail" ? "failure" : "success"} ${i + 1}"></button>`,
        )
        .join("");
    const vs = vitalStatus(c);
    const status =
      vs && ["dead", "stable"].includes(vs.key)
        ? `<span class="ds-status ds-status--${vs.key}">${vs.label}</span>`
        : "";
    return `
      <div class="death-saves">
        <span class="ds-label">Death Saves</span>
        <span class="ds-group" title="Successes"><span class="ds-kind ds-kind--success" aria-hidden="true">✓</span>${pips("success")}</span>
        <span class="ds-group" title="Failures"><span class="ds-kind ds-kind--fail" aria-hidden="true">✗</span>${pips("fail")}</span>
        ${status}
      </div>`;
  }

  const pipRow = (count, full, action, extra, label) =>
    Array.from(
      { length: count },
      (_, p) => `
    <button class="pip ${p < full ? "is-full" : ""}" type="button" data-action="${action}" ${extra} data-pip-index="${p}"
            aria-pressed="${p < full}" aria-label="${label} ${p + 1}"></button>`,
    ).join("");

  function spellBlockHtml(c) {
    if (!c.spellSlots?.length) return "";
    return `
      <div class="spell-block">
        <div class="spell-block-title">Spell Slots</div>
        <div class="spell-rows-card">
          ${c.spellSlots
            .map(
              (s, idx) => `
            <div class="spell-row-card">
              <span class="spell-level">${ordinal(s.level)}${s.recovery === "short" ? ` <abbr class="spell-recovery" title="Recovers on a short rest">SR</abbr>` : ""}</span>
              <div class="spell-pips">${pipRow(s.max, s.current, "toggle-pip", `data-slot-index="${idx}"`, `${ordinal(s.level)} level slot`)}</div>
              <span class="spell-count">${s.current}/${s.max}</span>
            </div>`,
            )
            .join("")}
        </div>
      </div>`;
  }

  function legendaryHtml(c) {
    const la = c.legendaryActions || 0;
    const lr = c.legendaryResistance || 0;
    if (!la && !lr) return "";
    return `
      <div class="legendary">
        ${
          la
            ? `
          <span class="legendary-group" title="Legendary actions: ${c.legendaryActionsLeft}/${la}. Refill at the start of its turn.">
            <span class="legendary-label">Legendary</span>
            <span class="legendary-pips">${pipRow(la, c.legendaryActionsLeft, "legendary-pip", `data-kind="actions"`, "Legendary action")}</span>
          </span>`
            : ""
        }
        ${
          lr
            ? `
          <span class="legendary-group" title="Legendary resistance: ${c.legendaryResistanceLeft}/${lr} per day. Does not refill on its own.">
            <span class="legendary-label">Resist</span>
            <span class="legendary-pips">${pipRow(lr, c.legendaryResistanceLeft, "legendary-pip", `data-kind="resistance"`, "Legendary resistance")}</span>
          </span>`
            : ""
        }
      </div>`;
  }

  function economyHtml(c, round) {
    const chip = (action, label, used, title, disabled = false) => `
      <button class="chip chip--econ ${used ? "is-used" : ""}" type="button" data-action="${action}"
              aria-pressed="${used}" title="${title}" ${disabled ? "disabled" : ""}>${label}</button>`;
    const surpriseNote = c.surprised
      ? " Surprised: no reactions until its first turn ends."
      : "";
    const actionChip = chip(
      "toggle-action",
      "Action",
      c.actionUsed || c.surprised,
      `Action ${c.actionUsed ? "used" : "available"} this turn.${c.surprised ? " Surprised: no action on its first turn." : ""}`,
      c.surprised,
    );
    return `
      <div class="card-economy" role="group" aria-label="Action economy">
        ${actionChip}
        ${chip("toggle-reaction", "Reaction", c.reactionUsed || c.surprised, `Reaction ${c.reactionUsed ? "used" : "available"}. Returns at the start of its turn.${surpriseNote}`, c.surprised)}
        ${chip("toggle-bonus", "Bonus", c.bonusActionUsed, `Bonus action ${c.bonusActionUsed ? "used" : "available"} this turn.`)}
        ${
          round === 1 || c.surprised
            ? `
          <button class="chip chip--surprised ${c.surprised ? "is-on" : ""}" type="button" data-action="toggle-surprised" aria-pressed="${c.surprised}"
                  title="Surprised (round 1): can't move or act on its first turn, and can't react until that turn ends.">Surprised</button>`
            : ""
        }
      </div>`;
  }

  /** One attack line: "Scimitar  To Hit: +4  Damage: 1d6+2 slashing". Plain text; the DM rolls real dice. */
  function attackHtml(atk) {
    const hit =
      atk.kind === "save"
        ? `<span class="attack-save" title="Saving throw"><span class="attack-label">Save:</span> DC ${atk.saveDc} ${atk.saveAbility.toUpperCase()}${atk.halfOnSave ? ", half on save" : ""}</span>`
        : `<span class="attack-hit"><span class="attack-label">To Hit:</span> ${formatMod(atk.toHit)}</span>`;
    const dmg = damageText(atk);
    return `
      <div class="attack ${atk.kind === "save" ? "attack--save" : ""}">
        <span class="attack-name" title="${escapeHtml(atk.name)}">${escapeHtml(atk.name)}</span>
        ${hit}
        ${dmg ? `<span class="attack-dmg"><span class="attack-label">Damage:</span> ${escapeHtml(dmg)}</span>` : ""}
        ${atk.note ? `<span class="attack-note"><span class="attack-label">Notes:</span> ${escapeHtml(atk.note)}</span>` : ""}
      </div>`;
  }

  const skillsText = (c) =>
    (c.skills || [])
      .map((k) => `${SKILL_BY_KEY[k].name} ${formatMod(skillBonus(c, k))}`)
      .join(" · ");

  function rechargeChipsHtml(c) {
    if (!c.recharges?.length) return "";
    return `
      <div class="card-recharges">
        ${c.recharges
          .map(
            (r, i) => `
          <button class="chip chip--recharge ${r.available ? "is-ready" : "is-spent"}" type="button"
                  data-action="toggle-recharge" data-recharge-index="${i}" aria-pressed="${!r.available}"
                  title="${r.available ? "Ready. Click to mark used." : `Spent. Recharges on ${rechargeLabel(r.min)}. Click to restore.`}">
            ${escapeHtml(r.name)} <small>${rechargeLabel(r.min)}</small>
          </button>`,
          )
          .join("")}
      </div>`;
  }

  /**
   * mode "member": a grouped enemy's slim card (name, type, remove only).
   * mode "group": the group's shared card (shared initiative, name x count, no remove).
   */
  function cardHeadHtml(c, extraTools = "", mode = null, count = 1) {
    const vs = vitalStatus(c);
    const groupName = `${escapeHtml(baseName(c.name))} <b>×${count}</b>`;
    // AC sits right after the initiative box, before the name (not on a group's slim enemy cards)
    const acBox =
      mode === "member" || c.type === "lair"
        ? ""
        : `
        <div class="ac-shield" title="Armor Class" data-fit="12">
          <span class="ac-label">AC</span>
          <span class="ac-value">${toInt(c.ac, 10)}</span>
        </div>`;
    const initBox =
      mode === "member"
        ? ""
        : `
        <div class="card-initiative" title="${mode === "group" ? "Initiative (shared by the group)" : "Initiative"}">
          <label class="card-initiative-label" for="${mode === "group" ? "g" : ""}init-${c.instanceId}"><span class="init-short">Init</span><span class="init-full">Initiative</span></label>
          <input id="${mode === "group" ? "g" : ""}init-${c.instanceId}" type="number" value="${toInt(c.initiative, 0)}" data-field="initiative" aria-label="Initiative for ${escapeHtml(mode === "group" ? `the ${baseName(c.name)} group` : c.name)}">
        </div>${acBox}`;
    const expand =
      mode === "member"
        ? ""
        : `
          <button class="icon-btn" type="button" data-action="open-detail" title="Open details" aria-label="Open details for ${escapeHtml(c.name)}">${ICON_EXPAND}</button>`;
    const remove =
      mode === "group"
        ? ""
        : `
          <button class="icon-btn icon-btn--danger" type="button" data-action="remove-instance" title="Remove from encounter" aria-label="Remove ${escapeHtml(c.name)} from encounter">×</button>`;
    return `
      <header class="card-head">${initBox}
        <div class="card-title-wrap" data-fit="14">
          <h3 class="card-name"><button class="card-name-btn" type="button" data-action="open-detail" title="Open details for ${escapeHtml(c.name)}">${mode === "group" ? groupName : escapeHtml(c.name)}</button></h3>
          ${
            mode === "member"
              ? ""
              : `<span class="card-type" data-fit="11" title="${escapeHtml(subtitleFor(c, mode !== "member", false, mode === "group"))}">${subtitleParts(
            c,
            mode !== "member",
            false,
            mode === "group",
          )
            .map((p) => `<span>${escapeHtml(p)}</span>`)
            .join("")}</span>`
          }
          ${vs && mode !== "group" ? `<span class="card-down-tag card-down-tag--${vs.key}" data-fit="11">${vs.label}</span>` : ""}
          ${c.hidden && mode !== "member" ? `<span class="card-hidden-tag" data-fit="11" title="Players cannot see this enemy yet">Hidden</span>` : ""}
        </div>
        <div class="card-tools" data-fit="10">${expand}
          ${extraTools}${remove}
        </div>
      </header>`;
  }

  function damageTypeOptions(c) {
    const selected = lastDamageType.get(c.instanceId) || "";
    const tag = (t) => {
      if ((c.damageImmunities || []).includes(t)) return " (immune)";
      const res = (c.damageResistances || []).includes(t);
      const vul = (c.damageVulnerabilities || []).includes(t);
      return res && vul
        ? " (res + vuln)"
        : res
          ? " (resists)"
          : vul
            ? " (vulnerable)"
            : "";
    };
    return (
      `<option value="">untyped</option>` +
      DAMAGE_TYPES.map(
        (t) =>
          `<option value="${t}" ${t === selected ? "selected" : ""}>${t}${tag(t)}</option>`,
      ).join("")
    );
  }

  /** Class and inline size for a card the DM has dragged to a custom size. */
  function cardSizeAttrs(c) {
    if (!c.cardSize) return { cls: "", style: "" };
    return {
      cls: "is-sized",
      style: `style="width:${c.cardSize.w}px;height:${c.cardSize.h}px"`,
    };
  }

  /** Corner handle for drag-resizing a card. */
  const RESIZE_HANDLE = `<button class="card-resize" type="button" data-resize tabindex="-1"
      title="Drag to resize. Double-click to reset." aria-label="Resize card"></button>`;

  /**
   * mode "member" is a grouped enemy's slim card (name, type, HP). mode "group" is the
   * group's shared card (initiative, AC, actions, visibility, attacks and stats).
   * members are everyone in the group, for the group card.
   */
  function renderCard(c, isCurrent, enc, isNew, mode = null, members = [c]) {
    const anim = isNew ? "is-new" : "";
    const size = mode ? { cls: "", style: "" } : cardSizeAttrs(c);
    if (c.type === "lair") {
      return `
        <article class="card card--lair ${isCurrent ? "is-current" : ""} ${anim} ${size.cls}" ${size.style} data-instance-id="${c.instanceId}" aria-current="${isCurrent ? "step" : "false"}">
          ${cardHeadHtml(c)}
          ${isCurrent ? `<span class="sr-only">Current turn.</span>` : ""}
          <p class="lair-notes ${c.notes ? "" : "is-empty"}" data-fit="1">${c.notes ? escapeHtml(c.notes) : "No lair actions noted. Open details to add them."}</p>
          ${RESIZE_HANDLE}
        </article>`;
    }

    const max = Math.max(0, toInt(c.hp.max, 0));
    const cur = Math.max(0, toInt(c.hp.current, 0));
    const temp = Math.max(0, toInt(c.hp.temp, 0));
    const pct = max > 0 ? clamp((cur / max) * 100, 0, 100) : 0;
    const barClass = pct <= 25 ? "is-critical" : pct <= 50 ? "is-wounded" : "";
    const scale = Math.max(max, cur + temp, 1);
    const isDown = cur <= 0;
    const isPc = c.type === "pc";
    const compact = state.ui.cardMode === "compact";
    const showMore = moreOpen.has(c.instanceId)
      ? moreOpen.get(c.instanceId)
      : !compact;

    const statsHtml = STAT_KEYS.map((k) => {
      const score = toInt(c.stats?.[k], 10);
      const m = modifier(score);
      const cls = m > 0 ? "is-pos" : m < 0 ? "is-neg" : "";
      return `
        <div class="stat" title="${STAT_NAMES[k]} ${score}, save ${formatMod(saveBonus(c, k))}">
          <span class="stat-label">${k.toUpperCase()}</span>
          <span class="stat-mod ${cls}">${formatMod(m)}</span>
        </div>`;
    }).join("");

    const info = [];
    // Speed lives in the quick info line under the name
    info.push(`<span><b>Init</b> ${formatMod(initBonusOf(c))}</span>`);
    info.push(`<span><b>P. Perception</b> ${R.passivePerception(c)}</span>`);
    const skills = skillsText(c);
    const noteLine = (c.notes || "").split("\n").find((l) => l.trim()) || "";

    const idAttr =
      mode === "group"
        ? `data-group-lead="${c.instanceId}"`
        : `data-instance-id="${c.instanceId}"`;
    const toolsHtml =
      mode === "member"
        ? ""
        : `
          ${
            c.type !== "lair"
              ? `<button class="icon-btn ${c.hidden ? "is-on" : ""}" type="button" data-action="toggle-hidden" aria-pressed="${!!c.hidden}"
                  title="${c.hidden ? "Hidden from players. Click to reveal." : "Visible to players. Click to hide."}"
                  aria-label="${c.hidden ? `Reveal ${escapeHtml(c.name)} to players` : `Hide ${escapeHtml(c.name)} from players`}">${c.hidden ? ICON_EYE_OFF : ICON_EYE}</button>`
              : ""
          }
          <button class="icon-btn" type="button" data-action="save-to-library" title="Save to library" aria-label="Save ${escapeHtml(c.name)} to the library">${ICON_SAVE}</button>
          <button class="icon-btn" type="button" data-action="edit-instance" title="Edit stat block" aria-label="Edit ${escapeHtml(c.name)}">${ICON_EDIT}</button>`;

    // The action buttons (and legendary pips); AC is in the card head now
    const sideHtml = `
          <div class="card-vitals-side" data-fit="7">
            ${economyHtml(c, enc.round)}
            ${legendaryHtml(c)}
          </div>`;
    const vitalsHtml = `
        <div class="card-vitals" data-fit="12">${sideHtml}
        </div>`;

    const hpHtml = `
        <div class="hp-block" data-fit="13">
          <div class="hp-top">
            <span class="hp-label">HP</span>
            <span class="hp-state hp-state--${barClass || "ok"}" data-fit="8">${hpStateLabel(c)}</span>
            <label class="hp-temp ${temp ? "has-temp" : ""}" title="Temporary hit points (direct edit)" data-fit="8">
              <span>Temp</span>
              <input type="number" min="0" value="${temp || ""}" placeholder="0" data-field="hpTemp" aria-label="Temporary HP">
            </label>
            <div class="hp-values">
              <input class="hp-cur" type="number" min="0" value="${cur}" data-field="hpCurrent" aria-label="Current HP" style="--digits:${String(cur).length}">
              <span class="hp-sep">/</span>
              <input class="hp-max" type="number" min="0" value="${max}" data-field="hpMax" aria-label="Max HP" style="--digits:${String(max).length}">
            </div>
          </div>
          <div class="hp-bar" role="progressbar" aria-label="${escapeHtml(c.name)} hit points"
               aria-valuemin="0" aria-valuemax="${max}" aria-valuenow="${cur}"
               aria-valuetext="${cur} of ${max} HP${temp ? `, ${temp} temporary` : ""}, ${hpStateLabel(c)}">
            <div class="hp-bar-fill ${barClass}" style="width:${(cur / scale) * 100}%"></div>
            ${temp ? `<div class="hp-bar-temp" style="width:${(temp / scale) * 100}%"></div>` : ""}
          </div>
          <div class="hp-adjust" data-fit="8">
            <input type="number" min="0" placeholder="1" data-field="hpDelta"
                   aria-label="Damage, healing or temp HP amount" title="Enter applies damage, Shift+Enter heals">
            <select data-field="dmgType" aria-label="Damage type" title="Damage type: resistances, immunities and vulnerabilities apply">${damageTypeOptions(c)}</select>
            ${
              isPc && isDown && !R.isDead(c)
                ? `
              <label class="crit-toggle" title="Damage at 0 HP from a critical hit counts as two death save failures">
                <input type="checkbox" data-field="crit"> Crit
              </label>`
                : ""
            }
          </div>
          <div class="hp-adjust-btns" data-fit="8">
            <button class="hp-adj-btn hp-adj-btn--dmg" type="button" data-action="damage" title="Apply damage, 1 if blank (Enter)">Damage</button>
            <button class="hp-adj-btn hp-adj-btn--heal" type="button" data-action="heal" title="Apply healing, 1 if blank (Shift+Enter). Caps at max HP.">Heal</button>
            <button class="hp-adj-btn hp-adj-btn--temp" type="button" data-action="temp" title="Grant temporary HP. Keeps the higher value; temp HP doesn't stack.">Temp</button>
          </div>
        </div>`;

    const moreHtml = `
        <details class="card-more" data-card-more data-fit="1" ${showMore ? "open" : ""}>
          <summary class="card-more-summary">${isPc ? "Stats" : "Attacks &amp; stats"}</summary>
          <div class="card-more-body">
            ${c.multiattack ? `<p class="card-multiattack">${escapeHtml(c.multiattack)}</p>` : ""}
            ${c.attacks?.length ? `<div class="card-attacks">${c.attacks.map((a) => attackHtml(a)).join("")}</div>` : ""}
            <div class="stats-row">${statsHtml}</div>
            <div class="card-info">${info.join("")}</div>
            ${skills ? `<div class="card-skills">${escapeHtml(skills)}</div>` : ""}
          </div>
        </details>`;

    const stateCls =
      mode === "group"
        ? ""
        : `${isDown ? "is-down" : ""} ${R.isDead(c) ? "is-dead" : ""}`;
    return `
      <article class="card card--${c.type} ${mode ? `card--${mode}` : ""} ${isCurrent ? "is-current" : ""} ${stateCls} ${c.hidden ? "is-hidden" : ""} ${anim} ${size.cls}"
               ${size.style} ${idAttr} aria-current="${isCurrent ? "step" : "false"}">
        ${cardHeadHtml(c, toolsHtml, mode, members.length)}
        ${mode === "member" ? `<div class="member-status"><span class="member-pill member-pill--${hpTone(c)}">${hpStateLabel(c)}</span></div>` : ""}
        ${isCurrent ? `<span class="sr-only">Current turn.</span>` : ""}
        ${mode === "group" ? "" : vitalsHtml}
        ${mode === "group" ? "" : hpHtml}
        ${mode === "group" ? "" : `<div class="fit-group" data-fit="5">${statusChipsHtml(c, enc.round)}</div>`}
        ${!mode && isPc && isDown ? `<div class="fit-group" data-fit="6">${deathSavesHtml(c)}</div>` : ""}
        ${!mode && noteLine ? `<p class="card-notes" title="DM notes" data-fit="4"><span class="sr-only">Notes: </span>${escapeHtml(noteLine)}</p>` : ""}
        ${mode ? "" : `<div class="fit-group" data-fit="3">${rechargeChipsHtml(c)}</div>`}
        ${mode ? "" : `<div class="fit-group" data-fit="2">${spellBlockHtml(c)}</div>`}
        ${mode === "member" ? "" : moreHtml}
        ${mode ? "" : RESIZE_HANDLE}
      </article>`;
  }

  /* ---------- Combat log ---------- */
  function renderLog() {
    const drawer = $("#log-drawer");
    const open =
      state.ui.logOpen && state.ui.view === "active" && !!activeEncounter();
    drawer.hidden = !open;
    $("#btn-toggle-log").setAttribute(
      "aria-pressed",
      String(!!state.ui.logOpen),
    );
    $("#btn-toggle-log").classList.toggle("is-on", !!state.ui.logOpen);
    if (!open) return;
    const log = activeEncounter().log;
    const list = $("#log-list");
    list.innerHTML = log.length
      ? log
          .map(
            (e) => `
          <li class="log-entry log-entry--${e.kind}">
            <span class="log-round" title="Round ${e.round}">R${e.round}</span>
            <span class="log-text">${escapeHtml(e.text)}</span>
          </li>`,
          )
          .join("")
      : `<li class="log-empty">Nothing yet. Damage, healing, conditions and turns show up here.</li>`;
    list.scrollTop = list.scrollHeight;
  }

  /* ---------- Library ---------- */
  function renderLibrary() {
    const ui = state.ui;
    if (document.activeElement !== $("#lib-search"))
      $("#lib-search").value = ui.librarySearch;
    if (document.activeElement !== $("#lib-type-other"))
      $("#lib-type-other").value = ui.libraryTypeOther;
    $("#lib-sort").value = ui.librarySort;
    $("#lib-class").value = ui.libraryClass;
    $("#lib-cr-min").value = ui.libraryCrMin;
    $("#lib-cr-max").value = ui.libraryCrMax;
    $("#lib-type").value = ui.libraryType;
    $("#lib-type-other-field").classList.toggle(
      "hidden",
      ui.libraryType !== "other",
    );
    // Light up the buttons while a search or filter is hiding enemies
    $("#lib-search-toggle").classList.toggle(
      "is-on",
      !!ui.librarySearch.trim(),
    );
    $("#lib-filter-toggle").classList.toggle(
      "is-on",
      !!(ui.libraryCrMin || ui.libraryCrMax || ui.libraryType) ||
        ui.librarySort !== "name",
    );
    renderLibraryList(
      "pc",
      $("#library-pcs"),
      "No player characters saved yet.",
    );
    renderLibraryList(
      "enemy",
      $("#library-enemies"),
      "No enemies saved yet. Every dungeon needs a few.",
    );
  }

  function renderLibraryList(type, host, emptyText) {
    const all = libraryList(type);
    const ui = state.ui;
    // Search, sort and the CR and Type filters are for the enemy list only
    const list =
      type === "enemy"
        ? R.filterLibrary(all, type, {
            search: ui.librarySearch,
            crMin: ui.libraryCrMin,
            crMax: ui.libraryCrMax,
            creatureType: ui.libraryType,
            typeOther: ui.libraryTypeOther,
            sort: ui.librarySort,
          })
        : R.filterLibrary(all, type, { cls: ui.libraryClass });
    if (!all.length) {
      const starter =
        type === "enemy" && SRD
          ? `<button class="btn btn-outline-red btn-sm" type="button" data-action="add-srd">Add ${SRD.MONSTERS.length} starter monsters (SRD 5.1)</button>`
          : "";
      host.innerHTML = `<div class="empty-inline"><p>${emptyText}</p>${starter}</div>`;
      return;
    }
    if (!list.length) {
      host.innerHTML = `<div class="empty-inline">Nothing matches the search or filters.</div>`;
      return;
    }
    host.innerHTML = list
      .map((t) => {
        const lead =
          type === "pc"
            ? `<span><b>Lvl ${t.level}</b>${t.cls ? ` ${escapeHtml(t.cls)}` : ""}${t.race ? ` · ${escapeHtml(t.race)}` : ""}</span>`
            : t.cr
              ? `<span>CR <b>${t.cr}</b> <small>${R.xpForCr(t.cr).toLocaleString()} XP</small></span>`
              : "";
        return `
        <div class="lib-row lib-row--${type}" data-template-id="${t.id}">
          <div>
            <div class="lib-name">${escapeHtml(t.name)}</div>
            <div class="lib-meta">
              ${lead}
              <span>HP <b>${toInt(t.hp?.max, 0)}</b></span>
              <span>AC <b>${toInt(t.ac, 10)}</b></span>
              <span class="lib-abilities">${STAT_KEYS.map((k) => `${k.toUpperCase()} ${formatMod(modifier(t.stats?.[k]))}`).join(" · ")}</span>
              ${t.attacks?.length ? `<span>Attacks <b>${t.attacks.length}</b></span>` : ""}
              ${t.legendaryActions ? `<span>Legendary <b>${t.legendaryActions}</b></span>` : ""}
              ${t.spellSlots?.length ? `<span>✦ <b>${t.spellSlots.length}</b> spell level${t.spellSlots.length === 1 ? "" : "s"}</span>` : ""}
            </div>
          </div>
          <div class="lib-actions">
            <button class="icon-btn" type="button" data-action="edit-template" title="Edit" aria-label="Edit ${escapeHtml(t.name)}">${ICON_EDIT}</button>
            <button class="icon-btn" type="button" data-action="duplicate-template" title="Duplicate" aria-label="Duplicate ${escapeHtml(t.name)}">${ICON_COPY}</button>
            <button class="icon-btn" type="button" data-action="variant-template" title="Clone as variant (opens the builder)" aria-label="Clone ${escapeHtml(t.name)} as a variant">${ICON_VARIANT}</button>
            <button class="icon-btn icon-btn--danger" type="button" data-action="delete-template" title="Delete" aria-label="Delete ${escapeHtml(t.name)}">${ICON_TRASH}</button>
          </div>
        </div>`;
      })
      .join("");
  }

  /* ---------- Saved indicator ---------- */
  function renderSaved() {
    const el = $("#saved-indicator");
    if (!el) return;
    el.classList.toggle("is-error", !!saveError || serverOffline);
    if (saveError) {
      el.textContent = "Not saved";
      el.title =
        saveError === "quota"
          ? "Browser storage is full. Export a backup from Settings."
          : "The last save failed.";
      return;
    }
    if (serverOffline) {
      el.textContent = "Not on server";
      el.title =
        "The server could not be reached. Changes are kept in this browser and sent when it is back.";
      return;
    }
    const time = lastSavedAt ? new Date(lastSavedAt) : null;
    el.textContent = time
      ? `Saved ${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "";
    el.title = time
      ? `Last saved to this browser at ${time.toLocaleString()}`
      : "";
  }

  /* ======================================================================
     5. Dialogs
     ====================================================================== */

  /** Shared: close on backdrop click; buttons with [data-close] close too. */
  function wireDialogChrome(dialog) {
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close("cancel");
    });
    $$("[data-close]", dialog).forEach((btn) =>
      btn.addEventListener("click", () => dialog.close("cancel")),
    );
    dialog.addEventListener("close", () => restoreFocus(dialog));
  }

  /* ---------- Focus: remember the opener, trap Tab inside, restore on close ---------- */
  const openers = new WeakMap();

  /** A selector that finds an equivalent element after a full re-render replaced it. */
  function describeFocus(el) {
    if (!el || el === document.body) return null;
    if (el.id) return `#${el.id}`;
    const host = el.closest(
      "[data-instance-id], [data-encounter-id], [data-template-id]",
    );
    const attrs = Object.entries(el.dataset)
      .map(
        ([k, v]) =>
          `[data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${String(v).replace(/"/g, '\\"')}"]`,
      )
      .join("");
    if (!attrs) return null;
    if (!host) return attrs;
    const [key, value] = Object.entries(host.dataset).find(([k]) =>
      /^(instanceId|encounterId|templateId)$/.test(k),
    );
    return `[data-${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${value}"] ${attrs}`;
  }

  function openModal(dialog) {
    const active = document.activeElement;
    // Opening one dialog from another (detail → edit) hands the original opener along.
    const parent = active?.closest?.("dialog[open]");
    const opener = parent
      ? openers.get(parent)
      : { el: active, selector: describeFocus(active) };
    openers.set(dialog, opener);
    dialog.showModal();
  }

  function restoreFocus(dialog) {
    const opener = openers.get(dialog);
    openers.delete(dialog);
    if (!opener) return;
    requestAnimationFrame(() => {
      if (document.querySelector("dialog[open]")) return;
      const target = opener.el?.isConnected
        ? opener.el
        : opener.selector && $(opener.selector);
      target?.focus?.();
    });
  }

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const dialog = $$("dialog[open]").at(-1);
    if (!dialog) return;
    const items = $$(FOCUSABLE, dialog).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (
      e.shiftKey &&
      (document.activeElement === first ||
        !dialog.contains(document.activeElement))
    ) {
      e.preventDefault();
      last.focus();
    } else if (
      !e.shiftKey &&
      (document.activeElement === last ||
        !dialog.contains(document.activeElement))
    ) {
      e.preventDefault();
      first.focus();
    }
  });

  /* ---------- Screen reader announcements ---------- */
  function liveSay(text) {
    const el = $("#sr-live");
    el.textContent = "";
    // A fresh text node after a tick makes repeated messages announce again.
    setTimeout(() => {
      el.textContent = text;
    }, 50);
  }
  const turnAnnouncement = (enc) => {
    const c = enc.combatants[enc.currentTurnIndex];
    return c ? `Round ${enc.round}, ${c.name}'s turn.` : "";
  };

  /* ---------- Toast ---------- */
  const TOAST_MAX = 5;

  function toast(
    message,
    { action = null, duration = 0, sticky = false } = {},
  ) {
    const stack = $("#toast-stack");
    const el = document.createElement("div");
    el.className = `toast${action ? " toast--action" : ""}${sticky ? " toast--sticky" : ""}`;
    const text = document.createElement("span");
    text.textContent = message;
    el.appendChild(text);
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        el.remove();
        action.run();
      });
      el.appendChild(btn);
    }
    stack.appendChild(el);
    while (stack.children.length > TOAST_MAX)
      stack.querySelector(".toast:not(.toast--sticky)")?.remove() ??
        stack.firstElementChild.remove();
    if (sticky) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "toast-action";
      close.textContent = "Dismiss";
      close.addEventListener("click", () => el.remove());
      el.appendChild(close);
      return;
    }
    setTimeout(() => el.remove(), duration || (action ? 7000 : 3000));
  }

  /* ---------- Prompt (text) ---------- */
  const promptModal = $("#prompt-modal");
  let promptResolve = null;
  let promptResult = null;

  function promptDialog({ title, label = "Name", value = "", okLabel = "OK" }) {
    return new Promise((resolve) => {
      promptResolve = resolve;
      $("#prompt-title").textContent = title;
      $("#prompt-label").textContent = label;
      $("#prompt-submit").textContent = okLabel;
      const input = $("#prompt-input");
      input.value = value;
      promptResult = null;
      promptModal.returnValue = "cancel";
      openModal(promptModal);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  $("#prompt-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#prompt-input").value.trim();
    if (!v) {
      $("#prompt-input").focus();
      return;
    }
    promptResult = v;
    promptModal.close("ok");
  });
  promptModal.addEventListener("close", () => {
    const r = promptResolve;
    promptResolve = null;
    if (r) r(promptModal.returnValue === "ok" ? promptResult : null);
  });
  wireDialogChrome(promptModal);

  /* ---------- Confirm ---------- */
  const confirmModal = $("#confirm-modal");
  let confirmResolve = null;

  /** `html` must already be escaped by the caller. */
  function confirmDialog({ title, html, okLabel = "Delete", danger = true }) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $("#confirm-title").textContent = title;
      $("#confirm-text").innerHTML = html;
      const submit = $("#confirm-submit");
      submit.textContent = okLabel;
      submit.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
      confirmModal.classList.toggle("modal-danger", danger);
      confirmModal.returnValue = "cancel";
      openModal(confirmModal);
      requestAnimationFrame(() => submit.focus());
    });
  }

  $("#confirm-form").addEventListener("submit", (e) => {
    e.preventDefault();
    confirmModal.close("ok");
  });
  confirmModal.addEventListener("close", () => {
    const r = confirmResolve;
    confirmResolve = null;
    if (r) r(confirmModal.returnValue === "ok");
  });
  wireDialogChrome(confirmModal);

  /* ---------- Choice (pick one) ---------- */
  const choiceModal = $("#choice-modal");
  let choiceResolve = null;
  let choiceValue = null;

  function choiceDialog({ title, text = "", options }) {
    return new Promise((resolve) => {
      choiceResolve = resolve;
      choiceValue = null;
      $("#choice-title").textContent = title;
      $("#choice-text").textContent = text;
      $("#choice-list").innerHTML = options
        .map(
          (o, i) => `
        <button class="choice-btn" type="button" data-choice="${i}">
          <span>${escapeHtml(o.label)}</span>${o.hint ? `<small>${escapeHtml(o.hint)}</small>` : ""}
        </button>`,
        )
        .join("");
      $("#choice-list").onclick = (e) => {
        const btn = e.target.closest("[data-choice]");
        if (!btn) return;
        choiceValue = options[toInt(btn.dataset.choice, 0)].value;
        choiceModal.close("ok");
      };
      choiceModal.returnValue = "cancel";
      openModal(choiceModal);
      requestAnimationFrame(() => $(".choice-btn", choiceModal)?.focus());
    });
  }
  choiceModal.addEventListener("close", () => {
    const r = choiceResolve;
    choiceResolve = null;
    if (r) r(choiceModal.returnValue === "ok" ? choiceValue : null);
  });
  wireDialogChrome(choiceModal);

  /* ---------- Creature builder modal ---------- */
  const creatureModal = $("#creature-modal");
  const creatureForm = $("#creature-form");
  /** @type {{mode:string, type:string, templateId?:string, instanceId?:string, seed?:object}|null} */
  let creatureCtx = null;

  const abilityOptions = (selected) =>
    STAT_KEYS.map(
      (k) =>
        `<option value="${k}" ${k === selected ? "selected" : ""}>${k.toUpperCase()}</option>`,
    ).join("");

  function spellRowHtml(
    slot = { level: 1, current: 0, max: 0, recovery: "long" },
  ) {
    return `
      <div class="spell-row" data-row>
        <label class="field"><span class="field-label">Level</span>
          <input type="number" min="1" max="9" data-spell="level" value="${toInt(slot.level, 1)}"></label>
        <label class="field"><span class="field-label">Current</span>
          <input type="number" min="0" data-spell="current" value="${toInt(slot.current, 0)}"></label>
        <label class="field"><span class="field-label">Max</span>
          <input type="number" min="0" data-spell="max" value="${toInt(slot.max, 0)}"></label>
        <label class="field"><span class="field-label">Recovers on</span>
          <select data-spell="recovery" title="Warlock Pact Magic slots recover on a short rest">
            <option value="long" ${slot.recovery !== "short" ? "selected" : ""}>Long rest</option>
            <option value="short" ${slot.recovery === "short" ? "selected" : ""}>Short rest</option>
          </select></label>
        <button class="icon-btn icon-btn--danger" type="button" data-action="remove-row" title="Remove level" aria-label="Remove spell level">×</button>
      </div>`;
  }

  function attackRowHtml(atk = normalizeAttack({ name: "" })) {
    return `
      <div class="attack-row" data-row data-kind="${atk.kind}" data-auto-hit="${atk.autoToHit ? 1 : 0}"
           data-auto-dmg="${atk.autoDmg ? 1 : 0}" data-auto-dc="${atk.autoSaveDc ? 1 : 0}">
        <label class="field atk-name"><span class="field-label">Name</span>
          <input type="text" data-atk="name" value="${escapeHtml(atk.name === "Attack" ? "" : atk.name)}" placeholder="Scimitar" autocomplete="off"></label>
        <label class="field atk-kind"><span class="field-label">Kind</span>
          <select data-atk="kind">
            <option value="attack" ${atk.kind === "attack" ? "selected" : ""}>Attack roll</option>
            <option value="save" ${atk.kind === "save" ? "selected" : ""}>Saving throw</option>
          </select></label>
        <label class="field atk-ability"><span class="field-label">Ability</span>
          <select data-atk="ability" title="The creature's ability used for to hit, save DC and damage">${abilityOptions(atk.ability)}</select></label>
        <label class="field atk-attack-only"><span class="field-label">To Hit</span>
          <input type="number" data-atk="toHit" value="${atk.toHit}" title="Auto: ability mod + proficiency. Type to override; clear to re-enable auto."></label>
        <label class="field atk-save-only"><span class="field-label">Save DC</span>
          <input type="number" data-atk="saveDc" value="${atk.saveDc}" title="Auto: 8 + proficiency + ability mod. Type to override; clear to re-enable auto."></label>
        <label class="field atk-save-only"><span class="field-label">Target saves</span>
          <select data-atk="saveAbility">${abilityOptions(atk.saveAbility)}</select></label>
        <label class="checkbox-field checkbox-field--sm atk-save-only atk-half">
          <input type="checkbox" data-atk="halfOnSave" ${atk.halfOnSave ? "checked" : ""}> <span>Half on save</span></label>
        <label class="field atk-dice"><span class="field-label">Dice</span>
          <input type="text" data-atk="dmgDice" value="${escapeHtml(atk.dmgDice)}" placeholder="1d6" autocomplete="off"></label>
        <label class="field atk-bonus"><span class="field-label">Bonus</span>
          <input type="number" data-atk="dmgBonus" value="${atk.dmgBonus}" title="Auto: ability mod. Type to override; clear to re-enable auto."></label>
        <label class="field atk-type"><span class="field-label">Type</span>
          <input type="text" data-atk="dmgType" value="${escapeHtml(atk.dmgType)}" list="damage-types" placeholder="slashing" autocomplete="off"></label>
        <label class="field atk-note"><span class="field-label">Note</span>
          <input type="text" data-atk="note" value="${escapeHtml(atk.note)}" placeholder="plus 2d6 poison" autocomplete="off"></label>
        <button class="icon-btn icon-btn--danger atk-remove" type="button" data-action="remove-row" title="Remove attack" aria-label="Remove attack">×</button>
      </div>`;
  }

  function rechargeRowHtml(r = { name: "", min: 5 }) {
    return `
      <div class="recharge-row" data-row>
        <label class="field"><span class="field-label">Ability</span>
          <input type="text" data-recharge="name" value="${escapeHtml(r.name)}" placeholder="Fire Breath" autocomplete="off"></label>
        <label class="field"><span class="field-label">Recharge</span>
          <select data-recharge="min">
            ${[6, 5, 4, 3, 2].map((n) => `<option value="${n}" ${n === r.min ? "selected" : ""}>${rechargeLabel(n)}</option>`).join("")}
          </select></label>
        <button class="icon-btn icon-btn--danger" type="button" data-action="remove-row" title="Remove ability" aria-label="Remove ability">×</button>
      </div>`;
  }

  /** Live-recalculate everything derived from ability scores, CR and level. */
  function refreshFormCalcs() {
    const f = creatureForm.elements;
    const isPc = creatureCtx?.type === "pc";
    const prof = isPc ? profFromLevel(f.level.value) : profFromCr(f.cr.value);
    const mods = {};
    STAT_KEYS.forEach((k) => {
      mods[k] = modifier(f[k].value);
      const el = $(`[data-mod-for="${k}"]`, creatureForm);
      el.textContent = formatMod(mods[k]);
      el.className = `stat-input-mod ${mods[k] > 0 ? "is-pos" : mods[k] < 0 ? "is-neg" : ""}`;
    });
    f.initBonus.placeholder = formatMod(mods.dex).replace("−", "-");
    // When adding to an encounter the DM types the roll and the bonus is added for them
    if (creatureCtx?.mode === "encounter-new") {
      const bonus =
        f.initBonus.value.trim() === ""
          ? mods.dex
          : toInt(f.initBonus.value, 0);
      $("#creature-initiative-label").textContent =
        `Initiative roll (bonus will be applied: ${formatMod(bonus)})`;
    }
    $("#skills-prof-hint").textContent = `proficiency ${formatMod(prof)}`;
    $("#saves-prof-hint").textContent = `proficiency ${formatMod(prof)}`;
    $$("[data-save-bonus]", creatureForm).forEach((el) => {
      const k = el.dataset.saveBonus;
      el.textContent = formatMod(
        mods[k] + ($(`[data-save="${k}"]`, creatureForm).checked ? prof : 0),
      );
    });
    let perception = 0;
    $$("[data-skill-bonus]", creatureForm).forEach((el) => {
      const key = el.dataset.skillBonus;
      const proficient = $(`[data-skill="${key}"]`, creatureForm).checked;
      const expert =
        proficient && $(`[data-expertise="${key}"]`, creatureForm).checked;
      const bonus =
        mods[SKILL_BY_KEY[key].ability] +
        (proficient ? prof : 0) +
        (expert ? prof : 0);
      if (key === "perception") perception = bonus;
      el.textContent = formatMod(bonus);
    });
    $("#passive-hint").textContent = `P. Perception ${10 + perception}`;
    $$(".attack-row", creatureForm).forEach((row) => {
      const m = mods[$('[data-atk="ability"]', row).value] ?? 0;
      const hit = $('[data-atk="toHit"]', row);
      const dmg = $('[data-atk="dmgBonus"]', row);
      const dc = $('[data-atk="saveDc"]', row);
      row.dataset.kind = $('[data-atk="kind"]', row).value;
      if (row.dataset.autoHit === "1") hit.value = m + prof;
      if (row.dataset.autoDmg === "1") dmg.value = m;
      if (row.dataset.autoDc === "1") dc.value = 8 + prof + m;
      hit.classList.toggle("is-auto", row.dataset.autoHit === "1");
      dmg.classList.toggle("is-auto", row.dataset.autoDmg === "1");
      dc.classList.toggle("is-auto", row.dataset.autoDc === "1");
    });
  }

  const LIST_FIELDS = [
    "damageResistances",
    "damageImmunities",
    "damageVulnerabilities",
    "conditionImmunities",
  ];
  const TEXT_FIELDS = ["senses", "languages", "damageNotes"];
  // Pick the dropdown entry for the saved type line; unknown text opens the Other box
  function showCreatureType() {
    const box = creatureForm.elements.creatureType;
    const sel = $("#creature-type-select");
    sel.value = !box.value.trim() ? "" : creatureTypeOf(box.value) || "other";
    box.classList.toggle("hidden", sel.value !== "other");
  }

  const ENEMY_TEXT_FIELDS = [
    "creatureType",
    "alignment",
    "multiattack",
    "traits",
    "actions",
    "reactions",
    "legendaryText",
  ];

  function fillCreatureForm(data, type) {
    const f = creatureForm.elements;
    const block = normalizeTemplate(data, type);
    f.name.value = data.name ?? "";
    f.hpMax.value = block.hp.max;
    f.ac.value = block.ac;
    f.speed.value = block.speed;
    f.initiative.value = toInt(data.initiative, 0);
    STAT_KEYS.forEach((k) => {
      f[k].value = block.stats[k];
    });
    f.initBonus.value = block.initBonus ?? "";

    f.level.value = block.level ?? 1;
    f.cls.value = block.cls ?? "";
    f.race.value = block.race ?? "";
    f.cr.value = block.cr ?? "";
    f.legendaryActions.value = block.legendaryActions ?? 0;
    f.legendaryResistance.value = block.legendaryResistance ?? 0;
    [...TEXT_FIELDS, ...ENEMY_TEXT_FIELDS].forEach((k) => {
      f[k].value = block[k] ?? "";
    });
    showCreatureType();

    $$("[data-save]", creatureForm).forEach((cb) => {
      cb.checked = block.saves.includes(cb.dataset.save);
    });
    $$("[data-skill]", creatureForm).forEach((cb) => {
      cb.checked = block.skills.includes(cb.dataset.skill);
    });
    $$("[data-expertise]", creatureForm).forEach((cb) => {
      cb.checked = block.expertise.includes(cb.dataset.expertise);
    });
    $$("[data-def]", creatureForm).forEach((cb) => {
      cb.checked = (block[cb.dataset.def] || []).includes(cb.value);
    });

    $("#attack-rows").innerHTML = (block.attacks || [])
      .map(attackRowHtml)
      .join("");
    $("#recharge-rows").innerHTML = (block.recharges || [])
      .map(rechargeRowHtml)
      .join("");
    $("#spell-rows").innerHTML = block.spellSlots.map(spellRowHtml).join("");

    $("#saves-details").open = block.saves.length > 0;
    $("#skills-details").open = block.skills.length > 0;
    $("#senses-details").open = !!(block.senses || block.languages);
    $("#defenses-details").open =
      LIST_FIELDS.some((k) => block[k].length) || !!block.damageNotes;
    $("#attacks-details").open =
      (block.attacks || []).length > 0 || !!block.multiattack;
    $("#recharge-details").open = (block.recharges || []).length > 0;
    $("#legendary-details").open = !!(
      block.legendaryActions ||
      block.legendaryResistance ||
      block.legendaryText
    );
    $("#text-details").open = !!(
      block.traits ||
      block.actions ||
      block.reactions
    );
    $("#spell-details").open = block.spellSlots.length > 0;
    f.saveToLibrary.checked = false;
    f.startHidden.checked = startHidden[type];
    refreshFormCalcs();
  }

  /** Read the builder into a normalised template of the given type. */
  function readCreatureForm(type) {
    const f = creatureForm.elements;
    const checked = (attr) =>
      $$(`[${attr}]`, creatureForm).filter((cb) => cb.checked);
    const shared = {
      name: f.name.value,
      hp: { max: f.hpMax.value },
      ac: f.ac.value,
      speed: f.speed.value,
      stats: Object.fromEntries(STAT_KEYS.map((k) => [k, f[k].value])),
      // Blank init bonus falls back to the DEX modifier.
      initBonus: f.initBonus.value.trim() === "" ? null : f.initBonus.value,
      saves: checked("data-save").map((cb) => cb.dataset.save),
      skills: checked("data-skill").map((cb) => cb.dataset.skill),
      expertise: checked("data-expertise").map((cb) => cb.dataset.expertise),
      spellSlots: $$(".spell-row", creatureForm).map((row) => ({
        level: $('[data-spell="level"]', row).value,
        current: $('[data-spell="current"]', row).value,
        max: $('[data-spell="max"]', row).value,
        recovery: $('[data-spell="recovery"]', row).value,
      })),
    };
    TEXT_FIELDS.forEach((k) => {
      shared[k] = f[k].value;
    });
    LIST_FIELDS.forEach((k) => {
      shared[k] = $$(`[data-def="${k}"]`, creatureForm)
        .filter((cb) => cb.checked)
        .map((cb) => cb.value);
    });

    const specific =
      type === "pc"
        ? {
            level: f.level.value,
            cls: f.cls.value,
            race: f.race.value,
          }
        : {
            cr: f.cr.value,
            legendaryActions: f.legendaryActions.value,
            legendaryResistance: f.legendaryResistance.value,
            ...Object.fromEntries(
              ENEMY_TEXT_FIELDS.map((k) => [k, f[k].value]),
            ),
            attacks: $$(".attack-row", creatureForm)
              .map((row) => ({
                name: $('[data-atk="name"]', row).value,
                kind: $('[data-atk="kind"]', row).value,
                ability: $('[data-atk="ability"]', row).value,
                toHit: $('[data-atk="toHit"]', row).value,
                saveDc: $('[data-atk="saveDc"]', row).value,
                saveAbility: $('[data-atk="saveAbility"]', row).value,
                halfOnSave: $('[data-atk="halfOnSave"]', row).checked,
                dmgDice: $('[data-atk="dmgDice"]', row).value,
                dmgBonus: $('[data-atk="dmgBonus"]', row).value,
                dmgType: $('[data-atk="dmgType"]', row).value,
                note: $('[data-atk="note"]', row).value,
                autoToHit: row.dataset.autoHit === "1",
                autoDmg: row.dataset.autoDmg === "1",
                autoSaveDc: row.dataset.autoDc === "1",
              }))
              .filter((a) => String(a.name).trim()),
            recharges: $$(".recharge-row", creatureForm)
              .map((row) => ({
                name: $('[data-recharge="name"]', row).value,
                min: $('[data-recharge="min"]', row).value,
              }))
              .filter((r) => String(r.name).trim()),
          };
    return {
      block: normalizeTemplate({ ...shared, ...specific }, type),
      initiative: toInt(f.initiative.value, 0),
      saveToLibrary: f.saveToLibrary.checked,
      hidden: f.startHidden.checked,
    };
  }

  /**
   * Modes:
   *   library-new    { type, seed? }           → new template in library (seed prefills)
   *   library-edit   { type, templateId }      → edit template
   *   encounter-new  { type }                  → new one-off instance in active encounter
   *   instance-edit  { instanceId }            → edit an instance's stat block
   */
  function openCreatureModal(ctx) {
    creatureCtx = ctx;
    const typeLabel = ctx.type === "pc" ? "Player Character" : "Enemy";
    const title =
      {
        "library-new": ctx.seed
          ? `New ${typeLabel} (variant)`
          : `New ${typeLabel}`,
        "library-edit": `Edit ${typeLabel}`,
        "encounter-new": `Add ${typeLabel} to Encounter`,
        "instance-edit": "Edit Combatant",
      }[ctx.mode] || "Creature";
    $("#creature-modal-title").textContent = title;
    $("#creature-submit").textContent =
      ctx.mode === "encounter-new" ? "Add to Encounter" : "Save";

    $$("[data-for]", creatureForm).forEach((el) =>
      el.classList.toggle("hidden", el.dataset.for !== ctx.type),
    );
    const showInit =
      ctx.mode === "encounter-new" || ctx.mode === "instance-edit";
    $("#creature-initiative-field").classList.toggle("hidden", !showInit);
    $("#creature-initiative-label").textContent = "Initiative";
    $("#save-to-library-field").classList.toggle(
      "hidden",
      ctx.mode !== "encounter-new",
    );
    $("#creature-hidden-field").classList.toggle(
      "hidden",
      ctx.mode !== "encounter-new",
    );

    let seed = ctx.seed || {
      name: "",
      hp: { max: 10 },
      ac: 10,
      speed: "30 ft.",
      stats: {},
      spellSlots: [],
      initiative: 0,
      level: 1,
      cr: "1",
    };
    if (ctx.mode === "library-edit")
      seed = findTemplate(ctx.templateId) || seed;
    if (ctx.mode === "instance-edit")
      seed = findCombatant(ctx.instanceId) || seed;
    fillCreatureForm(seed, ctx.type);

    openModal(creatureModal);
    requestAnimationFrame(() => creatureForm.elements.name.focus());
  }

  creatureForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const nameInput = creatureForm.elements.name;
    if (!nameInput.value.trim()) {
      nameInput.focus();
      nameInput.reportValidity();
      return;
    }

    const ctx = creatureCtx;
    const { block, initiative, saveToLibrary, hidden } = readCreatureForm(
      ctx.type,
    );
    let undoLabel = null;

    if (ctx.mode === "library-new") {
      libraryList(ctx.type).push({ id: uuid(), ...block });
      toast(`${block.name} added to the library.`);
    }

    if (ctx.mode === "library-edit") {
      const t = findTemplate(ctx.templateId);
      if (t) Object.assign(t, block);
      toast(`${block.name} updated.`);
    }

    if (ctx.mode === "encounter-new") {
      const enc = activeEncounter();
      if (!enc) return;
      if (ctx.type === "pc" && R.duplicatePc(enc, null, block.name)) {
        toast(`${block.name.trim()} is already in this encounter.`);
        nameInput.focus();
        return;
      }
      let templateId = null;
      if (saveToLibrary) {
        const t = { id: uuid(), ...block };
        libraryList(ctx.type).push(t);
        templateId = t.id;
      }
      const inst = instantiate(block, ctx.type, initiative, templateId);
      // A one-off keeps the spell slot counts the DM typed rather than entering full.
      inst.spellSlots = block.spellSlots.map((s) => ({ ...s }));
      inst.initiative = initiative + initBonusOf(inst);
      inst.name = uniqueName(enc, block.name);
      inst.hidden = hidden;
      startHidden[ctx.type] = hidden;
      enc.combatants.push(inst);
      sortEncounter(enc);
      logEntry(
        "info",
        `${inst.name} joined the encounter${inst.hidden ? ", hidden from the players" : ""}.`,
        enc,
      );
      toast(`${inst.name} joins the fray.`);
      undoLabel = `Add ${inst.name}`;
    }

    if (ctx.mode === "instance-edit") {
      const enc = activeEncounter();
      const idx = enc
        ? enc.combatants.findIndex((x) => x.instanceId === ctx.instanceId)
        : -1;
      if (idx >= 0) {
        const old = enc.combatants[idx];
        // A group shares one stat block, so the edit goes to every member. Each keeps its own
        // name, notes and HP (current HP follows max if it was full) and recharge status.
        R.groupMembers(enc, old).forEach((m) => {
          const current =
            m.hp.current >= m.hp.max
              ? block.hp.max
              : Math.min(m.hp.current, block.hp.max);
          const recharges = (block.recharges || []).map((r) => {
            const prev = m.recharges?.find((p) => p.name === r.name);
            return {
              ...r,
              available: prev ? prev.available : true,
              lastRoll: prev?.lastRoll ?? null,
            };
          });
          const edited = m === old;
          enc.combatants[enc.combatants.indexOf(m)] = normalizeInstance({
            ...m,
            ...block,
            initiative,
            recharges,
            name: edited ? block.name : m.name,
            notes: edited && "notes" in block ? block.notes : m.notes,
            initRank: initiative === m.initiative ? m.initRank : 0,
            hp: { max: block.hp.max, current, temp: m.hp.temp },
          });
        });
        sortEncounter(enc);
        undoLabel = `Edit ${old.name}`;
      }
    }

    creatureModal.close("ok");
    commit({ undo: undoLabel });
  });

  /* Builder: repeatable rows */
  function addRow(hostSel, html, focusSel) {
    const host = $(hostSel);
    host.insertAdjacentHTML("beforeend", html);
    refreshFormCalcs();
    $$(focusSel, host).at(-1)?.focus();
  }

  $("#btn-add-spell-level").addEventListener("click", () => {
    const existing = $$('[data-spell="level"]', $("#spell-rows")).map((i) =>
      toInt(i.value, 0),
    );
    const nextLevel = clamp(
      (existing.length ? Math.max(...existing) : 0) + 1,
      1,
      9,
    );
    addRow(
      "#spell-rows",
      spellRowHtml({ level: nextLevel, current: 1, max: 1, recovery: "long" }),
      '[data-spell="max"]',
    );
  });
  $("#btn-add-attack").addEventListener("click", () =>
    addRow("#attack-rows", attackRowHtml(), '[data-atk="name"]'),
  );
  $("#btn-add-recharge").addEventListener("click", () =>
    addRow("#recharge-rows", rechargeRowHtml(), '[data-recharge="name"]'),
  );

  creatureForm.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="remove-row"]');
    if (btn) btn.closest("[data-row]").remove();
  });

  /* Builder: live calculations. Typing in an auto field takes it over. */
  const AUTO_FIELDS = {
    toHit: "autoHit",
    dmgBonus: "autoDmg",
    saveDc: "autoDc",
  };
  creatureForm.addEventListener("input", (e) => {
    const flag = AUTO_FIELDS[e.target.dataset?.atk];
    const row = e.target.closest(".attack-row");
    if (row && flag) row.dataset[flag] = "0";
    // Expertise needs proficiency, and dropping proficiency drops expertise.
    if (e.target.dataset?.expertise && e.target.checked)
      $(`[data-skill="${e.target.dataset.expertise}"]`, creatureForm).checked =
        true;
    if (e.target.dataset?.skill && !e.target.checked)
      $(`[data-expertise="${e.target.dataset.skill}"]`, creatureForm).checked =
        false;
    refreshFormCalcs();
  });
  /* Clearing an overridden auto field hands it back to the calculator. */
  creatureForm.addEventListener("change", (e) => {
    const flag = AUTO_FIELDS[e.target.dataset?.atk];
    const row = e.target.closest(".attack-row");
    if (row && flag && e.target.value.trim() === "") row.dataset[flag] = "1";
    refreshFormCalcs();
  });

  wireDialogChrome(creatureModal);

  /** Group info and the button that opens the group dialog (enemies only). */
  function groupSectionHtml(c, enc) {
    const members = R.groupMembers(enc, c);
    const others = members
      .filter((m) => m !== c)
      .map((m) => escapeHtml(m.name));
    return `
      <section class="detail-section">
        <h3 class="detail-section-title">Group</h3>
        <p class="detail-text">${
          c.groupId
            ? `In a group with ${others.join(", ")}. They share initiative and stat block; HP is separate.`
            : "Not in a group. Grouped enemies share initiative and stat block, with separate HP."
        }</p>
        <button class="btn btn-ghost btn-sm" type="button" data-action="edit-group">${c.groupId ? "Edit group…" : "Group with others…"}</button>
      </section>`;
  }

  /* ---------- Detail modal ---------- */
  const detailModal = $("#detail-modal");
  let detailId = null;
  /** Rounds typed into the duration box, kept while the modal re-renders. */
  let conditionRounds = "";

  function openDetail(instanceId) {
    detailId = instanceId;
    openModal(detailModal);
    renderDetail();
  }

  function renderDetail() {
    if (!detailModal.open) return;
    const c = findCombatant(detailId);
    if (!c) {
      detailModal.close();
      return;
    }

    $("#detail-title").textContent = c.name;
    $("#detail-subtitle").textContent = subtitleFor(c, false, true);
    $("#detail-edit").classList.toggle("hidden", c.type === "lair");
    const body = $("#detail-body");
    const scroll = body.scrollTop;
    body.innerHTML =
      c.type === "lair"
        ? lairDetailHtml(c)
        : creatureDetailHtml(c, activeEncounter());
    body.scrollTop = scroll;
  }

  function lairDetailHtml(c) {
    return `
      <section class="detail-section">
        <label class="field field-wide">
          <span class="field-label">Name</span>
          <input type="text" data-detail-field="name" value="${escapeHtml(c.name)}" autocomplete="off">
        </label>
        <label class="field field-wide">
          <span class="field-label">Lair actions</span>
          <textarea data-detail-field="notes" rows="8" placeholder="One per line. The DM picks one on initiative 20 each round.">${escapeHtml(c.notes)}</textarea>
        </label>
      </section>`;
  }

  /** A titled, escaped block of free text with line breaks kept. */
  const textSection = (title, body) =>
    body && body.trim()
      ? `
    <section class="detail-section">
      <h3 class="detail-section-title">${title}</h3>
      <p class="detail-prose">${escapeHtml(body.trim())}</p>
    </section>`
      : "";

  const listLine = (label, items) =>
    items && items.length
      ? `<p class="detail-text"><b>${label}</b> ${escapeHtml(items.join(", "))}</p>`
      : "";

  function creatureDetailHtml(c, enc) {
    const isPc = c.type === "pc";
    const summary = [
      ["AC", toInt(c.ac, 10)],
      [
        "HP",
        `${c.hp.current}/${c.hp.max}${c.hp.temp ? ` <small>+${c.hp.temp} temp</small>` : ""}`,
      ],
      ["Speed", escapeHtml(c.speed || "—")],
      ["Initiative", toInt(c.initiative, 0)],
      [
        "Init Bonus",
        `${formatMod(initBonusOf(c))}${c.initBonus === null ? " <small>DEX</small>" : ""}`,
      ],
      ["P. Perception", R.passivePerception(c)],
      isPc
        ? ["Proficiency", formatMod(R.profOf(c))]
        : [
            "CR",
            c.cr
              ? `${c.cr} <small>${R.xpForCr(c.cr).toLocaleString()} XP · prof ${formatMod(profFromCr(c.cr))}</small>`
              : "—",
          ],
    ]
      .map(
        ([label, value]) => `
      <div class="detail-stat"><span class="detail-stat-label">${label}</span><span class="detail-stat-value">${value}</span></div>`,
      )
      .join("");

    const abilities = STAT_KEYS.map((k) => {
      const score = toInt(c.stats?.[k], 10);
      const prof = c.saves.includes(k);
      return `
        <div class="detail-ability ${prof ? "is-save-prof" : ""}" title="${STAT_NAMES[k]}${prof ? ", proficient save" : ""}">
          <span class="stat-label">${k.toUpperCase()}</span>
          <span class="detail-ability-score">${score}</span>
          <span class="detail-ability-mod">${formatMod(modifier(score))}</span>
          <span class="detail-ability-save">Save ${formatMod(saveBonus(c, k))}</span>
        </div>`;
    }).join("");

    const typeLine = isPc
      ? ""
      : [c.creatureType, c.alignment].filter(Boolean).join(", ");
    const statLines = [
      typeLine
        ? `<p class="detail-text detail-text--italic">${escapeHtml(typeLine)}</p>`
        : "",
      c.skills.length
        ? `<p class="detail-text"><b>Skills</b> ${escapeHtml(skillsText(c))}</p>`
        : "",
      listLine("Vulnerabilities", c.damageVulnerabilities),
      listLine("Resistances", c.damageResistances),
      listLine("Immunities", c.damageImmunities),
      c.damageNotes
        ? `<p class="detail-text"><b>Defense notes</b> ${escapeHtml(c.damageNotes)}</p>`
        : "",
      listLine("Condition immunities", c.conditionImmunities),
      `<p class="detail-text"><b>Senses</b> ${escapeHtml([c.senses, `P. Perception ${R.passivePerception(c)}`].filter(Boolean).join(", "))}</p>`,
      c.languages
        ? `<p class="detail-text"><b>Languages</b> ${escapeHtml(c.languages)}</p>`
        : "",
    ].join("");

    const conditions = CONDITIONS.map((cond) => {
      const on = R.hasCondition(c, cond);
      const immune = R.isImmuneTo(c, cond);
      return `
        <button class="chip chip--toggle ${on ? "is-on" : ""} ${immune ? "is-immune" : ""}" type="button"
                data-action="toggle-condition" data-condition="${cond}" aria-pressed="${on}"
                title="${escapeHtml(CONDITION_EFFECTS[cond])}${immune ? " (immune)" : ""}">${cond}</button>`;
    }).join("");
    const activeEffects = c.conditions.length
      ? `
      <ul class="effect-list">
        ${c.conditions
          .map((cond) => {
            const left = R.roundsLeft(cond, enc.round);
            const stepper = (delta, label) => `
            <button class="icon-btn" type="button" data-action="condition-rounds" data-condition="${cond.name}" data-delta="${delta}"
                    aria-label="${label} ${cond.name}"${delta < 0 && (left === null || left <= 1) ? " disabled" : ""}>${delta < 0 ? "−" : "+"}</button>`;
            return `<li><b>${cond.name}</b>${left === null ? "" : ` <small>${left} round${left === 1 ? "" : "s"} left</small>`}
            <span class="effect-steps">${stepper(-1, "Shorten")}${stepper(1, "Extend")}</span> ${escapeHtml(CONDITION_EFFECTS[cond.name])}</li>`;
          })
          .join("")}
      </ul>`
      : "";
    const exhaustionEffects = c.exhaustion
      ? `
      <ul class="effect-list effect-list--exh">
        ${R.exhaustionEffects(c.exhaustion)
          .map(
            (e, i) =>
              `<li><b>Level ${i + 1}</b> ${escapeHtml(e)}${i === 3 ? " <small>(not applied automatically)</small>" : ""}</li>`,
          )
          .join("")}
      </ul>`
      : "";

    const recharges = c.recharges?.length
      ? c.recharges
          .map(
            (r, i) => `
      <div class="recharge-item ${r.available ? "is-ready" : "is-spent"}">
        <span class="recharge-name">${escapeHtml(r.name)} <small>Recharge ${rechargeLabel(r.min)}</small></span>
        <span class="recharge-state">${r.available ? "Ready" : "Spent"}</span>
        <button class="btn btn-ghost btn-sm" type="button" data-action="toggle-recharge" data-recharge-index="${i}">${r.available ? "Use" : "Restore"}</button>
      </div>`,
          )
          .join("")
      : `<p class="detail-empty">No recharge abilities. Add them with Edit Stat Block.</p>`;

    const attacks =
      c.attacks?.length || c.multiattack
        ? `
      <section class="detail-section">
        <h3 class="detail-section-title">Attacks</h3>
        ${c.multiattack ? `<p class="detail-text"><b>Multiattack.</b> ${escapeHtml(c.multiattack)}</p>` : ""}
        <div class="card-attacks">${(c.attacks || []).map((a) => attackHtml(a)).join("")}</div>
      </section>`
        : "";

    // Attacks, stat block text and spell slots sit below the trackers, side by side when there's room.
    const extras = [
      attacks,
      textSection("Traits", c.traits),
      textSection("Actions", c.actions),
      textSection("Reactions", c.reactions),
      textSection(
        `Legendary Actions${c.legendaryActions ? ` (${c.legendaryActions}/round)` : ""}`,
        c.legendaryText,
      ),
      spellBlockHtml(c),
    ].filter(Boolean);

    return `
      <div class="detail-summary">${summary}</div>

      <section class="detail-section">
        <h3 class="detail-section-title">Ability Scores &amp; Saves</h3>
        <div class="detail-abilities">${abilities}</div>
        <div class="detail-statlines">${statLines}</div>
      </section>

      <div class="detail-grid">
        <div class="detail-col">
          <section class="detail-section">
            <h3 class="detail-section-title">Conditions</h3>
            <label class="duration-field">
              <span>Ends after</span>
              <input type="number" min="1" max="100" id="condition-rounds" value="${escapeHtml(conditionRounds)}" placeholder="∞" aria-describedby="condition-rounds-hint">
              <span>rounds when switched on</span>
            </label>
            <p class="detail-hint" id="condition-rounds-hint">Leave blank for no duration. A condition expires when the round after its last round begins.</p>
            <div class="chip-grid">${conditions}</div>
            ${activeEffects}
            <div class="exhaustion">
              <span class="field-label">Exhaustion</span>
              <button class="icon-btn" type="button" data-action="exhaustion" data-delta="-1" aria-label="Decrease exhaustion">−</button>
              <span class="exhaustion-value ${c.exhaustion ? "is-on" : ""}">${c.exhaustion}</span>
              <button class="icon-btn" type="button" data-action="exhaustion" data-delta="1" aria-label="Increase exhaustion">+</button>
            </div>
            ${exhaustionEffects}
          </section>

          <section class="detail-section">
            <h3 class="detail-section-title">Turn &amp; Actions</h3>
            ${economyHtml(c, enc.round)}
            ${legendaryHtml(c)}
          </section>
          ${c.type === "enemy" ? groupSectionHtml(c, enc) : ""}
        </div>

        <div class="detail-col">
          <section class="detail-section">
            <h3 class="detail-section-title">Concentration</h3>
            <div class="concentration ${c.concentration.active ? "is-on" : ""}">
              <button class="chip chip--toggle chip--conc-toggle ${c.concentration.active ? "is-on" : ""}" type="button"
                      data-action="toggle-concentration" aria-pressed="${c.concentration.active}">
                ◉ ${c.concentration.active ? "Concentrating" : "Not concentrating"}
              </button>
              <input type="text" data-detail-field="concentrationSpell" value="${escapeHtml(c.concentration.spell)}"
                     placeholder="Spell name" autocomplete="off" aria-label="Concentration spell">
            </div>
            ${concCheckHtml(c, true)}
            <p class="detail-hint">DC is 10 or half the damage taken, whichever is higher. One save per damage source.</p>
          </section>

          ${
            isPc
              ? `
            <section class="detail-section">
              <h3 class="detail-section-title">Death Saves</h3>
              ${deathSavesHtml(c)}
              <button class="btn btn-ghost btn-sm" type="button" data-action="reset-death-saves">Reset</button>
            </section>`
              : `
            <section class="detail-section">
              <h3 class="detail-section-title">Recharge Abilities</h3>
              <p class="detail-hint">Roll the recharge die at the start of this creature's turn, then press Restore if it recharges.</p>
              ${recharges}
            </section>`
          }

          <section class="detail-section">
            <label class="field field-wide">
              <span class="detail-section-title">DM Notes</span>
              <textarea data-detail-field="notes" rows="3" placeholder="Tactics, e.g. retreats at half HP">${escapeHtml(c.notes)}</textarea>
            </label>
          </section>
        </div>
      </div>

      ${extras.length ? `<div class="detail-extras">${extras.join("")}</div>` : ""}`;
  }

  /**
   * State-changing actions shared by cards and the detail modal.
   * Returns false (nothing changed), true (changed, not undoable) or an undo label.
   */
  function applyCombatantAction(c, btn, enc) {
    const p = toInt(btn.dataset.pipIndex, 0);
    const pipValue = (current, max) => clamp(p < current ? p : p + 1, 0, max);
    switch (btn.dataset.action) {
      case "toggle-pip": {
        const slot = c.spellSlots?.[toInt(btn.dataset.slotIndex, -1)];
        if (!slot) return false;
        slot.current = pipValue(slot.current, slot.max);
        return `Spell slot (${c.name})`;
      }
      case "legendary-pip": {
        if (btn.dataset.kind === "resistance") {
          c.legendaryResistanceLeft = pipValue(
            c.legendaryResistanceLeft,
            c.legendaryResistance,
          );
          logEntry(
            "info",
            `${c.name}: legendary resistance ${c.legendaryResistanceLeft}/${c.legendaryResistance}.`,
            enc,
          );
        } else {
          c.legendaryActionsLeft = pipValue(
            c.legendaryActionsLeft,
            c.legendaryActions,
          );
          logEntry(
            "info",
            `${c.name}: legendary actions ${c.legendaryActionsLeft}/${c.legendaryActions}.`,
            enc,
          );
        }
        return `Legendary (${c.name})`;
      }
      case "death-save": {
        const kind = btn.dataset.kind === "fail" ? "fail" : "success";
        const i = toInt(btn.dataset.index, 0);
        c.deathSaves[kind] = i < c.deathSaves[kind] ? i : i + 1;
        logEntry(
          "death",
          `${c.name}: death saves ${c.deathSaves.success} ✓ / ${c.deathSaves.fail} ✗.`,
          enc,
        );
        return `Death save (${c.name})`;
      }
      case "reset-death-saves":
        c.deathSaves = { success: 0, fail: 0 };
        return `Reset death saves (${c.name})`;
      case "toggle-recharge": {
        const r = c.recharges?.[toInt(btn.dataset.rechargeIndex, -1)];
        if (!r) return false;
        r.available = !r.available;
        logEntry(
          "recharge",
          `${c.name}: ${r.name} ${r.available ? "restored" : "used"}.`,
          enc,
        );
        return `${r.name} (${c.name})`;
      }
      case "toggle-condition": {
        const res = R.toggleCondition(c, btn.dataset.condition, {
          rounds: conditionRounds,
          round: enc.round,
        });
        announce(res.events, { enc });
        return res.blocked ? true : `${btn.dataset.condition} (${c.name})`;
      }
      case "condition-rounds": {
        const events = R.changeConditionRounds(
          c,
          btn.dataset.condition,
          toInt(btn.dataset.delta, 0),
          enc.round,
        );
        announce(events, { enc, quiet: true });
        return events.length
          ? `${btn.dataset.condition} duration (${c.name})`
          : false;
      }
      case "exhaustion": {
        const res = R.changeExhaustion(c, toInt(btn.dataset.delta, 0));
        announce(res.events, { enc });
        return res.events.length && !res.blocked
          ? `Exhaustion (${c.name})`
          : res.blocked;
      }
      case "toggle-concentration":
        c.concentration.active = !c.concentration.active;
        if (!c.concentration.active) c.concentrationCheck = null;
        logEntry(
          "concentration",
          `${c.name} ${c.concentration.active ? "starts" : "stops"} concentrating${c.concentration.spell ? ` on ${c.concentration.spell}` : ""}.`,
          enc,
        );
        return `Concentration (${c.name})`;
      case "dismiss-conc-check":
        c.concentrationCheck = null;
        return true;
      case "toggle-action":
        c.actionUsed = !c.actionUsed;
        return `Action (${c.name})`;
      case "toggle-reaction":
        c.reactionUsed = !c.reactionUsed;
        return `Reaction (${c.name})`;
      case "toggle-bonus":
        c.bonusActionUsed = !c.bonusActionUsed;
        return `Bonus action (${c.name})`;
      case "toggle-hidden":
        if (c.type === "lair") return false;
        c.hidden = !c.hidden;
        // A group is hidden and revealed together
        R.groupMembers(enc, c).forEach((m) => {
          m.hidden = c.hidden;
        });
        logEntry(
          "info",
          `${c.name}${c.groupId ? " and its group are" : " is"} ${c.hidden ? "now hidden from" : "revealed to"} the players.`,
          enc,
        );
        return `${c.hidden ? "Hide" : "Reveal"} (${c.name})`;
      case "edit-group":
        openGroupDialog(c);
        return false;
      case "toggle-surprised":
        c.surprised = !c.surprised;
        logEntry(
          "info",
          `${c.name} is ${c.surprised ? "" : "no longer "}surprised.`,
          enc,
        );
        return `Surprised (${c.name})`;
    }
    return false;
  }

  function runCombatantAction(c, btn) {
    const result = applyCombatantAction(c, btn, activeEncounter());
    if (result) commit({ undo: typeof result === "string" ? result : null });
  }

  $("#detail-body").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    const c = findCombatant(detailId);
    if (!btn || !c) return;
    runCombatantAction(c, btn);
  });

  /* Text fields save as you type but only repaint the cards behind the
     modal on change, so focus and clicks inside the modal aren't disturbed. */
  $("#detail-body").addEventListener("input", (e) => {
    if (e.target.id === "condition-rounds") {
      conditionRounds = e.target.value;
      return;
    }
    const field = e.target.dataset.detailField;
    const c = findCombatant(detailId);
    if (!field || !c) return;
    if (field === "concentrationSpell") c.concentration.spell = e.target.value;
    if (field === "notes") c.notes = e.target.value;
    if (field === "name") {
      c.name = e.target.value;
      $("#detail-title").textContent = c.name || "Lair Action";
    }
    saveState();
  });
  $("#detail-body").addEventListener("change", (e) => {
    if (!e.target.dataset.detailField) return;
    const c = findCombatant(detailId);
    if (c?.type === "lair" && !c.name.trim()) {
      c.name = "Lair Action";
      saveState();
    }
    renderActiveEncounter();
  });

  $("#detail-edit").addEventListener("click", () => {
    const c = findCombatant(detailId);
    detailModal.close();
    if (c)
      openCreatureModal({
        mode: "instance-edit",
        type: c.type,
        instanceId: c.instanceId,
      });
  });

  detailModal.addEventListener("close", () => {
    detailId = null;
  });
  wireDialogChrome(detailModal);

  /* ---------- Picker (add from library) ---------- */
  const pickerModal = $("#picker-modal");
  let pickerType = "pc";

  function updatePickerInitLabel() {
    const t = findTemplate($("#picker-select").value);
    $("#picker-init-label").textContent = t
      ? `Initiative roll (bonus will be applied: ${formatMod(initBonusOf({ ...t, type: pickerType }))})`
      : "Initiative roll";
  }

  function openPicker(type) {
    pickerType = type;
    const enc = activeEncounter();
    const list = libraryList(type);
    $("#picker-title").textContent =
      type === "pc" ? "Add Player Character" : "Add Enemy";
    const select = $("#picker-select");
    // A PC already in the encounter cannot be picked again
    const taken = (t) =>
      type === "pc" && !!enc && !!R.duplicatePc(enc, t.id, t.name);
    select.innerHTML = list
      .map((t) => {
        const extra =
          type === "pc" ? `Lvl ${t.level}` : t.cr ? `CR ${t.cr}` : "";
        const init = formatMod(initBonusOf({ ...t, type }));
        const detail = taken(t)
          ? "already in this encounter"
          : [
              extra,
              `HP ${toInt(t.hp?.max, 0)}`,
              `AC ${toInt(t.ac, 10)}`,
              `Init ${init}`,
            ]
              .filter(Boolean)
              .join(", ");
        return `<option value="${t.id}" ${taken(t) ? "disabled" : ""}>${escapeHtml(t.name)} — ${detail}</option>`;
      })
      .join("");
    const firstFree = list.find((t) => !taken(t));
    if (firstFree) select.value = firstFree.id;
    const empty = !firstFree;
    $("#picker-empty").textContent =
      list.length === 0
        ? "The library has nothing of this kind yet."
        : "Every player character in the library is already in this encounter.";
    $("#picker-empty").classList.toggle("hidden", !empty);
    select.disabled = empty;
    $("#picker-submit").disabled = empty;
    const f = $("#picker-form").elements;
    f.initiative.value = 0;
    f.count.value = 1;
    // PCs are added one at a time
    $("#picker-count-field").classList.toggle("hidden", type === "pc");
    f.asGroup.checked = true;
    updatePickerGroupField();
    f.startHidden.checked = startHidden[type];
    updatePickerInitLabel();
    openModal(pickerModal);
    requestAnimationFrame(() =>
      (empty ? $("#picker-create-new") : select).focus(),
    );
  }

  /** The group option only matters for several enemies at once. */
  function updatePickerGroupField() {
    const count = toInt($("#picker-form").elements.count.value, 1);
    $("#picker-group-field").classList.toggle(
      "hidden",
      pickerType !== "enemy" || count < 2,
    );
  }
  $("#picker-form").elements.count.addEventListener(
    "input",
    updatePickerGroupField,
  );

  $("#picker-select").addEventListener("change", updatePickerInitLabel);

  $("#picker-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const enc = activeEncounter();
    if (!enc) return;
    const f = e.target.elements;
    startHidden[pickerType] = f.startHidden.checked;
    const added = addCombatantsFromTemplate(
      enc,
      f.templateId.value,
      f.initiative.value,
      f.count.value,
      f.startHidden.checked,
      f.asGroup.checked,
    );
    pickerModal.close("ok");
    if (added)
      toast(`${added === 1 ? "1 combatant" : `${added} combatants`} added.`);
    commit({
      undo: added
        ? `Add ${added === 1 ? "combatant" : `${added} combatants`}`
        : null,
    });
  });

  $("#picker-create-new").addEventListener("click", () => {
    pickerModal.close("cancel");
    openCreatureModal({ mode: "encounter-new", type: pickerType });
  });

  wireDialogChrome(pickerModal);

  /* ======================================================================
     6. Event wiring
     ====================================================================== */

  /* ---------- Tabs ---------- */
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      state.ui.view = tab.dataset.view;
      commit();
    }),
  );

  /* ---------- New encounter ---------- */
  async function createEncounter() {
    const name = await promptDialog({
      title: "New Encounter",
      label: "Encounter name",
      okLabel: "Create",
    });
    if (!name) return;
    const enc = normalizeEncounter({
      id: uuid(),
      name,
      round: 1,
      currentTurnIndex: 0,
      combatants: [],
    });
    state.encounters.unshift(enc);
    state.ui.activeEncounterId = enc.id;
    state.ui.view = "active";
    toast(`${name} begins.`);
    commit();
  }
  $("#btn-new-encounter").addEventListener("click", createEncounter);
  $("#btn-new-encounter-from-active").addEventListener(
    "click",
    createEncounter,
  );

  /* ---------- Encounter list actions ---------- */
  $("#encounter-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const card = btn.closest("[data-encounter-id]");
    const enc = findEncounter(card?.dataset.encounterId);
    if (!enc) return;

    switch (btn.dataset.action) {
      case "open-encounter":
        state.ui.activeEncounterId = enc.id;
        state.ui.view = "active";
        commit();
        break;

      case "rename-encounter": {
        const name = await promptDialog({
          title: "Rename Encounter",
          label: "Encounter name",
          value: enc.name,
          okLabel: "Rename",
        });
        if (name && name !== enc.name) {
          enc.name = name;
          commit();
        }
        break;
      }

      case "duplicate-encounter": {
        const copy = R.duplicateEncounter(enc);
        state.encounters.splice(state.encounters.indexOf(enc) + 1, 0, copy);
        toast(`${copy.name} created at round 1, everyone at full strength.`);
        commit();
        break;
      }

      case "delete-encounter": {
        const ok = await confirmDialog({
          title: "Delete Encounter",
          html: `Delete <strong>${escapeHtml(enc.name)}</strong> and all of its combatants? The library is untouched. This cannot be undone.`,
        });
        if (!ok) return;
        state.encounters = state.encounters.filter((x) => x.id !== enc.id);
        if (state.ui.activeEncounterId === enc.id)
          state.ui.activeEncounterId = null;
        toast(`${enc.name} deleted.`);
        commit();
        break;
      }
    }
  });

  /* ---------- Tracker controls ---------- */
  const withEncounter =
    (fn) =>
    (...args) => {
      const enc = activeEncounter();
      if (enc) fn(enc, ...args);
    };

  $("#btn-next-turn").addEventListener(
    "click",
    withEncounter((enc) => {
      nextTurn(enc);
      commit({ undo: "Next turn" });
      liveSay(turnAnnouncement(enc));
    }),
  );
  $("#btn-prev-turn").addEventListener(
    "click",
    withEncounter((enc) => {
      prevTurn(enc);
      commit({ undo: "Previous turn" });
      liveSay(turnAnnouncement(enc));
    }),
  );
  $("#btn-reset-round").addEventListener(
    "click",
    withEncounter((enc) => {
      const events = R.resetRound(enc);
      if (!events) return;
      announce(events, { enc, quiet: true });
      roundBump = true;
      commit({ undo: "Reset round" });
      toast("Round counter reset to 1.", { action: { label: "Undo", run: undo } });
    }),
  );

  $("#btn-add-pc").addEventListener("click", () => openPicker("pc"));
  $("#btn-add-enemy").addEventListener("click", () => openPicker("enemy"));
  $("#btn-add-lair").addEventListener(
    "click",
    withEncounter((enc) => {
      enc.combatants.push(makeLair());
      sortEncounter(enc);
      toast("Lair action added at initiative 20.");
      commit({ undo: "Add lair action" });
    }),
  );

  /** End the open encounter: stop the clock, close it, and go back to the list. It stays saved. */
  async function endEncounter(enc) {
    const rounds = enc.round === 1 ? "1 round" : `${enc.round} rounds`;
    const ok = await confirmDialog({
      title: "End Encounter",
      html: `End <strong>${escapeHtml(enc.name)}</strong> (${rounds}, ${formatClock(clockElapsed(enc))})? It stays saved in the Encounters list, and the player display goes back to waiting.`,
      okLabel: "End Encounter",
      danger: false,
    });
    if (!ok) return;
    pauseClock(enc);
    logEntry(
      "info",
      `Encounter ended after ${rounds}, ${formatClock(clockElapsed(enc))}.`,
      enc,
    );
    state.ui.activeEncounterId = null;
    state.ui.view = "encounters";
    toast(`${enc.name} ended.`);
    commit();
  }
  $("#btn-end-encounter").addEventListener(
    "click",
    withEncounter(endEncounter),
  );

  /** Hide or reveal every enemy at once (the player display leaves hidden ones out). */
  function setEnemiesHidden(enc, hidden) {
    const changing = enc.combatants.filter(
      (c) => c.type === "enemy" && !!c.hidden !== hidden,
    );
    if (!changing.length) {
      toast(
        hidden ? "Every enemy is already hidden." : "No enemies are hidden.",
      );
      return;
    }
    changing.forEach((c) => {
      c.hidden = hidden;
    });
    logEntry(
      "info",
      hidden
        ? "All enemies hidden from the players."
        : "All enemies revealed to the players.",
      enc,
    );
    commit({ undo: hidden ? "Hide all enemies" : "Reveal all enemies" });
  }
  $("#btn-hide-enemies").addEventListener(
    "click",
    withEncounter((enc) => setEnemiesHidden(enc, true)),
  );
  $("#btn-reveal-enemies").addEventListener(
    "click",
    withEncounter((enc) => setEnemiesHidden(enc, false)),
  );

  $("#btn-clock-toggle").addEventListener(
    "click",
    withEncounter((enc) => {
      if (clockRunning(enc)) pauseClock(enc);
      else startClock(enc);
      saveState();
      renderClock();
    }),
  );
  $("#btn-clock-reset").addEventListener(
    "click",
    withEncounter((enc) => {
      resetClock(enc);
      saveState();
      renderClock();
    }),
  );
  // Sub-second tick so the display never lags the true elapsed time by a full second.
  setInterval(renderClock, 250);

  /* ---------- Log panel ---------- */
  const toggleLog = () => {
    state.ui.logOpen = !state.ui.logOpen;
    commit();
  };
  $("#btn-toggle-log").addEventListener("click", toggleLog);

  // Hamburger menu holding Log, Player View and End Encounter
  const trackerMenu = $("#tracker-menu");
  const menuBtn = $("#btn-menu");
  const setMenuOpen = (open) => {
    trackerMenu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn.addEventListener("click", () => setMenuOpen(trackerMenu.hidden));
  // Picking an item closes the menu; so does a click elsewhere or Escape
  trackerMenu.addEventListener("click", () => setMenuOpen(false));
  document.addEventListener("click", (e) => {
    if (!$("#tracker-menu-wrap").contains(e.target)) setMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !trackerMenu.hidden) {
      setMenuOpen(false);
      menuBtn.focus();
    }
  });
  $("#btn-log-close").addEventListener("click", toggleLog);
  $("#btn-log-clear").addEventListener(
    "click",
    withEncounter((enc) => {
      if (!enc.log.length) return;
      enc.log = [];
      commit({ undo: "Clear log" });
      toast("Combat log cleared.", { action: { label: "Undo", run: undo } });
    }),
  );

  /* ---------- Keyboard ---------- */
  const isTyping = () => {
    const el = document.activeElement;
    return (
      !!el &&
      (el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        (el.tagName === "INPUT" &&
          !["checkbox", "radio", "button"].includes(el.type)) ||
        el.isContentEditable)
    );
  };

  document.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      e.key.toLowerCase() === "z"
    ) {
      // A field with text undoes its own typing; an empty one hands Ctrl+Z to the app.
      if (isTyping() && document.activeElement.value) return;
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping()) return;
    const k = e.key.toLowerCase();
    if (e.key === "?") {
      e.preventDefault();
      openShortcuts();
      return;
    }
    if (state.ui.view !== "active") return;
    if (k === "l") {
      e.preventDefault();
      toggleLog();
      return;
    }
    // Arrow keys scroll the page unless the DM opts in.
    const arrows = state.ui.arrowKeys;
    if (k === "n" || (arrows && e.key === "ArrowRight")) {
      e.preventDefault();
      $("#btn-next-turn").click();
    }
    if (k === "p" || (arrows && e.key === "ArrowLeft")) {
      e.preventDefault();
      $("#btn-prev-turn").click();
    }
  });

  /* ---------- Group dialog ---------- */
  const groupModal = $("#group-modal");
  let groupFor = null;

  /** Pick which of the same kind of enemy belong to the group of this one. */
  function openGroupDialog(c) {
    const enc = activeEncounter();
    if (!enc || c.type !== "enemy") return;
    const kind = R.groupKey(c);
    const candidates = enc.combatants.filter(
      (m) => m.type === "enemy" && R.groupKey(m) === kind,
    );
    if (candidates.length < 2) {
      toast(
        `There is no other ${baseName(c.name)} in this encounter to group with.`,
      );
      return;
    }
    groupFor = c.instanceId;
    $("#group-text").textContent = c.groupId
      ? "Tick the enemies that belong to this group. They share initiative and stat block; HP stays separate."
      : "Tick the enemies to group with this one. They will take its initiative, and later stat block edits apply to all of them. HP stays separate.";
    $("#group-list").innerHTML = candidates
      .map((m) => {
        const checked =
          m === c || (c.groupId ? m.groupId === c.groupId : !m.groupId);
        const elsewhere =
          m.groupId && m.groupId !== c.groupId
            ? " <small>(in another group)</small>"
            : "";
        return `
        <label class="checkbox-field">
          <input type="checkbox" value="${m.instanceId}" ${checked ? "checked" : ""} ${m === c ? "disabled" : ""}>
          <span>${escapeHtml(m.name)} <small>HP ${m.hp.current}/${m.hp.max}</small>${elsewhere}</span>
        </label>`;
      })
      .join("");
    $("#group-disband").hidden = !c.groupId;
    openModal(groupModal);
  }

  $("#group-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const enc = activeEncounter();
    const c = enc && findCombatant(groupFor);
    if (!c) return;
    const ids = [
      c.instanceId,
      ...$$("#group-list input:checked:not(:disabled)").map((i) => i.value),
    ];
    if (ids.length < 2) {
      // Nobody else ticked: that ends a group, or does nothing for an enemy that had none
      const hadGroup = !!c.groupId;
      if (hadGroup) R.disbandGroup(enc, c);
      groupModal.close("ok");
      if (hadGroup) commit({ undo: `Disband group (${c.name})` });
      return;
    }
    R.setGroup(enc, ids, { groupId: c.groupId, leadId: c.instanceId });
    logEntry(
      "info",
      `${c.name} grouped with ${ids.length - 1} other${ids.length === 2 ? "" : "s"}.`,
      enc,
    );
    groupModal.close("ok");
    commit({ undo: `Group (${c.name})` });
  });

  $("#group-disband").addEventListener("click", () => {
    const enc = activeEncounter();
    const c = enc && findCombatant(groupFor);
    if (!c) return;
    R.disbandGroup(enc, c);
    logEntry("info", `The group with ${c.name} was disbanded.`, enc);
    groupModal.close("ok");
    commit({ undo: `Disband group (${c.name})` });
  });
  wireDialogChrome(groupModal);

  /* ---------- Shortcuts dialog & card layout ---------- */
  const shortcutsModal = $("#shortcuts-modal");
  function openShortcuts() {
    if (shortcutsModal.open) return;
    $("#opt-arrow-keys").checked = state.ui.arrowKeys;
    openModal(shortcutsModal);
  }
  $("#btn-shortcuts").addEventListener("click", openShortcuts);
  $("#opt-arrow-keys").addEventListener("change", (e) => {
    state.ui.arrowKeys = e.target.checked;
    saveState();
  });
  wireDialogChrome(shortcutsModal);

  $$("[data-card-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (state.ui.cardMode === btn.dataset.cardMode) return;
      state.ui.cardMode = btn.dataset.cardMode;
      // Each layout has its own default for the stats section.
      moreOpen.clear();
      commit();
    }),
  );

  /* ---------- Combatant card actions ---------- */
  const cardsHost = $("#combatant-cards");

  function combatantFromEvent(e) {
    // A group's shared card stands for its first enemy (and acts on the whole group where it matters)
    const el = e.target.closest("[data-instance-id], [data-group-lead]");
    const enc = activeEncounter();
    if (!el || !enc) return {};
    const id = el.dataset.instanceId || el.dataset.groupLead;
    const combatant = enc.combatants.find((c) => c.instanceId === id);
    return { enc, combatant, el };
  }

  // The buttons in a group's box header: edit, add enemies, minimize
  cardsHost.addEventListener("click", async (e) => {
    const btn = e.target.closest(
      "[data-group-edit], [data-group-add], [data-group-min], [data-group-delete]",
    );
    if (!btn) return;
    const id =
      btn.dataset.groupEdit ||
      btn.dataset.groupAdd ||
      btn.dataset.groupMin ||
      btn.dataset.groupDelete;
    const lead = findCombatant(id);
    if (!lead) return;
    if (btn.dataset.groupDelete) {
      // Removes the group and every enemy in it; Undo brings them all back
      const enc = activeEncounter();
      const members = R.groupMembers(enc, lead);
      const name = baseName(lead.name);
      members.forEach((m) => removeCombatant(enc, m));
      logEntry("info", `The ${name} group (${members.length}) was removed.`, enc);
      commit({ undo: `Delete group (${name})` });
      toast(`${name} group removed.`, { action: { label: "Undo", run: undo } });
      return;
    }
    if (btn.dataset.groupEdit) {
      openGroupDialog(lead);
      return;
    }
    if (btn.dataset.groupMin) {
      const set = new Set(state.ui.expandedGroups);
      if (!set.delete(lead.groupId)) set.add(lead.groupId);
      state.ui.expandedGroups = [...set];
      commit();
      return;
    }
    const answer = await promptDialog({
      title: "Add to Group",
      label: `How many more ${baseName(lead.name)}s?`,
      value: "1",
      okLabel: "Add",
    });
    const count = toInt(answer, 0);
    const enc = activeEncounter();
    const current = findCombatant(id);
    if (!enc || !current || count < 1) return;
    const added = addToGroup(enc, current, count);
    toast(
      `${added === 1 ? "1 enemy" : `${added} enemies`} added to the group.`,
    );
    commit({ undo: `Add to group (${baseName(current.name)})` });
  });

  cardsHost.addEventListener("click", (e) => {
    const { enc, combatant, el } = combatantFromEvent(e);
    if (!combatant) return;
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    switch (btn.dataset.action) {
      case "damage":
      case "heal":
      case "temp": {
        const input = $('[data-field="hpDelta"]', el);
        const amount = Math.abs(toInt(input.value, 0)) || 1;
        const action = btn.dataset.action;
        let changed;
        if (action === "damage") {
          damageCombatant(combatant, amount, {
            crit: !!$('[data-field="crit"]', el)?.checked,
            type: $('[data-field="dmgType"]', el)?.value || "",
          });
          changed = true;
        } else if (action === "heal") {
          changed = healCombatant(combatant, amount);
        } else {
          changed = grantTemp(combatant, amount);
        }
        if (changed)
          commit({ undo: `${capitalize(action)} ${combatant.name}` });
        break;
      }

      case "open-detail":
        openDetail(combatant.instanceId);
        break;

      case "edit-instance":
        openCreatureModal({
          mode: "instance-edit",
          type: combatant.type,
          instanceId: combatant.instanceId,
        });
        break;

      case "save-to-library":
        saveCombatantToLibrary(combatant);
        break;

      case "remove-instance": {
        removeCombatant(enc, combatant);
        commit({ undo: `Remove ${combatant.name}` });
        toast(`${combatant.name} removed.`, {
          action: { label: "Undo", run: undo },
        });
        break;
      }

      default:
        runCombatantAction(combatant, btn);
    }
  });

  /* ---------- Card resizing (Cards view) ----------
     Drag a card's corner handle to size it. The size is saved on the
     combatant; double-clicking the handle goes back to the default size.
     Width and height snap to other resized cards when close, with a guide
     line on both cards. Hold Alt/Option to resize without snapping. */
  let resizing = null;
  const SNAP_MOUSE = 10;
  const SNAP_TOUCH = 16;

  /** The nearest target size within range, or null. */
  function nearestSnap(targets, key, value, range) {
    let best = null;
    for (const t of targets) {
      const dist = Math.abs(t[key] - value);
      if (dist <= range && (!best || dist < Math.abs(best[key] - value)))
        best = t;
    }
    return best;
  }

  /** Draw a line along one edge of a card (axis "v" = vertical, "h" = horizontal). */
  function addGuide(axis, edge, start, length) {
    const g = document.createElement("div");
    g.className = `snap-guide snap-guide--${axis}`;
    if (axis === "v")
      Object.assign(g.style, {
        left: `${edge - 1}px`,
        top: `${start}px`,
        height: `${length}px`,
      });
    else
      Object.assign(g.style, {
        top: `${edge - 1}px`,
        left: `${start}px`,
        width: `${length}px`,
      });
    document.body.appendChild(g);
    resizing.guides.push(g);
  }

  function clearGuides() {
    resizing.guides.forEach((g) => g.remove());
    resizing.guides = [];
  }

  cardsHost.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest("[data-resize]");
    if (!handle) return;
    const el = handle.closest("[data-instance-id]");
    const rect = el.getBoundingClientRect();
    // Sizes of the other resized cards, which this one can snap to
    const targets = $$(".card.is-sized", cardsHost)
      .filter((o) => o !== el)
      .map((o) => ({ el: o, w: o.offsetWidth, h: o.offsetHeight }));
    resizing = {
      el,
      id: el.dataset.instanceId,
      startX: e.clientX,
      startY: e.clientY,
      w: rect.width,
      h: rect.height,
      targets,
      guides: [],
    };
    handle.setPointerCapture(e.pointerId);
    el.classList.add("is-sized", "is-resizing");
    e.preventDefault();
  });

  cardsHost.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const L = R.CARD_SIZE_LIMITS;
    const maxW = Math.min(L.maxW, cardsHost.clientWidth);
    let w = clamp(resizing.w + e.clientX - resizing.startX, L.minW, maxW);
    let h = clamp(resizing.h + e.clientY - resizing.startY, L.minH, L.maxH);
    let snapW = null;
    let snapH = null;
    if (!e.altKey) {
      const range = e.pointerType === "touch" ? SNAP_TOUCH : SNAP_MOUSE;
      snapW = nearestSnap(resizing.targets, "w", w, range);
      snapH = nearestSnap(resizing.targets, "h", h, range);
      if (snapW) w = clamp(snapW.w, L.minW, maxW);
      if (snapH) h = clamp(snapH.h, L.minH, L.maxH);
    }
    resizing.el.style.width = `${w}px`;
    resizing.el.style.height = `${h}px`;
    fitCard(resizing.el);

    // Guide lines along the matching edge of both cards
    clearGuides();
    const me = resizing.el.getBoundingClientRect();
    if (snapW && w === snapW.w) {
      for (const r of [me, snapW.el.getBoundingClientRect()])
        addGuide("v", r.right, r.top, r.height);
    }
    if (snapH && h === snapH.h) {
      for (const r of [me, snapH.el.getBoundingClientRect()])
        addGuide("h", r.bottom, r.left, r.width);
    }
  });

  function endResize() {
    if (!resizing) return;
    const { el, id } = resizing;
    clearGuides();
    resizing = null;
    el.classList.remove("is-resizing");
    const c = findCombatant(id);
    if (!c) return;
    c.cardSize = R.normalizeCardSize({ w: el.offsetWidth, h: el.offsetHeight });
    saveState();
  }
  cardsHost.addEventListener("pointerup", endResize);
  cardsHost.addEventListener("pointercancel", endResize);

  cardsHost.addEventListener("dblclick", (e) => {
    if (!e.target.closest("[data-resize]")) return;
    const { combatant } = combatantFromEvent(e);
    if (!combatant) return;
    combatant.cardSize = null;
    commit();
  });

  /* The collapsible stats section remembers when the DM overrides the default. */
  cardsHost.addEventListener(
    "toggle",
    (e) => {
      if (!e.target.matches?.("[data-card-more]")) return;
      const host = e.target.closest("[data-instance-id], [data-group-lead]");
      const id = host?.dataset.instanceId || host?.dataset.groupLead;
      if (id) moreOpen.set(id, e.target.open);
    },
    true,
  );

  /* Inline edits commit on change (blur / Enter) */
  cardsHost.addEventListener("change", (e) => {
    const input = e.target.closest("[data-field]");
    if (!input) return;
    const { enc, combatant } = combatantFromEvent(e);
    if (!combatant) return;

    switch (input.dataset.field) {
      case "initiative":
        // Changes everyone in the same group too
        R.setInitiative(enc, combatant, input.value);
        commit({ undo: `Initiative (${combatant.name})` });
        break;
      case "hpCurrent":
        // Direct edits are corrections, so they bypass massive damage and death save rules.
        combatant.hp.current = Math.min(
          Math.max(0, toInt(input.value, 0)),
          combatant.hp.max,
        );
        announce(R.afterHpChange(combatant), { enc });
        commit({ undo: `HP (${combatant.name})` });
        break;
      case "hpMax":
        combatant.hp.max = Math.max(0, toInt(input.value, 0));
        combatant.hp.current = Math.min(combatant.hp.current, combatant.hp.max);
        announce(R.afterHpChange(combatant), { enc });
        commit({ undo: `Max HP (${combatant.name})` });
        break;
      case "hpTemp":
        combatant.hp.temp = Math.max(0, toInt(input.value, 0));
        commit({ undo: `Temp HP (${combatant.name})` });
        break;
      case "dmgType":
        lastDamageType.set(combatant.instanceId, input.value);
        break;
    }
  });

  /* Enter in the damage box applies damage; Shift+Enter heals */
  cardsHost.addEventListener("keydown", (e) => {
    const input = e.target.closest('[data-field="hpDelta"]');
    if (!input || e.key !== "Enter") return;
    e.preventDefault();
    const el = input.closest("[data-instance-id]");
    $(
      e.shiftKey ? '[data-action="heal"]' : '[data-action="damage"]',
      el,
    )?.click();
  });

  /* ---------- Library actions ---------- */
  $("#btn-new-pc").addEventListener("click", () =>
    openCreatureModal({ mode: "library-new", type: "pc" }),
  );
  $("#btn-new-enemy").addEventListener("click", () =>
    openCreatureModal({ mode: "library-new", type: "enemy" }),
  );

  $(".library-columns").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "add-srd") {
      addStarterMonsters();
      return;
    }
    const row = btn.closest("[data-template-id]");
    const template = findTemplate(row?.dataset.templateId);
    if (!template) return;
    const type = templateType(template.id);

    if (btn.dataset.action === "edit-template") {
      openCreatureModal({
        mode: "library-edit",
        type,
        templateId: template.id,
      });
    }

    if (btn.dataset.action === "duplicate-template") {
      const list = libraryList(type);
      const copy = {
        ...R.clone(template),
        id: uuid(),
        name: `${template.name} (copy)`,
      };
      list.splice(list.indexOf(template) + 1, 0, copy);
      toast(`${copy.name} added.`);
      commit();
    }

    if (btn.dataset.action === "variant-template") {
      const seed = { ...R.clone(template), name: `${template.name} (variant)` };
      delete seed.id;
      openCreatureModal({ mode: "library-new", type, seed });
    }

    if (btn.dataset.action === "delete-template") {
      const ok = await confirmDialog({
        title: "Delete from Library",
        html: `Delete <strong>${escapeHtml(template.name)}</strong> from the library? Combatants already in encounters are unaffected.`,
      });
      if (!ok) return;
      const list = libraryList(type);
      list.splice(list.indexOf(template), 1);
      toast(`${template.name} removed from the library.`);
      commit();
    }
  });

  /* ---------- Library toolbar ---------- */
  const libraryFilter = (key, el, event = "change") =>
    el.addEventListener(event, () => {
      state.ui[key] = el.value;
      saveState();
      renderLibrary();
    });
  libraryFilter("librarySearch", $("#lib-search"), "input");
  libraryFilter("librarySort", $("#lib-sort"));
  libraryFilter("libraryClass", $("#lib-class"));
  libraryFilter("libraryCrMin", $("#lib-cr-min"));
  libraryFilter("libraryCrMax", $("#lib-cr-max"));
  libraryFilter("libraryType", $("#lib-type"));
  libraryFilter("libraryTypeOther", $("#lib-type-other"), "input");

  // Reset sort, CR range and type (search has its own box)
  $("#lib-clear-filters").addEventListener("click", () => {
    Object.assign(state.ui, {
      librarySort: "name",
      libraryCrMin: "",
      libraryCrMax: "",
      libraryType: "",
      libraryTypeOther: "",
    });
    saveState();
    renderLibrary();
  });

  // Buttons that show or hide a panel (PC list, enemy search, enemy filter)
  $$("[data-collapse]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const panel = $(`#${btn.dataset.collapse}`);
      panel.hidden = !panel.hidden;
      btn.setAttribute("aria-expanded", String(!panel.hidden));
    }),
  );

  /* ---------- Export / import ---------- */
  const importModal = $("#import-modal");
  let pendingImport = null;

  function startImport() {
    const input = $("#import-file");
    input.value = "";
    input.click();
  }

  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch {
      toast("Could not read that file.");
      return;
    }
    const result = R.parseImport(text);
    if (!result.ok) {
      toast(`Import rejected: ${result.error} Nothing was changed.`);
      return;
    }
    pendingImport = result;
    const c = result.counts;
    $("#import-summary").textContent =
      `${file.name} (schema ${result.version}) contains:`;
    $("#import-counts").innerHTML = [
      [c.encounters, "encounter", "encounters"],
      [c.pcs, "player character", "player characters"],
      [c.enemies, "enemy", "enemies"],
    ]
      .map(([n, one, many]) => `<li><b>${n}</b> ${n === 1 ? one : many}</li>`)
      .join("");
    importModal.returnValue = "cancel";
    openModal(importModal);
  });

  $("#import-form").addEventListener("submit", (e) => {
    e.preventDefault();
    importModal.close(e.submitter?.value === "replace" ? "replace" : "merge");
  });
  importModal.addEventListener("close", async () => {
    const mode = importModal.returnValue;
    const result = pendingImport;
    pendingImport = null;
    if (!result || (mode !== "merge" && mode !== "replace")) return;
    if (mode === "replace") {
      const ok = await confirmDialog({
        title: "Replace All Data",
        html: `Replace your <strong>${state.encounters.length}</strong> encounters and <strong>${state.creatureLibrary.pcs.length + state.creatureLibrary.enemies.length}</strong> library entries with the file's contents? This cannot be undone. Export first if you might want them back.`,
        okLabel: "Replace",
      });
      if (!ok) return;
    }
    applyImport(result.data, mode);
    toast(
      mode === "replace"
        ? "Data replaced from the import."
        : "Import merged into your data.",
    );
  });
  wireDialogChrome(importModal);

  $("#btn-export").addEventListener("click", exportData);
  $("#btn-import").addEventListener("click", startImport);

  /* ---------- Password lock ----------
     The server decides whether the DM page needs the password. Turning it off
     is for a trusted network like home. The setting is saved on the server. */
  let lockOn = true;

  function renderLock() {
    $("#btn-lock-toggle").innerHTML = lockOn
      ? `${ICON_LOCK} Lock is on. Turn off`
      : `${ICON_UNLOCK} Lock is off. Turn on`;
    $("#btn-lock-toggle").className = lockOn
      ? "btn btn-ghost"
      : "btn btn-primary";
    $("#lock-text").textContent = lockOn
      ? "The DM page asks for the password. Turn the lock off at home so you do not have to type it."
      : "The DM page opens without a password for anyone who can reach this server. Turn the lock back on before you use it anywhere else, like school.";
    $("#lock-badge").hidden = lockOn;
    $("#lock-badge").innerHTML = ICON_UNLOCK;
    $("#logout-form").hidden = !lockOn;
  }

  async function loadLock() {
    try {
      const res = await fetch("/api/lock", { cache: "no-store" });
      if (res.ok) lockOn = (await res.json()).locked;
    } catch {
      /* keep the default */
    }
    renderLock();
  }

  async function setLock(locked) {
    let out = null;
    try {
      const res = await fetch("/api/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked }),
      });
      out = res.ok ? await res.json() : null;
    } catch {
      out = null;
    }
    if (!out) {
      toast("Could not change the lock. Check that the server is running.");
      return;
    }
    lockOn = out.locked;
    renderLock();
    // Locking from an unlocked page: this browser has no login yet, so ask for the password now
    if (lockOn && !out.signedIn) {
      toast("Locked. Log in with the password.");
      setTimeout(() => {
        location.href = "/login.html";
      }, 1200);
    } else {
      toast(
        lockOn
          ? "Password lock is on."
          : "Password lock is off. Anyone on this network can open the DM page.",
      );
    }
  }

  $("#btn-lock-toggle").addEventListener("click", () => {
    if (
      lockOn &&
      !confirm(
        "Turn the password lock off?\n\nAnyone who can reach this server will be able to open the DM page, including enemy stats. Only do this on a network you trust, like home.",
      )
    )
      return;
    setLock(!lockOn);
  });
  $("#lock-badge").addEventListener("click", () => $("#btn-settings").click());

  /* ---------- Settings ---------- */
  const settingsModal = $("#settings-modal");
  function openSettings() {
    $("#opt-arrow-keys-settings").checked = state.ui.arrowKeys;
    $("#settings-saved").textContent = lastSavedAt
      ? `Last saved ${new Date(lastSavedAt).toLocaleString()}.${saveError ? " The latest change could not be saved." : ""}`
      : "Nothing saved yet.";
    openModal(settingsModal);
  }
  $("#btn-settings").addEventListener("click", openSettings);
  settingsModal.addEventListener("click", (e) => {
    const action = e.target.closest("[data-settings]")?.dataset.settings;
    if (!action) return;
    if (action === "export") exportData();
    if (action === "import") {
      settingsModal.close();
      startImport();
    }
    if (action === "player-view") openPlayerWindow();
    if (action === "shortcuts") {
      settingsModal.close();
      requestAnimationFrame(openShortcuts);
    }
  });
  $("#opt-arrow-keys-settings").addEventListener("change", (e) => {
    state.ui.arrowKeys = e.target.checked;
    saveState();
  });
  wireDialogChrome(settingsModal);

  $("#btn-player-view").addEventListener("click", openPlayerWindow);

  /* ======================================================================
     7. Boot
     ====================================================================== */

  /* Static parts of the builder. */
  creatureForm.elements.cls.innerHTML =
    `<option value="">—</option>` +
    CLASSES.map((c) => `<option value="${c}">${c}</option>`).join("");
  creatureForm.elements.cr.innerHTML =
    `<option value="">—</option>` +
    CR_OPTIONS.map((cr) => `<option value="${cr}">${cr}</option>`).join("");
  $("#damage-types").innerHTML = DAMAGE_TYPES.map(
    (t) => `<option value="${t}">`,
  ).join("");
  $("#stats-inputs").innerHTML = STAT_KEYS.map(
    (k) => `
    <label class="stat-input">
      <span>${k.toUpperCase()}</span>
      <input type="number" name="${k}" min="1" max="30" value="10" aria-label="${STAT_NAMES[k]}">
      <span class="stat-input-mod" data-mod-for="${k}">+0</span>
    </label>`,
  ).join("");
  $("#save-grid").innerHTML = STAT_KEYS.map(
    (k) => `
    <label class="skill-check">
      <input type="checkbox" data-save="${k}">
      <span class="skill-name">${STAT_NAMES[k]}</span>
      <span class="skill-bonus" data-save-bonus="${k}">+0</span>
    </label>`,
  ).join("");
  $("#skill-grid").innerHTML = SKILLS.map(
    (s) => `
    <div class="skill-check">
      <label class="skill-main">
        <input type="checkbox" data-skill="${s.key}">
        <span class="skill-name">${s.name} <small>${s.ability.toUpperCase()}</small></span>
      </label>
      <label class="skill-exp" title="Expertise: proficiency counts twice">
        <input type="checkbox" data-expertise="${s.key}" aria-label="${s.name} expertise"><span aria-hidden="true">×2</span>
      </label>
      <span class="skill-bonus" data-skill-bonus="${s.key}">+0</span>
    </div>`,
  ).join("");
  $$("[data-def-grid]").forEach((grid) => {
    const key = grid.dataset.defGrid;
    const options =
      key === "conditionImmunities"
        ? [...CONDITIONS, "Exhaustion"]
        : DAMAGE_TYPES;
    grid.innerHTML = options
      .map(
        (o) => `
      <label class="check-chip"><input type="checkbox" data-def="${key}" value="${o}"><span>${o}</span></label>`,
      )
      .join("");
  });

  // The Type text box holds the value. The dropdown fills it, or reveals it for Other.
  const typeSelect = $("#creature-type-select");
  typeSelect.innerHTML =
    `<option value="">—</option>` +
    CREATURE_TYPES.map(
      (t) => `<option value="${t}">${t[0].toUpperCase()}${t.slice(1)}</option>`,
    ).join("") +
    `<option value="other">Other…</option>`;
  typeSelect.addEventListener("change", () => {
    const box = creatureForm.elements.creatureType;
    if (typeSelect.value === "other") {
      box.classList.remove("hidden");
      box.focus();
      return;
    }
    box.classList.add("hidden");
    box.value = typeSelect.value
      ? typeSelect.value[0].toUpperCase() + typeSelect.value.slice(1)
      : "";
  });

  $("#lib-type").innerHTML =
    `<option value="">All types</option>` +
    CREATURE_TYPES.map(
      (t) => `<option value="${t}">${t[0].toUpperCase()}${t.slice(1)}</option>`,
    ).join("") +
    `<option value="other">Other…</option>`;
  $("#lib-class").innerHTML =
    `<option value="">All classes</option>` +
    CLASSES.map((c) => `<option value="${c}">${c}</option>`).join("");
  const crChoices = (label) =>
    `<option value="">${label}</option>` +
    CR_OPTIONS.map((cr) => `<option value="${cr}">${cr}</option>`).join("");
  $("#lib-cr-min").innerHTML = crChoices("Any");
  $("#lib-cr-max").innerHTML = crChoices("Any");
  if (SRD) $("#srd-attribution").textContent = SRD.ATTRIBUTION;

  state = loadState();
  try {
    const meta = JSON.parse(storageGet(STORAGE_KEY) || "null");
    lastSavedAt = meta?.savedAt ?? null;
    serverRev = Number.isInteger(meta?.serverRev) ? meta.serverRev : null;
  } catch {
    lastSavedAt = null;
  }
  state.encounters.forEach(sortEncounter);
  snapshotActive();
  renderAll();
  renderSaved();
  // Send the open encounter so the player display matches after a reload or server restart
  syncPlayerDisplay();
  // Then check the server's saved copy (it may be newer, or empty)
  pullFromServer();
  loadLock();
})();
