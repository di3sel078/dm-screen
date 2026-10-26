// Page elements
const roundEl = document.getElementById("round");
const subEl = document.getElementById("sub");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const statusDotsEl = document.getElementById("status-dots");
const orderEl = document.getElementById("order");
const clockEl = document.getElementById("clock");
const clockTimeEl = document.getElementById("clock-time");
const clockRealEl = document.getElementById("clock-real");

// Make an element with a class and optional text
function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  if (text !== undefined) {
    el.textContent = text;
  }
  return el;
}

// Make a health bar with a fill width (percent) and color class.
// Temp HP (percent, optional) is a cyan block right after the fill.
function makeBar(percent, colorClass, tempPercent) {
  const bar = makeEl("div", "hp-bar");
  const fill = makeEl("div", "hp-bar-fill " + colorClass);
  fill.style.width = percent + "%";
  bar.appendChild(fill);
  if (tempPercent) {
    const temp = makeEl("div", "hp-bar-temp");
    temp.style.width = tempPercent + "%";
    bar.appendChild(temp);
  }
  return bar;
}

// Pill colors for a PC at 0 HP or dead
const PC_STATUS_CLASS = {
  Dying: "health--critical",
  Stable: "health--hurt",
  Dead: "health--down",
};

// Health as a pill plus a bar, no numbers.
// Enemies get a vague bar; PCs get a bar that follows HP in small steps.
// A PC at 0 HP shows Dying, Stable or Dead in the pill instead of the band.
function buildHealth(c) {
  if (c.group) {
    return buildGroupHealth(c);
  }
  const colorClass = "health--" + c.band.toLowerCase();
  const label = c.status || c.band;
  const pillClass = (c.status && PC_STATUS_CLASS[c.status]) || colorClass;
  const status = makeEl("span", "player-health");
  status.appendChild(makeEl("span", "band " + pillClass, label));
  return { bar: makeBar(c.bar, colorClass, c.tempBar), status: status };
}

// A group of enemies: one pill ("2 of 3 up") and a bar with one segment per enemy
function buildGroupHealth(c) {
  const status = makeEl("span", "player-health");
  status.appendChild(
    makeEl("span", "band health--" + c.band.toLowerCase(), c.up + " of " + c.count + " up"),
  );
  const bar = makeEl("div", "hp-bar hp-bar--group");
  for (const member of c.members) {
    const seg = makeEl("div", "hp-seg");
    const fill = makeEl("div", "hp-bar-fill health--" + member.band.toLowerCase());
    fill.style.width = member.bar + "%";
    seg.appendChild(fill);
    bar.appendChild(seg);
  }
  return { bar: bar, status: status };
}

// Condition, concentration and exhaustion chips
function buildConditions(c) {
  const conds = makeEl("div", "player-conds");
  if (c.concentrating) {
    conds.appendChild(makeEl("span", "chip chip--conc", "◉ Concentrating"));
  }
  for (const cond of c.conditions || []) {
    const chip = makeEl("span", "chip chip--cond", cond.name);
    // In a group, show how many of the enemies have it
    if (cond.count > 1) {
      chip.appendChild(makeEl("small", "", " ×" + cond.count));
    }
    if (cond.roundsLeft !== null) {
      chip.appendChild(makeEl("small", "", " " + cond.roundsLeft + "r"));
    }
    conds.appendChild(chip);
  }
  if (c.exhaustion) {
    conds.appendChild(
      makeEl("span", "chip chip--exh", "Exhaustion " + c.exhaustion),
    );
  }
  return conds;
}

// Groups the players have opened (by group id), kept between updates
const openGroups = new Set();
let lastState = null;
// The group just tapped, so its caret can turn instead of jumping
let justToggled = null;

// One enemy inside an open group: name, status pill, bar, its own conditions
function buildMember(member) {
  const line = makeEl("li", "player-member");
  if (member.current) {
    line.classList.add("is-current");
  }
  const name = makeEl("span", "player-member-name", member.name);
  if (member.current) {
    name.prepend(makeEl("span", "player-member-marker", "▶ "));
  }
  const colorClass = "health--" + member.band.toLowerCase();
  const pill = makeEl("span", "player-health");
  pill.appendChild(makeEl("span", "band " + colorClass, member.band));
  line.append(name, pill, makeBar(member.bar, colorClass));
  if (member.conditions.length) {
    line.appendChild(buildConditions(member));
  }
  return line;
}

