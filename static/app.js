// Verkeerslicht — kaart, route, lichten en rit-simulatie.
//
// Volledig static (geen backend nodig). Gebruikt:
//  - Leaflet + OpenStreetMap tiles voor de kaart
//  - Nominatim (OSM) voor adres -> coördinaten
//  - OSRM demo-server voor routing
//  - Overpass API voor verkeerslicht-locaties (highway=traffic_signals)
//
// SPaT-fasen worden lokaal gesimuleerd met een 40s-cyclus per kruising
// (groen 15s / geel 3s / rood 22s, met willekeurige offset per licht).
// Voor echte UDAP-data: stel een API-URL in via localStorage-key
// "verkeerslicht.apiBase" — dan wordt /api/signals/{lat}/{lon} gebruikt
// (nog niet geïmplementeerd in de backend; eerst koppelen aan iVRI ID).

const $ = (id) => document.getElementById(id);
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const OVERPASS = "https://overpass-api.de/api/interpreter";

// Demo-cycle, gedeeld door alle gesimuleerde lichten
const CYCLE = [
  { phase: "groen", color: "green", duration: 15 },
  { phase: "geel",  color: "amber", duration: 3  },
  { phase: "rood",  color: "red",   duration: 22 },
];
const CYCLE_TOTAL = CYCLE.reduce((a, c) => a + c.duration, 0);

// ============ Map ============
const map = L.map("map", {
  zoomControl: true,
  attributionControl: true,
}).setView([52.1, 5.3], 8);

