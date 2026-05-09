// Verkeerslicht — kaart, routes, lichten en rit-simulatie.
//
// Volledig static (geen backend nodig). Gebruikt:
//  - Leaflet + OpenStreetMap tiles
//  - Nominatim (OSM) voor adres -> coördinaten
//  - OSRM demo voor routing met alternatieven
//  - Overpass API voor verkeerslicht-locaties (highway=traffic_signals)
//
// Onderscheid slim/klassiek: zonder UDAP-creds weten we het niet zeker.
// We classificeren ~30% van de lichten als "slim" via een stabiele hash
// van de OSM node-id. Slimme lichten krijgen een gesimuleerde 40s-cyclus
// en aftelling; klassieke lichten worden alleen als locatie getoond.

const $ = (id) => document.getElementById(id);
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const OVERPASS = "https://overpass-api.de/api/interpreter";

const CYCLE = [
  { phase: "groen", color: "green", duration: 15 },
  { phase: "geel",  color: "amber", duration: 3  },
  { phase: "rood",  color: "red",   duration: 22 },
];
const CYCLE_TOTAL = CYCLE.reduce((a, c) => a + c.duration, 0);

const SMART_RATIO = 30; // % van de lichten gemarkeerd als "slim" in demo
const MAX_DIST_TO_ROUTE_M = 30;

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
  routes: [],          // [{ coords, cumDist, distance, duration, polyline, glow, signals, signalsLayer }]
  activeRouteIdx: -1,
  startMarker: null,
  endMarker: null,
  driver: null,
  driving: false,
  driveStart: 0,
  drivePos: 0,
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
  if (!text) { $("loading").classList.add("hidden"); return; }
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

function projectOnPolyline(point, coords, cumDist) {
  let best = { minD: Infinity, distAlong: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const segLen = cumDist[i + 1] - cumDist[i];
    if (segLen <= 0) continue;
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
    if (d < best.minD) best = { minD: d, distAlong: cumDist[i] + t * segLen };
  }
  return best;
}

function pointAtDistance(coords, cumDist, distM) {
  if (distM <= 0) return coords[0];
  if (distM >= cumDist[cumDist.length - 1]) return coords[coords.length - 1];
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

// ============ Smart classifier ============
function hash32(n) {
  // xorshift-ish stable hash → 0..99
  let x = (n | 0) ^ 0x9e3779b1;
  x = (x ^ (x << 13)) | 0;
  x = (x ^ (x >>> 17)) | 0;
  x = (x ^ (x << 5)) | 0;
  return Math.abs(x) % 100;
}
function isSmart(nodeId) {
  return hash32(Number(nodeId)) < SMART_RATIO;
}

// ============ Phase simulation ============
function phaseAt(offsetS, atEpochS = Date.now() / 1000) {
  let elapsed = ((atEpochS + offsetS) % CYCLE_TOTAL + CYCLE_TOTAL) % CYCLE_TOTAL;
  let t = 0;
  for (const step of CYCLE) {
    if (elapsed < t + step.duration) {
      return { phase: step.phase, color: step.color, secondsLeft: (t + step.duration) - elapsed };
    }
    t += step.duration;
  }
  return null;
}
function predictAtArrival(offsetS, etaSeconds) {
  return phaseAt(offsetS, Date.now() / 1000 + etaSeconds);
}

// ============ External APIs ============
async function geocode(query) {
  const url = `${NOMINATIM}?format=json&limit=1&countrycodes=nl&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Geocoding mislukt (${res.status})`);
  const json = await res.json();
  if (!json.length) throw new Error(`Niet gevonden: ${query}`);
  return { lat: parseFloat(json[0].lat), lon: parseFloat(json[0].lon), display: json[0].display_name };
}

async function fetchRoutes(from, to) {
  const url = `${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}?alternatives=3&overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing mislukt (${res.status})`);
  const json = await res.json();
  if (!json.routes?.length) throw new Error("Geen route gevonden");
  return json.routes.map((r) => {
    const coords = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const cum = [0];
    for (let i = 1; i < coords.length; i++) {
      cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    }
    return {
      coords,
      cumDist: cum,
      distance: r.distance,
      duration: r.duration,
      legSummary: r.legs?.[0]?.summary || "",
    };
  });
}