// Build one row: order number, marker, name, status, bar, then conditions.
// A group is one row that opens to show a line for each enemy.
function buildRow(c, isCurrent, position) {
  const row = makeEl("li", "player-row player-row--" + c.type);
  if (isCurrent) {
    row.classList.add("is-current");
    row.setAttribute("aria-current", "step");
  }

  row.appendChild(makeEl("span", "player-order", String(position)));
  row.appendChild(makeEl("span", "player-marker", isCurrent ? "▶" : ""));
  const open = !!c.group && openGroups.has(c.id);
  let name;
  if (c.group) {
    // The caret is drawn with CSS so it centers exactly beside the name.
    // The row is rebuilt on every tap, so a tapped caret starts where it was and then turns.
    const caret = makeEl("span", "group-caret");
    const turning = c.id === justToggled;
    caret.classList.toggle("is-open", turning ? !open : open);
    if (turning) {
      justToggled = null;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => caret.classList.toggle("is-open", open)),
      );
    }
    name = makeEl("span", "player-name player-name--group");
    name.append(caret, makeEl("span", "player-name-text", c.name));
  } else {
    name = makeEl("span", "player-name", c.name);
  }
  row.appendChild(name);

  if (c.type !== "lair") {
    const health = buildHealth(c);
    row.append(health.status, health.bar);
  }
  if (c.type !== "lair") {
    row.appendChild(buildConditions(c));
  }

  if (c.group) {
    row.classList.add("player-row--group");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-expanded", String(open));
    row.setAttribute("aria-label", c.name + ", " + c.up + " of " + c.count + " up. Tap to " + (open ? "close" : "open") + ".");
    const toggle = () => {
      justToggled = c.id;
      if (openGroups.has(c.id)) {
        openGroups.delete(c.id);
      } else {
        openGroups.add(c.id);
      }
      render(lastState);
    };
    // Only the group row itself toggles, not the lines inside it
    row.addEventListener("click", (e) => {
      if (!e.target.closest(".player-members")) {
        toggle();
      }
    });
    row.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === row) {
        e.preventDefault();
        toggle();
      }
    });
    if (open) {
      const members = makeEl("ul", "player-members");
      members.setAttribute("aria-label", "Enemies in this group");
      c.members.forEach((member) => members.appendChild(buildMember(member)));
      row.appendChild(members);
    }
  }
  return row;
}

// Redraw everything from the server's player-safe state
function render(state) {
  lastState = state;
  orderEl.innerHTML = "";
  setClock(state ? state.clock : null);

  // No encounter open yet
  if (!state) {
    roundEl.textContent = "Waiting for the DM…";
    subEl.textContent = "No encounter is open yet.";
    document.title = "Player Display";
    return;
  }

  const list = state.combatants;
  // The server leaves out hidden enemies and picks who is up next from the rest
  const current = list[state.currentIndex];
  const next = list[state.nextIndex];

  roundEl.textContent = "Round " + state.round;
  if (current) {
    // A group takes its turn as "Goblin group" rather than naming one of its members
    const turnName = current.turnName || current.name;
    subEl.textContent =
      turnName + "'s Turn" + (next ? " · Up next: " + next.name : "");
    document.title = "Round " + state.round + ": " + turnName;
  } else {
    // A hidden enemy has the turn (or there is nobody yet)
    subEl.textContent = next ? "Up next: " + next.name : "";
    document.title = "Round " + state.round;
  }

  // Position in the turn order starts at 1
  list.forEach((c, i) => {
    orderEl.appendChild(buildRow(c, i === state.currentIndex, i + 1));
  });

  followTurn(state, current);
}

// Scroll to whoever's turn it is, but only when the turn moves (not on every
// health change, and not when someone opens or closes a group)
let lastTurnKey = null;

function followTurn(state, current) {
  if (!current) {
    return;
  }
  // Inside a group the turn also moves from one enemy to the next
  const member = current.group ? current.members.findIndex((m) => m.current) : -1;
  const key = state.round + ":" + state.currentIndex + ":" + member;
  if (key === lastTurnKey) {
    return;
  }
  lastTurnKey = key;
  // An open group scrolls to the acting enemy's line, otherwise to the row
  const target =
    orderEl.querySelector(".player-member.is-current") ||
    orderEl.querySelector(".player-row.is-current");
  if (target) {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
  }
}

// ---------- Encounter clock ----------
// Combat time: the server sends it and whether it is running, and we tick on from there.
// The real time of day comes from this screen's own clock.
let clockBase = null;

function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
}

function setClock(clock) {
  clockBase = clock ? { ms: clock.ms, running: clock.running, at: Date.now() } : null;
  showClock();
}

function showClock() {
  clockEl.hidden = !clockBase;
  if (!clockBase) {
    return;
  }
  const ms = clockBase.ms + (clockBase.running ? Date.now() - clockBase.at : 0);
  clockTimeEl.textContent = formatClock(ms);
  // The real time of day on this screen
  clockRealEl.textContent = new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

setInterval(showClock, 250);

// Show the connection state: "checking", "connected", or "disconnected"
function setStatus(state) {
  statusEl.className = "conn conn--" + state;
  if (state === "connected") {
    statusTextEl.textContent = "Connected";
  } else if (state === "disconnected") {
    statusTextEl.textContent = "Disconnected";
  } else {
    statusTextEl.textContent = "Checking";
  }
  // Dots only animate while checking
  statusDotsEl.hidden = state !== "checking";
  statusDotsEl.textContent = ".";
}

// While checking, the dots grow . .. ... then start over
setInterval(() => {
  if (statusEl.classList.contains("conn--checking")) {
    const count = (statusDotsEl.textContent.length % 3) + 1;
    statusDotsEl.textContent = ".".repeat(count);
  }
}, 500);

// Open the live stream
let source = null;
let retryTimer = null;

function connect() {
  setStatus("checking");
  source = new EventSource("/events");

  // New state from the server
  source.onmessage = (event) => {
    render(JSON.parse(event.data));
  };

  // Connected
  source.onopen = () => {
    setStatus("connected");
  };

  // Server not found or link dropped. Most browsers retry on their own;
  // if this one gave up, start a fresh connection after a few seconds.
  source.onerror = () => {
    setStatus("disconnected");
    if (source.readyState === EventSource.CLOSED) {
      source.close();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 3000);
    }
  };
}

connect();
