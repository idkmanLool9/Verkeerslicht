// Werkt in twee modi:
// 1. "Live" - als er een backend bereikbaar is op /api (FastAPI uit de repo).
// 2. "Demo" - statische browser-simulator. Gebruikt op GitHub Pages.

const $ = (id) => document.getElementById(id);

const CYCLE = [
  { phase: "permissive-Movement-Allowed", color: "green", duration: 15 },
  { phase: "permissive-clearance",        color: "amber", duration: 3  },
  { phase: "stop-And-Remain",             color: "red",   duration: 22 },
];
const TOTAL = CYCLE.reduce((a, c) => a + c.duration, 0);
const DEMO_INTERSECTION_ID = 9999;
const startEpoch = Date.now() / 1000;

function setLamp(color) {
  for (const k of ["red", "amber", "green"]) $(k).classList.remove("on");
  if (color === "red" || color === "red-amber" || color === "stop-Then-Proceed") $("red").classList.add("on");
  if (color === "amber" || color === "red-amber") $("amber").classList.add("on");
  if (color === "green") $("green").classList.add("on");
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

let mode = "loading"; // "live" | "demo"

async function detectMode() {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      mode = data.demo_mode ? "demo-server" : "live";
    } else {
      mode = "demo";
    }
  } catch {
    mode = "demo";
  }
  const badge = $("mode");
  if (mode === "live") {
    badge.textContent = "Live (server)";
    badge.className = "mode live";
  } else if (mode === "demo-server") {
    badge.textContent = "Demo (server)";
    badge.className = "mode demo";
  } else {
    badge.textContent = "Demo (browser)";
    badge.className = "mode demo";
  }
}

async function tick() {
  const ix = $("ix").value;
  const sg = $("sg").value;

  if (mode === "live" || mode === "demo-server") {
    try {
      const res = await fetch(`/api/signals/${encodeURIComponent(ix)}/${encodeURIComponent(sg)}`);
      if (!res.ok) {
        $("phase").className = "meta error";
        $("phase").textContent = `Geen data (HTTP ${res.status})`;
        setLamp("unknown");
        return;
      }
      const data = await res.json();
      render(data);
    } catch (e) {
      $("phase").className = "meta error";
      $("phase").textContent = `Fout: ${e.message}`;
    }
    return;
  }

  // Browser-only demo
  const data = localPhase(sg);
  if (!data) {
    setLamp("unknown");
    return;
  }
  render(data);
}

function render(data) {
  setLamp(data.color);
  $("phase").className = "meta";
  $("phase").textContent = `Fase: ${data.phase} (${data.color})`;
  const secs = data.seconds_until_change;
  $("countdown").textContent = secs == null ? "--" : Number(secs).toFixed(1);
  const age = data.age_seconds == null ? null : Number(data.age_seconds).toFixed(1);
  $("meta").textContent = age == null
    ? `Bron: ${data.source ?? "server"}`
    : `Bron-update: ${age}s geleden`;
}

(async () => {
  await detectMode();
  setInterval(tick, 200);
  tick();
})();