async function fetchSignalsBbox(coords) {
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
  if (!res.ok) throw new Error(`Stoplichten ophalen mislukt (${res.status})`);
  const json = await res.json();
  return json.elements ?? [];
}

function filterSignalsToRoute(signals, coords, cumDist) {
  const out = [];
  const seen = new Set();
  for (const s of signals) {
    const proj = projectOnPolyline([s.lat, s.lon], coords, cumDist);
    if (proj.minD > MAX_DIST_TO_ROUTE_M) continue;
    const key = Math.round(proj.distAlong / 30);
    if (seen.has(key)) continue;
    seen.add(key);
    const smart = isSmart(s.id);
    out.push({
      id: s.id,
      lat: s.lat,
      lon: s.lon,
      distM: proj.distAlong,
      smart,
      offsetS: smart ? Math.abs((s.id * 31) % CYCLE_TOTAL) - CYCLE_TOTAL / 2 : 0,
    });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}

// ============ Markers ============
function makeSignalMarker(s) {
  const className = s.smart ? "signal-marker smart" : "signal-marker classic";
  const icon = L.divIcon({
    className: "",
    html: `<div class="${className}"></div>`,
    iconSize: s.smart ? [14, 14] : [10, 10],
    iconAnchor: s.smart ? [7, 7] : [5, 5],
  });
  return L.marker([s.lat, s.lon], { icon, interactive: false }).addTo(map);
}
function setSmartMarkerColor(marker, color) {
  const el = marker.getElement()?.querySelector(".signal-marker.smart");
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

// ============ Route rendering ============
function clearAll() {
  for (const r of state.routes) {
    if (r.polyline) map.removeLayer(r.polyline);
    if (r.glow) map.removeLayer(r.glow);
    if (r.signalsLayer) map.removeLayer(r.signalsLayer);
  }
  state.routes = [];
  state.activeRouteIdx = -1;
  if (state.startMarker) { map.removeLayer(state.startMarker); state.startMarker = null; }
  if (state.endMarker) { map.removeLayer(state.endMarker); state.endMarker = null; }
  if (state.driver) { map.removeLayer(state.driver); state.driver = null; }
  state.drivePos = 0;
  state.driving = false;
}

function drawRoute(r, isActive) {
  if (r.polyline) map.removeLayer(r.polyline);
  if (r.glow) map.removeLayer(r.glow);
  const colour = isActive ? "#ffcc00" : "#6c7785";
  const weight = isActive ? 6 : 4;
  const opacity = isActive ? 0.95 : 0.55;
  if (isActive) {
    r.glow = L.polyline(r.coords, { color: "#ffcc00", weight: 14, opacity: 0.15, lineCap: "round", lineJoin: "round" });
    r.glow.addTo(map);
  }
  r.polyline = L.polyline(r.coords, { color: colour, weight, opacity, lineCap: "round", lineJoin: "round" });
  r.polyline.addTo(map);
  if (!isActive) {
    r.polyline.on("click", () => selectRoute(state.routes.indexOf(r)));
  }
}

function setActiveRoute(idx) {
  state.activeRouteIdx = idx;
  for (let i = 0; i < state.routes.length; i++) {
    drawRoute(state.routes[i], i === idx);
    // signals only visible for active route
    if (state.routes[i].signalsLayer) {
      if (i === idx) state.routes[i].signalsLayer.addTo(map);
      else map.removeLayer(state.routes[i].signalsLayer);
    }
  }
  // Bring active polyline to top
  if (state.routes[idx]?.polyline) state.routes[idx].polyline.bringToFront();
  if (state.driver) state.driver.bringToFront();
}

function selectRoute(idx) {
  if (idx < 0 || idx >= state.routes.length || idx === state.activeRouteIdx) return;
  setActiveRoute(idx);
  state.drivePos = 0;
  if (state.driver) {
    state.driver.setLatLng(state.routes[idx].coords[0]);
  }
  state.driving = false;
  $("drive-toggle").textContent = "Start rit";
  renderRouteList();
  renderEta();
  // Pan/zoom to new route
  map.fitBounds(state.routes[idx].polyline.getBounds(), { padding: [60, 60] });
}

// ============ UI rendering ============
function setMode(label, kind) {
  const el = $("mode");
  el.textContent = label;
  el.className = "mode" + (kind ? " " + kind : "");
}

function renderRouteList() {
  const list = $("routes-list");
  if (!state.routes.length) {
    list.classList.add("hidden");
    list.innerHTML = "";
    return;
  }
  list.classList.remove("hidden");
  list.innerHTML = '<div class="routes-title">routes</div>';
  state.routes.forEach((r, i) => {
    const card = document.createElement("button");
    card.className = "route-card" + (i === state.activeRouteIdx ? " selected" : "");
    const smartCount = (r.signals ?? []).filter(s => s.smart).length;
    const totalCount = (r.signals ?? []).length;
    const via = r.legSummary ? `via ${r.legSummary}` : "";
    card.innerHTML = `
      <div class="route-time">${fmtDuration(r.duration)}</div>
      <div class="route-meta">${fmtDistance(r.distance)} · ${totalCount} lichten · ${smartCount} slim</div>
      ${via ? `<div class="route-via">${via}</div>` : ""}
    `;
    card.addEventListener("click", () => selectRoute(i));
    list.appendChild(card);
  });
}

function showSheet() {
  $("sheet").classList.remove("hidden");
  $("sheet").setAttribute("aria-hidden", "false");
  setTimeout(() => map.invalidateSize(), 50);
}
function hideSheet() {
  $("sheet").classList.add("hidden");
  $("sheet").setAttribute("aria-hidden", "true");
}

function setNextLightUI(data) {
  const card = $("next-light");
  card.classList.remove("is-red", "is-amber", "is-green", "classic");
  $("mini-red").classList.remove("on");
  $("mini-amber").classList.remove("on");
  $("mini-green").classList.remove("on");

  if (!data) {
    $("next-distance").textContent = "–";
    $("next-phase").textContent = "geen lichten meer";
    $("next-countdown").textContent = "--";
    return;
  }
  $("next-distance").textContent = fmtDistance(data.remainingM);
  if (!data.smart) {
    card.classList.add("classic");
    $("next-phase").textContent = "klassiek licht — geen live data";
    $("next-countdown").textContent = "klassiek";
    return;
  }
  if (data.color === "red")   { $("mini-red").classList.add("on");   card.classList.add("is-red"); }
  if (data.color === "amber") { $("mini-amber").classList.add("on"); card.classList.add("is-amber"); }
  if (data.color === "green") { $("mini-green").classList.add("on"); card.classList.add("is-green"); }
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
    if (s.smart) {
      const eta = etaToFunc(remain);
      const arr = predictAtArrival(s.offsetS, eta);
      li.innerHTML = `
        <span class="dot ${arr.color}"></span>
        <span>${fmtDistance(remain)}</span>
        <span class="meta">${arr.phase} · ${Math.round(arr.secondsLeft)}s</span>
      `;
    } else {
      li.classList.add("classic");
      li.innerHTML = `
        <span class="dot classic"></span>
        <span>${fmtDistance(remain)}</span>
        <span class="meta">klassiek</span>
      `;
    }
    list.appendChild(li);
  }
}

function avgSpeedMS() {
  const r = state.routes[state.activeRouteIdx];
  if (r && r.duration > 0 && r.distance > 0) return r.distance / r.duration;
  return 50 / 3.6;
}

function renderEta() {
  const r = state.routes[state.activeRouteIdx];
  if (!r) return;
  const speed = avgSpeedMS();
  const remain = Math.max(0, r.distance - state.drivePos);
  const remainS = remain / speed;
  $("eta-distance").textContent = fmtDistance(remain);
  $("eta-duration").textContent = fmtDuration(remainS);
  $("eta-time").textContent = fmtClock(new Date(Date.now() + remainS * 1000));
  $("eta-signals").textContent = r.signals.length;
  $("eta-smart").textContent = r.signals.filter(s => s.smart).length;
}

// ============ Main flow ============
async function planRoute() {
  const fromQ = $("from").value.trim();
  const toQ = $("to").value.trim();
  if (!fromQ || !toQ) { showToast("Vul vertrekpunt en bestemming in."); return; }

  setLoading("Adressen opzoeken…");
  try {
    const [from, to] = await Promise.all([geocode(fromQ), geocode(toQ)]);

    setLoading("Routes plannen…");
    const routes = await fetchRoutes(from, to);

    setLoading("Stoplichten ophalen…");
    // Eén bbox-query voor de unie van alle alternatieven
    const allCoords = routes.flatMap(r => r.coords);
    const rawSignals = await fetchSignalsBbox(allCoords);

    // Filter per route afzonderlijk
    for (const r of routes) {
      r.signals = filterSignalsToRoute(rawSignals, r.coords, r.cumDist);
    }

    clearAll();
    state.routes = routes;
    state.startMarker = makeEndpointMarker(from.lat, from.lon, false);
    state.endMarker = makeEndpointMarker(to.lat, to.lon, true);

    // Build per-route signal layers (only active is shown on map)
    for (const r of routes) {
      const layer = L.layerGroup();
      r.signalsLayer = layer;
      r._signalMarkers = r.signals.map(s => {
        const m = makeSignalMarker(s);
        layer.addLayer(m);
        // We added directly to map in makeSignalMarker; remove and re-add via layer
        map.removeLayer(m);
        return m;
      });
    }

    state.driver = makeDriverMarker(routes[0].coords[0][0], routes[0].coords[0][1]);
    setActiveRoute(0);
    map.fitBounds(routes[0].polyline.getBounds(), { padding: [60, 60] });
    renderRouteList();
    renderEta();
    showSheet();
    setLoading(null);
  } catch (e) {
    setLoading(null);
    showToast(e.message ?? String(e));
    console.error(e);
  }
}

function tick() {
  const r = state.routes[state.activeRouteIdx];
  if (!r) return;
  const speed = avgSpeedMS();

  if (state.driving) {
    const now = performance.now();
    const dt = (now - state.driveStart) / 1000;
    state.drivePos = Math.min(r.distance, dt * speed);
    if (state.drivePos >= r.distance) {
      state.driving = false;
      $("drive-toggle").textContent = "Start rit";
    }
    const p = pointAtDistance(r.coords, r.cumDist, state.drivePos);
    state.driver.setLatLng(p);
    if (state.driving) map.panTo(p, { animate: false });
  }

  // Update slimme markers
  for (let i = 0; i < r.signals.length; i++) {
    const s = r.signals[i];
    if (!s.smart) continue;
    const ph = phaseAt(s.offsetS);
    setSmartMarkerColor(r._signalMarkers[i], ph.color);
  }

  // Volgend stoplicht
  const next = r.signals.find(s => s.distM > state.drivePos + 1);
  if (next) {
    const remainingM = next.distM - state.drivePos;
    const eta = remainingM / speed;
    if (next.smart) {
      const nowPh = phaseAt(next.offsetS);
      const arrPh = predictAtArrival(next.offsetS, eta);
      setNextLightUI({
        smart: true,
        color: nowPh.color,
        phase: nowPh.phase,
        secondsLeft: nowPh.secondsLeft,
        remainingM,
        arrival: arrPh.phase,
      });
    } else {
      setNextLightUI({ smart: false, remainingM });
    }
  } else {
    setNextLightUI(null);
  }

  // Lijst en ETA elke 500ms
  const t = Math.floor(performance.now() / 500);
  if (t !== tick._lastT) {
    tick._lastT = t;
    renderUpcoming(r.signals, state.drivePos, (m) => m / speed);
    renderEta();
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
$("swap").addEventListener("click", () => {
  const a = $("from").value, b = $("to").value;
  $("from").value = b;
  $("to").value = a;
});
$("locate").addEventListener("click", async () => {
  if (!navigator.geolocation) { showToast("Geolocatie niet beschikbaar."); return; }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude, longitude } = pos.coords;
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=16`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const json = await res.json();
      $("from").value = json.display_name?.split(",").slice(0, 3).join(",") ?? `${latitude},${longitude}`;
    } catch {
      $("from").value = `${pos.coords.latitude},${pos.coords.longitude}`;
    }
  }, () => showToast("Kon je locatie niet ophalen."), { enableHighAccuracy: false, timeout: 5000 });
});
$("drive-toggle").addEventListener("click", () => {
  if (state.activeRouteIdx < 0) return;
  if (state.driving) {
    state.driving = false;
    $("drive-toggle").textContent = "Hervat";
  } else {
    state.driving = true;
    state.driveStart = performance.now() - (state.drivePos / avgSpeedMS()) * 1000;
    $("drive-toggle").textContent = "Pauze";
  }
});

// ============ Boot ============
setMode("Demo", "demo");
startTickLoop();