L.tileLayer(TILE_URL, {
  maxZoom: 19,
  attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

// ============ State ============
const state = {
  routeLine: null,
  routeCoords: [], // [[lat, lon], ...]
  routeCumDist: [], // cumulative distance in meters at each routeCoord
  totalDistanceM: 0,
  totalDurationS: 0,
  signals: [], // { lat, lon, marker, distM, offsetS }
  startMarker: null,
  endMarker: null,
  driver: null, // marker
  driving: false,
  driveStart: 0, // performance.now()
  driveSpeedMS: 50 / 3.6, // 50 km/u default
  drivePos: 0, // meters along route
  rafId: null,
};

// ============ Utility ============
function showToast(msg, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function setLoading(text) {
  if (!text) {
    $("loading").classList.add("hidden");
    return;
  }
  $("loading-text").textContent = text;
  $("loading").classList.remove("hidden");
}

function fmtDuration(s) {
  if (!isFinite(s) || s < 0) return "–";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} u ${mm} min` : `${h} u`;
}
function fmtDistance(m) {
  if (m == null) return "–";
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function fmtClock(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Project a point onto a polyline. Returns { distAlong: meters along route,
// minD: distance from line, idx: segment index, t: param along segment }
function projectOnPolyline(point, coords, cumDist) {
  let best = { minD: Infinity, distAlong: 0, idx: 0, t: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const segLen = cumDist[i + 1] - cumDist[i];
    if (segLen <= 0) continue;
    // Equirectangular projection for short distances
    const lat0 = ((a[0] + b[0]) / 2) * Math.PI / 180;
    const ax = a[1], ay = a[0];
    const bx = b[1], by = b[0];
    const px = point[1], py = point[0];
    const dx = (bx - ax) * Math.cos(lat0);
    const dy = by - ay;
    const ex = (px - ax) * Math.cos(lat0);
    const ey = py - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? (ex * dx + ey * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const projLat = a[0] + t * (b[0] - a[0]);
    const projLon = a[1] + t * (b[1] - a[1]);
    const d = haversine(point, [projLat, projLon]);
    if (d < best.minD) {
      best = { minD: d, distAlong: cumDist[i] + t * segLen, idx: i, t };
    }
  }
  return best;
}

function pointAtDistance(coords, cumDist, distM) {
  if (distM <= 0) return coords[0];
  if (distM >= cumDist[cumDist.length - 1]) return coords[coords.length - 1];
  // Binary search
  let lo = 0, hi = cumDist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= distM) lo = mid;
    else hi = mid;
  }
  const segLen = cumDist[hi] - cumDist[lo];
  const t = segLen > 0 ? (distM - cumDist[lo]) / segLen : 0;
  return [
    coords[lo][0] + t * (coords[hi][0] - coords[lo][0]),
    coords[lo][1] + t * (coords[hi][1] - coords[lo][1]),
  ];
}

// ============ Phase simulation ============
function phaseAt(offsetS, atEpochS = Date.now() / 1000) {
  let elapsed = ((atEpochS + offsetS) % CYCLE_TOTAL + CYCLE_TOTAL) % CYCLE_TOTAL;
  let t = 0;
  for (const step of CYCLE) {
    if (elapsed < t + step.duration) {
      return {
        phase: step.phase,
        color: step.color,
        secondsLeft: (t + step.duration) - elapsed,
      };
    }
    t += step.duration;
  }
  return null;
}

// Predict the phase a given signal will be in when the driver arrives.
function predictAtArrival(offsetS, etaSeconds) {
  return phaseAt(offsetS, Date.now() / 1000 + etaSeconds);
}

// ============ Geocoding ============
async function geocode(query) {
  const url = `${NOMINATIM}?format=json&limit=1&countrycodes=nl&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`geocoding mislukt (${res.status})`);
  const json = await res.json();
  if (!json.length) throw new Error(`niet gevonden: ${query}`);
  return { lat: parseFloat(json[0].lat), lon: parseFloat(json[0].lon), display: json[0].display_name };
}

// ============ Routing ============
async function fetchRoute(from, to) {
  const url = `${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`routing mislukt (${res.status})`);
  const json = await res.json();
  if (!json.routes?.length) throw new Error("geen route gevonden");
  const r = json.routes[0];
  // GeoJSON coords are [lon, lat]; convert to [lat, lon]
  const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
  // Cumulative distances
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  }
  return { coords, cumDist: cum, distance: r.distance, duration: r.duration };
}

// ============ Traffic signals ============
async function fetchSignals(coords) {
  // Bounding box of route, padded a bit
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const pad = 0.005;
  const bbox = `${minLat - pad},${minLon - pad},${maxLat + pad},${maxLon + pad}`;
  const query = `[out:json][timeout:25];node["highway"="traffic_signals"](${bbox});out body;`;
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "data=" + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`stoplichten ophalen mislukt (${res.status})`);
  const json = await res.json();
  return json.elements ?? [];
}

function filterSignalsToRoute(signals, coords, cumDist, maxDistFromRouteM = 25) {
  const out = [];
  const seen = new Set();
  for (const s of signals) {
    const proj = projectOnPolyline([s.lat, s.lon], coords, cumDist);
    if (proj.minD > maxDistFromRouteM) continue;
    // Deduplicate signals that project to ~same spot (cluster of pole nodes)
    const key = Math.round(proj.distAlong / 30);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: s.id,
      lat: s.lat,
      lon: s.lon,
      distM: proj.distAlong,
      // Pseudo-random but stable phase offset per node id
      offsetS: Math.abs((s.id * 31) % CYCLE_TOTAL) - CYCLE_TOTAL / 2,
    });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}

// ============ Markers & route drawing ============
function clearRoute() {
  if (state.routeLine) { map.removeLayer(state.routeLine); state.routeLine = null; }
  for (const s of state.signals) {
    if (s.marker) map.removeLayer(s.marker);
  }
  state.signals = [];
  if (state.startMarker) { map.removeLayer(state.startMarker); state.startMarker = null; }
  if (state.endMarker) { map.removeLayer(state.endMarker); state.endMarker = null; }
  if (state.driver) { map.removeLayer(state.driver); state.driver = null; }
}

function drawRoute(coords) {
  state.routeLine = L.polyline(coords, {
    color: "#ffcc00",
    weight: 6,
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);
  // Outer glow line
  L.polyline(coords, {
    color: "#ffcc00",
    weight: 14,
    opacity: 0.15,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(map);
  map.fitBounds(state.routeLine.getBounds(), { padding: [40, 40] });
}

function makeSignalMarker(lat, lon) {
  const icon = L.divIcon({
    className: "",
    html: '<div class="signal-marker"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  return L.marker([lat, lon], { icon, interactive: false }).addTo(map);
}

function setSignalMarkerColor(marker, color) {
  const el = marker.getElement()?.querySelector(".signal-marker");
  if (!el) return;
  el.classList.remove("red", "amber", "green");
  if (color) el.classList.add(color);
}

function makeEndpointMarker(lat, lon, end = false) {
  const icon = L.divIcon({
    className: "",
    html: `<div class="endpoint-marker${end ? " end" : ""}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  return L.marker([lat, lon], { icon }).addTo(map);
}

function makeDriverMarker(lat, lon) {
  const icon = L.divIcon({
    className: "",
    html: '<div class="driver-marker"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  return L.marker([lat, lon], { icon }).addTo(map);
}

// ============ UI updates ============
function setMode(label, kind) {
  const el = $("mode");
  el.textContent = label;
  el.className = "mode" + (kind ? " " + kind : "");
}

function showSheet() {
  $("search").classList.add("hidden");
  $("sheet").classList.remove("hidden");
  $("sheet").setAttribute("aria-hidden", "false");
  setTimeout(() => map.invalidateSize(), 50);
}
function showSearch() {
  $("sheet").classList.add("hidden");
  $("sheet").setAttribute("aria-hidden", "true");
  $("search").classList.remove("hidden");
  setTimeout(() => map.invalidateSize(), 50);
}

function setNextLightUI(data) {
  const card = $("next-light");
  card.classList.remove("is-red", "is-amber", "is-green");
  $("mini-red").classList.remove("on");
  $("mini-amber").classList.remove("on");
  $("mini-green").classList.remove("on");
  if (!data) {
    $("next-distance").textContent = "–";
    $("next-phase").textContent = "geen lichten";
    $("next-countdown").textContent = "--";
    return;
  }
  if (data.color === "red")   { $("mini-red").classList.add("on");   card.classList.add("is-red"); }
  if (data.color === "amber") { $("mini-amber").classList.add("on"); card.classList.add("is-amber"); }
  if (data.color === "green") { $("mini-green").classList.add("on"); card.classList.add("is-green"); }
  $("next-distance").textContent = fmtDistance(data.remainingM);
  $("next-phase").textContent = `nu ${data.phase} · bij aankomst ${data.arrival}`;
  $("next-countdown").textContent = data.secondsLeft.toFixed(0);
}

function renderUpcoming(signals, drivePosM, etaToFunc) {
  const list = $("upcoming-list");
  list.innerHTML = "";
  const upcoming = signals.filter(s => s.distM > drivePosM + 1).slice(0, 8);
  for (const s of upcoming) {
    const li = document.createElement("li");
    const remain = s.distM - drivePosM;
    const eta = etaToFunc(remain);
    const arrival = predictAtArrival(s.offsetS, eta);
    li.innerHTML = `
      <span class="dot ${arrival.color}"></span>
      <span>${fmtDistance(remain)}</span>
      <span class="meta">${arrival.phase} · ${Math.round(arrival.secondsLeft)}s</span>
    `;
    list.appendChild(li);
  }
}

// ============ Main flow ============
async function planRoute() {
  const fromQ = $("from").value.trim();
  const toQ = $("to").value.trim();
  if (!fromQ || !toQ) {
    showToast("Vul vertrekpunt en bestemming in.");
    return;
  }
  setLoading("Adressen opzoeken…");
  try {
    const [from, to] = await Promise.all([geocode(fromQ), geocode(toQ)]);
    setLoading("Route plannen…");
    const route = await fetchRoute(from, to);
    setLoading("Stoplichten ophalen…");
    const rawSignals = await fetchSignals(route.coords);
    const signals = filterSignalsToRoute(rawSignals, route.coords, route.cumDist);

    // Reset map
    clearRoute();
    state.routeCoords = route.coords;
    state.routeCumDist = route.cumDist;
    state.totalDistanceM = route.distance;
    state.totalDurationS = route.duration;

    drawRoute(route.coords);
    state.startMarker = makeEndpointMarker(from.lat, from.lon, false);
    state.endMarker = makeEndpointMarker(to.lat, to.lon, true);

    state.signals = signals.map(s => ({
      ...s,
      marker: makeSignalMarker(s.lat, s.lon),
    }));

    state.drivePos = 0;
    state.driving = false;
    $("drive-toggle").textContent = "Start rit";
    state.driver = makeDriverMarker(route.coords[0][0], route.coords[0][1]);

    // ETA labels
    $("eta-distance").textContent = fmtDistance(route.distance);
    $("eta-duration").textContent = fmtDuration(route.duration);
    $("eta-time").textContent = fmtClock(new Date(Date.now() + route.duration * 1000));
    $("eta-signals").textContent = signals.length;

    showSheet();
    setLoading(null);
  } catch (e) {
    setLoading(null);
    showToast(e.message ?? String(e));
    console.error(e);
  }
}

function avgSpeedMS() {
  if (state.totalDurationS > 0 && state.totalDistanceM > 0) {
    return state.totalDistanceM / state.totalDurationS;
  }
  return state.driveSpeedMS;
}

function etaFromHere(remainingM) {
  return remainingM / avgSpeedMS();
}

function tick() {
  if (!state.routeCoords.length) return;
  const speed = avgSpeedMS();

  if (state.driving) {
    const now = performance.now();
    const dt = (now - state.driveStart) / 1000;
    state.drivePos = Math.min(state.totalDistanceM, dt * speed);
    if (state.drivePos >= state.totalDistanceM) {
      state.driving = false;
      $("drive-toggle").textContent = "Start rit";
    }
    const p = pointAtDistance(state.routeCoords, state.routeCumDist, state.drivePos);
    state.driver.setLatLng(p);
    if (state.driving) map.panTo(p, { animate: false });
  }

  // Update marker colors based on current phase (live, ongeacht of we rijden)
  for (const s of state.signals) {
    const ph = phaseAt(s.offsetS);
    setSignalMarkerColor(s.marker, ph.color);
  }

  // Next light
  const next = state.signals.find(s => s.distM > state.drivePos + 1);
  if (next) {
    const remainingM = next.distM - state.drivePos;
    const eta = remainingM / speed;
    const nowPh = phaseAt(next.offsetS);
    const arrPh = predictAtArrival(next.offsetS, eta);
    setNextLightUI({
      color: nowPh.color,
      phase: nowPh.phase,
      secondsLeft: nowPh.secondsLeft,
      remainingM,
      arrival: `${arrPh.phase}`,
    });
  } else {
    setNextLightUI(null);
  }

  // Upcoming list (re-render only ~every 500ms to save CPU)
  const t = Math.floor(performance.now() / 500);
  if (t !== tick._lastT) {
    tick._lastT = t;
    renderUpcoming(state.signals, state.drivePos, etaFromHere);

    // ETA bar updates
    const remain = state.totalDistanceM - state.drivePos;
    const remainS = remain / speed;
    $("eta-distance").textContent = fmtDistance(remain);
    $("eta-duration").textContent = fmtDuration(remainS);
    $("eta-time").textContent = fmtClock(new Date(Date.now() + remainS * 1000));
  }
}

function startTickLoop() {
  function loop() {
    tick();
    state.rafId = requestAnimationFrame(loop);
  }
  if (state.rafId) cancelAnimationFrame(state.rafId);
  loop();
}

// ============ Event wiring ============
$("plan").addEventListener("click", planRoute);
[$("from"), $("to")].forEach(el =>
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") planRoute(); })
);

$("drive-toggle").addEventListener("click", () => {
  if (!state.routeCoords.length) return;
  if (state.driving) {
    state.driving = false;
    $("drive-toggle").textContent = "Hervat rit";
  } else {
    state.driving = true;
    state.driveStart = performance.now() - (state.drivePos / avgSpeedMS()) * 1000;
    $("drive-toggle").textContent = "Pauze";
  }
});

$("reset").addEventListener("click", () => {
  clearRoute();
  state.routeCoords = [];
  state.routeCumDist = [];
  state.driving = false;
  showSearch();
});

// ============ Boot ============
setMode("Demo", "demo");
startTickLoop();
