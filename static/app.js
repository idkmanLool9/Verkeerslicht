// Werkt in twee modi:
// 1. "Live" / "Demo (server)" - praat met /api van een backend.
// 2. "Demo (browser)" - statische simulator. Op GitHub Pages.

const $ = (id) => document.getElementById(id);

const API_BASE_KEY = "verkeerslicht.apiBase";
function getApiBase() {
  return (localStorage.getItem(API_BASE_KEY) || "").replace(/\/+$/, "");
}

const CYCLE = [
  { phase: "permissive-Movement-Allowed", color: "green", duration: 15 },
  { phase: "permissive-clearance",        color: "amber", duration: 3  },
  { phase: "stop-And-Remain",             color: "red",   duration: 22 },
];
const TOTAL = CYCLE.reduce((a, c) => a + c.duration, 0);
const startEpoch = Date.now() / 1000;

const NEXT_LABEL = {
  green: "tot geel",
  amber: "tot rood",
  red: "tot groen",
  "red-amber": "tot groen",
  unknown: "wachten op data",
  dark: "lamp uit",
};

function applyState(color) {
  document.body.classList.remove(
    "state-red", "state-amber", "state-green", "state-unknown"
  );
  for (const k of ["red", "amber", "green"]) $(k).classList.remove("on");

  if (color === "red" || color === "stop-Then-Proceed") {
    $("red").classList.add("on");
    document.body.classList.add("state-red");
  } else if (color === "red-amber") {
    $("red").classList.add("on");
    $("amber").classList.add("on");
    document.body.classList.add("state-red");
  } else if (color === "amber") {
    $("amber").classList.add("on");
    document.body.classList.add("state-amber");
  } else if (color === "green") {
    $("green").classList.add("on");
    document.body.classList.add("state-green");
  } else {
    document.body.classList.add("state-unknown");
  }

  $("next-label").textContent = NEXT_LABEL[color] ?? "tot wissel";
}

function localPhase(signalGroup) {
  const now = Date.now() / 1000;
  let elapsed = (now - startEpoch) % TOTAL;
  if (Number(signalGroup) % 2 === 0) elapsed = (elapsed + TOTAL / 2) % TOTAL;
  let t = 0;
  for (const step of CYCLE) {
    if (elapsed < t + step.duration) {
      const remaining = (t + step.duration) - elapsed;
      return {
        phase: step.phase,
        color: step.color,
        seconds_until_change: remaining,
        age_seconds: 0,
        source: "browser-demo",
      };
    }
    t += step.duration;
  }
  return null;
}

let mode = "loading"; // "live" | "demo-server" | "demo"

async function detectMode() {
  const base = getApiBase();
  if (!base) {
    mode = "demo";
  } else {
    try {
      const res = await fetch(`${base}/api/health`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        mode = data.demo_mode ? "demo-server" : "live";
      } else {
        mode = "demo";
      }
    } catch {
      mode = "demo";
    }
  }
  const badge = $("mode");
  if (mode === "live") {
    badge.textContent = "Live";
    badge.className = "mode live";
  } else if (mode === "demo-server") {
    badge.textContent = "Demo · server";
    badge.className = "mode demo";
  } else {
    badge.textContent = "Demo";
    badge.className = "mode demo";
  }
}

async function tick() {
  const ix = $("ix").value;
  const sg = $("sg").value;

  if (mode === "live" || mode === "demo-server") {
    const base = getApiBase();
    try {
      const res = await fetch(
        `${base}/api/signals/${encodeURIComponent(ix)}/${encodeURIComponent(sg)}`
      );
      if (!res.ok) {
        applyState("unknown");
        $("phase").textContent = `geen data (${res.status})`;
        $("countdown").textContent = "--";
        return;
      }
      render(await res.json());
    } catch (e) {
      applyState("unknown");
      $("phase").textContent = `fout: ${e.message}`;
      $("countdown").textContent = "--";
    }
    return;
  }

  const data = localPhase(sg);
  if (!data) {
    applyState("unknown");
    return;
  }
  render(data);
}

function render(data) {
  applyState(data.color);
  $("phase").textContent = data.phase ?? "–";
  const secs = data.seconds_until_change;
  $("countdown").textContent =
    secs == null ? "--" : Math.max(0, Number(secs)).toFixed(1);
  if (data.source) {
    $("meta").textContent = data.source;
  } else if (data.age_seconds != null) {
    $("meta").textContent = `update ${Number(data.age_seconds).toFixed(1)}s geleden`;
  } else {
    $("meta").textContent = "live";
  }
}

(async () => {
  $("api-base").value = getApiBase();
  $("api-save").addEventListener("click", async () => {
    const v = $("api-base").value.trim().replace(/\/+$/, "");
    if (v) localStorage.setItem(API_BASE_KEY, v);
    else localStorage.removeItem(API_BASE_KEY);
    await detectMode();
  });
  await detectMode();
  setInterval(tick, 200);
  tick();
})();
