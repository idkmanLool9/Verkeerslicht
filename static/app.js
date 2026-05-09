// Verkeerslicht — slimme stoplichten op je route.
//
// Volledig static (werkt op GitHub Pages). Externe API's:
//  - Nominatim (OSM)         : adres/zoek-suggesties + reverse-geocode
//  - OSRM demo               : routing met alternatieven (auto/fiets/voet)
//  - Overpass API            : verkeerslicht-locaties uit OSM
//
// SPaT-fasen worden gesimuleerd; de classifier voor "slim" gebruikt
// geografische hotspots (Helmond, Eindhoven, Tilburg etc. waar veel
// iVRI's zijn) plus een stabiele hash. Voor echte UDAP-data: stel een
// API-URL in (UDAP-API veld in de sidebar) en bouw zelf de backend.

console.log("Verkeerslicht v3.0 boot", new Date().toISOString());

const $ = (id) => document.getElementById(id);
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REV = "https://nominatim.openstreetmap.org/reverse";
const OSRM = "https://router.project-osrm.org/route/v1";
const OVERPASS = "https://overpass-api.de/api/interpreter";

const PROFILE_TO_OSRM = { driving: "driving", cycling: "cycling", foot: "foot" };
const PROFILE_DEFAULT_SPEED_MS = { driving: 50/3.6, cycling: 18/3.6, foot: 5/3.6 };

const CYCLE = [
  { phase: "groen", color: "green", duration: 15 },
  { phase: "geel",  color: "amber", duration: 3  },
  { phase: "rood",  color: "red",   duration: 22 },
];
const CYCLE_TOTAL = CYCLE.reduce((a, c) => a + c.duration, 0);
const MAX_DIST_TO_ROUTE_M = 30;

// iVRI-hotspots in NL (publiek bekende concentraties) — stedelijke
// kernen waar Talking Traffic actief is gerold uit. Buiten 5 km van
// deze kernen vallen we terug op een lagere baseline.
const IVRI_HOTSPOTS = [
  { name: "Helmond",         lat: 51.4793, lon: 5.6570, ratio: 80 },
  { name: "Eindhoven",       lat: 51.4416, lon: 5.4697, ratio: 55 },
  { name: "Tilburg",         lat: 51.5555, lon: 5.0913, ratio: 50 },
  { name: "Den Bosch",       lat: 51.6978, lon: 5.3037, ratio: 45 },
  { name: "Breda",           lat: 51.5719, lon: 4.7683, ratio: 40 },
  { name: "Utrecht",         lat: 52.0907, lon: 5.1214, ratio: 45 },
  { name: "Amersfoort",      lat: 52.1561, lon: 5.3878, ratio: 35 },
  { name: "Amsterdam",       lat: 52.3702, lon: 4.8952, ratio: 40 },
  { name: "Haarlem",         lat: 52.3874, lon: 4.6462, ratio: 30 },
  { name: "Zaanstad",        lat: 52.4389, lon: 4.8290, ratio: 25 },
  { name: "Den Haag",        lat: 52.0705, lon: 4.3007, ratio: 45 },
  { name: "Rotterdam",       lat: 51.9244, lon: 4.4777, ratio: 40 },
  { name: "Delft",           lat: 52.0116, lon: 4.3571, ratio: 30 },
  { name: "Leiden",          lat: 52.1601, lon: 4.4970, ratio: 30 },
  { name: "Zwolle",          lat: 52.5168, lon: 6.0830, ratio: 30 },
  { name: "Enschede",        lat: 52.2215, lon: 6.8937, ratio: 30 },
  { name: "Apeldoorn",       lat: 52.2112, lon: 5.9699, ratio: 25 },
  { name: "Arnhem",          lat: 51.9851, lon: 5.8987, ratio: 30 },
  { name: "Nijmegen",        lat: 51.8126, lon: 5.8372, ratio: 35 },
  { name: "Groningen",       lat: 53.2194, lon: 6.5665, ratio: 30 },
  { name: "Maastricht",      lat: 50.8514, lon: 5.6909, ratio: 25 },
  { name: "Heerlen",         lat: 50.8882, lon: 5.9795, ratio: 20 },
  { name: "Almere",          lat: 52.3508, lon: 5.2647, ratio: 25 },
];

// ============ State ============
const state = {
  routes: [],
  activeRouteIdx: -1,
  startMarker: null,
  endMarker: null,
  viaMarkers: [],
  driver: null,
  driving: false,
  driveStart: 0,
  drivePos: 0,
  rafId: null,
  profile: "driving",
  preferFewest: false,
  voiceOn: false,
  gpsWatch: null,
  followGps: false,
  cityLightsLayer: null,
  cityLightsZoomHandler: null,
  spokenLightIds: new Set(),
  driveStats: { lights: 0, red: 0, amber: 0, green: 0, classic: 0, startedAt: 0 },
  apiBase: localStorage.getItem("verkeerslicht.apiBase") || "",
};

// ============ Theme ============
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme-toggle").textContent = t === "light" ? "☀️" : "🌙";
  localStorage.setItem("verkeerslicht.theme", t);
}
applyTheme(localStorage.getItem("verkeerslicht.theme") || "dark");

// ============ Map ============
const map = L.map("map", {
  zoomControl: true,
  attributionControl: true,
  zoomAnimation: true,
}).setView([52.1, 5.3], 8);

L.tileLayer(TILE_URL, {
  maxZoom: 19,
  attribution: '© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

// Move zoom controls to bottom-left to avoid the sidebar
map.zoomControl.setPosition("bottomleft");

// ============ Utility ============
function showToast(msg, kind, ms = 3500) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (kind ? " " + kind : "");
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
function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
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
  let x = (n | 0) ^ 0x9e3779b1;
  x = (x ^ (x << 13)) | 0;
  x = (x ^ (x >>> 17)) | 0;
  x = (x ^ (x << 5)) | 0;
  return Math.abs(x) % 100;
}
function smartRatioFor(lat, lon) {
  let best = 12; // baseline buiten stedelijke gebieden
  for (const h of IVRI_HOTSPOTS) {
    const d = haversine([lat, lon], [h.lat, h.lon]);
    if (d < 3000) best = Math.max(best, h.ratio);
    else if (d < 6000) best = Math.max(best, h.ratio * 0.7);
    else if (d < 10000) best = Math.max(best, h.ratio * 0.4);
  }
  return best;
}
function isSmart(node) {
  return hash32(Number(node.id)) < smartRatioFor(node.lat, node.lon);
}

// ============ Phase ============
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
function offsetForNode(id) {
  return Math.abs((Number(id) * 31) % CYCLE_TOTAL) - CYCLE_TOTAL / 2;
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
async function suggest(query) {
  if (!query || query.length < 2) return [];
  const url = `${NOMINATIM}?format=json&limit=6&countrycodes=nl&addressdetails=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  return await res.json();
}
async function fetchRoutes(coords) {
  const profile = PROFILE_TO_OSRM[state.profile] ?? "driving";
  const list = coords.map(c => `${c.lon},${c.lat}`).join(";");
  const url = `${OSRM}/${profile}/${list}?alternatives=${coords.length === 2 ? 3 : 0}&overview=full&geometries=geojson&steps=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing mislukt (${res.status})`);
  const json = await res.json();
  if (!json.routes?.length) throw new Error("Geen route gevonden");
  return json.routes.map((r) => {
    const c = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + haversine(c[i - 1], c[i]));
    return {
      coords: c, cumDist: cum,
      distance: r.distance, duration: r.duration,
      legSummary: r.legs?.map(l => l.summary).filter(Boolean).join(", ") || "",
    };
  });
}
async function fetchSignalsBbox(bbox) {
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

// Snelheidslimieten van OSM-ways langs de route. We samplen de route
// elke ~stride meter en doen een Overpass `around:`-query. Levert ways
// met maxspeed-tag terug; daarna projecteren we ze op de route.
async function fetchMaxspeedAlongRoute(route) {
  const stride = Math.max(150, Math.ceil(route.distance / 150));
  const samples = [];
  for (let d = 0; d < route.distance; d += stride) {
    samples.push(pointAtDistance(route.coords, route.cumDist, d));
    if (samples.length >= 200) break;
  }
  if (!samples.length) return [];
  const around = samples.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(",");
  const query = `[out:json][timeout:30];way["highway"]["maxspeed"](around:25,${around});out tags geom;`;
  try {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.elements ?? [];
  } catch { return []; }
}

// Zet maxspeed-string om naar km/u (of null als onbekend).
function parseMaxspeed(s) {
  if (s == null) return null;
  let v = String(s).trim().toLowerCase();
  if (!v) return null;
  if (v === "none" || v === "signals" || v === "variable") return null;
  if (v === "walk") return 5;
  if (v.includes("nl:zone30")) return 30;
  if (v.includes("nl:zone60")) return 60;
  if (v.includes("nl:urban")) return 50;
  if (v.includes("nl:rural")) return 80;
  if (v.includes("nl:trunk")) return 100;
  if (v.includes("nl:motorway")) return 130;
  const m = v.match(/^(\d+)(?:\.\d+)?\s*(mph|kmh|km\/h)?$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (m[2] === "mph") return Math.round(n * 1.609344);
    return n;
  }
  return null;
}

// Bouw [{fromM, toM, speed}, …] door way-geometry op de route te
// projecteren. Een way overlapt waar zijn punten ≤25m van de route zitten.
function buildSpeedIntervals(ways, route) {
  const intervals = [];
  for (const w of ways) {
    const speed = parseMaxspeed(w.tags?.maxspeed);
    if (speed == null) continue;
    const ds = [];
    for (const pt of w.geometry || []) {
      const proj = projectOnPolyline([pt.lat, pt.lon], route.coords, route.cumDist);
      if (proj.minD < 25) ds.push(proj.distAlong);
    }
    if (ds.length < 2) continue;
    intervals.push({ speed, fromM: Math.min(...ds), toM: Math.max(...ds) });
  }
  intervals.sort((a, b) => a.fromM - b.fromM);
  return intervals;
}

// Limiet bij een specifieke positie. Pakt het kortste overlappend
// interval (specifiekere weg-tag wint) of fallback.
function speedLimitAt(intervals, distM, fallback = 50) {
  let bestSpan = Infinity;
  let lim = fallback;
  for (const iv of intervals) {
    if (iv.fromM <= distM && distM <= iv.toM) {
      const span = iv.toM - iv.fromM;
      if (span < bestSpan) { bestSpan = span; lim = iv.speed; }
    }
  }
  return lim;
}

// Laagste limiet tussen [fromM, toM].
function lowestLimitBetween(intervals, fromM, toM, fallback = 50) {
  let lim = Infinity;
  for (const iv of intervals) {
    if (iv.toM < fromM || iv.fromM > toM) continue;
    if (iv.speed < lim) lim = iv.speed;
  }
  return lim === Infinity ? fallback : lim;
}
function bboxOfCoords(coords, padDeg = 0.005) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lat, lon] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return `${minLat - padDeg},${minLon - padDeg},${maxLat + padDeg},${maxLon + padDeg}`;
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
    const smart = isSmart(s);
    out.push({
      id: s.id, lat: s.lat, lon: s.lon,
      distM: proj.distAlong,
      smart,
      offsetS: smart ? offsetForNode(s.id) : 0,
    });
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}

// ============ Markers ============
function makeSignalMarker(s, addToMap = true) {
  const className = s.smart ? "signal-marker smart" : "signal-marker classic";
  const sz = s.smart ? 14 : 10;
  const icon = L.divIcon({
    className: "",
    html: `<div class="${className}"></div>`,
    iconSize: [sz, sz], iconAnchor: [sz/2, sz/2],
  });
  const m = L.marker([s.lat, s.lon], { icon, interactive: false });
  if (addToMap) m.addTo(map);
  return m;
}
function setSmartMarkerColor(marker, color) {
  const el = marker.getElement()?.querySelector(".signal-marker.smart");
  if (!el) return;
  el.classList.remove("red", "amber", "green");
  if (color) el.classList.add(color);
}
function makeEndpointMarker(lat, lon, kind = "from") {
  const cls = kind === "to" ? " end" : kind === "via" ? " via" : "";
  const icon = L.divIcon({
    className: "",
    html: `<div class="endpoint-marker${cls}"></div>`,
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
  return L.marker([lat, lon], { icon }).addTo(map);
}
function makeDriverMarker(lat, lon) {
  const icon = L.divIcon({
    className: "",
    html: '<div class="driver-marker"></div>',
    iconSize: [18, 18], iconAnchor: [9, 9],
  });
  return L.marker([lat, lon], { icon }).addTo(map);
}

// ============ Route drawing ============
function clearAll() {
  for (const r of state.routes) {
    if (r.polyline) map.removeLayer(r.polyline);
    if (r.glow) map.removeLayer(r.glow);
    if (r.signalsLayer) map.removeLayer(r.signalsLayer);
  }
  state.routes = [];
  state.activeRouteIdx = -1;
  if (state.startMarker) { map.removeLayer(state.startMarker); state.startMarker = null; }
  if (state.endMarker)   { map.removeLayer(state.endMarker); state.endMarker = null; }
  for (const m of state.viaMarkers) map.removeLayer(m);
  state.viaMarkers = [];
  if (state.driver) { map.removeLayer(state.driver); state.driver = null; }
  state.drivePos = 0;
  state.driving = false;
  state.spokenLightIds.clear();
}
function drawRoute(r, isActive) {
  if (r.polyline) map.removeLayer(r.polyline);
  if (r.glow) map.removeLayer(r.glow);
  if (isActive) {
    r.glow = L.polyline(r.coords, { color: "#ffcc00", weight: 14, opacity: 0.15, lineCap: "round", lineJoin: "round" });
    r.glow.addTo(map);
  }
  const colour = isActive ? "#ffcc00" : "#6c7785";
  const weight = isActive ? 6 : 4;
  const opacity = isActive ? 0.95 : 0.55;
  r.polyline = L.polyline(r.coords, { color: colour, weight, opacity, lineCap: "round", lineJoin: "round" });
  r.polyline.addTo(map);
  if (!isActive) r.polyline.on("click", () => selectRoute(state.routes.indexOf(r)));
}
function setActiveRoute(idx) {
  state.activeRouteIdx = idx;
  for (let i = 0; i < state.routes.length; i++) {
    drawRoute(state.routes[i], i === idx);
    if (state.routes[i].signalsLayer) {
      if (i === idx) state.routes[i].signalsLayer.addTo(map);
      else map.removeLayer(state.routes[i].signalsLayer);
    }
  }
  if (state.routes[idx]?.polyline) state.routes[idx].polyline.bringToFront();
}
function selectRoute(idx) {
  if (idx < 0 || idx >= state.routes.length || idx === state.activeRouteIdx) return;
  setActiveRoute(idx);
  state.drivePos = 0;
  state.spokenLightIds.clear();
  if (state.driver) state.driver.setLatLng(state.routes[idx].coords[0]);
  state.driving = false;
  $("drive-toggle").textContent = "Start rit";
  renderRouteList();
  renderEta();
  map.fitBounds(state.routes[idx].polyline.getBounds(), { padding: [60, 60] });
}

// ============ City-wide lights (zoomed in) ============
async function refreshCityLights() {
  if (!$("show-all-lights").checked) {
    if (state.cityLightsLayer) {
      map.removeLayer(state.cityLightsLayer);
      state.cityLightsLayer = null;
    }
    return;
  }
  const z = map.getZoom();
  if (z < 12) {
    if (state.cityLightsLayer) {
      map.removeLayer(state.cityLightsLayer);
      state.cityLightsLayer = null;
    }
    return;
  }
  const b = map.getBounds();
  const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
  try {
    const elements = await fetchSignalsBbox(bbox);
    if (state.cityLightsLayer) map.removeLayer(state.cityLightsLayer);
    const layer = L.layerGroup();
    for (const s of elements) {
      const enriched = { id: s.id, lat: s.lat, lon: s.lon };
      enriched.smart = isSmart(enriched);
      enriched.offsetS = enriched.smart ? offsetForNode(s.id) : 0;
      const m = makeSignalMarker(enriched, false);
      layer.addLayer(m);
      if (enriched.smart) {
        m._smartOffset = enriched.offsetS;
      }
    }
    layer.addTo(map);
    state.cityLightsLayer = layer;
  } catch (e) { /* stil */ }
}
const refreshCityLightsDebounced = debounce(refreshCityLights, 600);

// ============ UI ============
function setMode(label, kind) {
  const el = $("mode");
  el.textContent = label;
  el.className = "mode" + (kind ? " " + kind : "");
}
function getWaypointInputs() {
  return Array.from(document.querySelectorAll(".wp-input"));
}
function getWaypointValues() {
  return getWaypointInputs().map(i => i.value.trim());
}
function addStop() {
  const inputs = getWaypointInputs();
  if (inputs.length >= 6) { showToast("Maximaal 6 punten."); return; }
  const wp = $("waypoints");
  const newRow = document.createElement("div");
  newRow.className = "search-row";
  newRow.dataset.role = "via";
  const idx = inputs.length;
  newRow.innerHTML = `
    <span class="pin via" aria-hidden="true"></span>
    <input class="search-input wp-input" type="text" placeholder="Tussenstop" autocomplete="off" data-idx="${idx}" />
    <button class="remove-btn" title="Verwijderen" aria-label="Verwijderen">×</button>
  `;
  // Insert before the last (to) row
  const toRow = wp.querySelector('[data-role="to"]');
  wp.insertBefore(newRow, toRow);
  newRow.querySelector(".remove-btn").addEventListener("click", () => {
    newRow.remove();
    reindexInputs();
  });
  newRow.querySelector("input").addEventListener("input", onSuggestInput);
  newRow.querySelector("input").addEventListener("focus", onSuggestInput);
  newRow.querySelector("input").addEventListener("keydown", onInputKey);
  reindexInputs();
}
function reindexInputs() {
  getWaypointInputs().forEach((i, idx) => i.dataset.idx = String(idx));
}

function showSheet() {
  $("sheet").classList.remove("hidden");
  $("sheet").setAttribute("aria-hidden", "false");
  setTimeout(() => map.invalidateSize(), 50);
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
    $("glosa").classList.add("hidden");
    return;
  }
  $("next-distance").textContent = fmtDistance(data.remainingM);
  if (!data.smart) {
    card.classList.add("classic");
    $("next-phase").textContent = "klassiek licht — geen live data";
    $("next-countdown").textContent = "klassiek";
    $("glosa").classList.add("hidden");
    return;
  }
  if (data.color === "red")   { $("mini-red").classList.add("on");   card.classList.add("is-red"); }
  if (data.color === "amber") { $("mini-amber").classList.add("on"); card.classList.add("is-amber"); }
  if (data.color === "green") { $("mini-green").classList.add("on"); card.classList.add("is-green"); }
  $("next-phase").textContent = `nu ${data.phase} · bij aankomst ${data.arrival}`;
  $("next-countdown").textContent = data.secondsLeft.toFixed(0);
}
function setGlosa(text, kind) {
  const el = $("glosa");
  if (!text) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden", "warn");
  if (kind === "warn") el.classList.add("warn");
  $("glosa-text").textContent = text;
}
function setSpeedSign(kmh) {
  const el = $("speed-sign");
  if (!el) return;
  if (kmh == null) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  $("speed-sign-num").textContent = String(Math.round(kmh));
}

function renderRouteList() {
  const list = $("routes-list");
  if (!state.routes.length) { list.classList.add("hidden"); list.innerHTML = ""; return; }
  list.classList.remove("hidden");
  list.innerHTML = '<div class="routes-title">routes</div>';
  // Sort indices by user preference
  const indices = state.routes.map((_, i) => i);
  if (state.preferFewest) {
    indices.sort((a, b) => (state.routes[a].signals?.length ?? 0) - (state.routes[b].signals?.length ?? 0));
  }
  for (const i of indices) {
    const r = state.routes[i];
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
  }
}
function avgSpeedMS() {
  const r = state.routes[state.activeRouteIdx];
  if (r && r.duration > 0 && r.distance > 0) return r.distance / r.duration;
  return PROFILE_DEFAULT_SPEED_MS[state.profile];
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
function renderUpcoming(signals, drivePosM, speed) {
  const list = $("upcoming-list");
  list.innerHTML = "";
  const upcoming = signals.filter(s => s.distM > drivePosM + 1).slice(0, 8);
  for (const s of upcoming) {
    const li = document.createElement("li");
    const remain = s.distM - drivePosM;
    if (s.smart) {
      const eta = remain / speed;
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

// ============ GLOSA ============
// Bereken een snelheidsadvies: welke snelheid moet je rijden om bij
// het volgende slimme licht aan te komen tijdens groen, ZONDER de
// wettelijke maxsnelheid te overschrijden?
function computeGlosa(remainingM, smartLight, currentSpeedMS, limitMS) {
  if (!smartLight || !smartLight.smart || remainingM <= 0) return null;
  const minMS = Math.max(2, Math.min(currentSpeedMS, limitMS) * 0.4);
  const maxMS = Math.min(limitMS, Math.max(currentSpeedMS, limitMS));
  if (maxMS <= minMS) return { feasible: false, limitMS };
  let best = null;
  for (let v = minMS; v <= maxMS; v += 0.25) {
    const eta = remainingM / v;
    if (eta > 180) continue;
    const ph = predictAtArrival(smartLight.offsetS, eta);
    if (ph.color !== "green") continue;
    const diff = Math.abs(v - currentSpeedMS);
    if (!best || diff < best.diff) best = { v, diff, eta };
  }
  if (best) return { feasible: true, ...best, limitMS };
  return { feasible: false, limitMS };
}

// ============ Spraak ============
function speak(text) {
  if (!state.voiceOn || !("speechSynthesis" in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "nl-NL";
    u.rate = 1.05;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

// ============ Main flow ============
async function planRoute() {
  hideSuggestions();
  const values = getWaypointValues();
  const valid = values.filter(Boolean);
  if (valid.length < 2) { showToast("Vul minstens vertrek en bestemming in.", "error"); return; }

  setLoading("Adressen opzoeken…");
  try {
    const points = await Promise.all(valid.map(geocode));
    setLoading("Routes plannen…");
    const routes = await fetchRoutes(points);

    setLoading("Stoplichten ophalen…");
    const allCoords = routes.flatMap(r => r.coords);
    const rawSignals = await fetchSignalsBbox(bboxOfCoords(allCoords));

    for (const r of routes) {
      r.signals = filterSignalsToRoute(rawSignals, r.coords, r.cumDist);
    }

    setLoading("Snelheidslimieten ophalen…");
    const limitWaysPerRoute = await Promise.all(routes.map(fetchMaxspeedAlongRoute));
    routes.forEach((r, i) => {
      r.limitIntervals = buildSpeedIntervals(limitWaysPerRoute[i], r);
    });

    clearAll();
    state.routes = routes;
    state.startMarker = makeEndpointMarker(points[0].lat, points[0].lon, "from");
    state.endMarker   = makeEndpointMarker(points[points.length - 1].lat, points[points.length - 1].lon, "to");
    for (let i = 1; i < points.length - 1; i++) {
      state.viaMarkers.push(makeEndpointMarker(points[i].lat, points[i].lon, "via"));
    }

    for (const r of routes) {
      const layer = L.layerGroup();
      r.signalsLayer = layer;
      r._signalMarkers = r.signals.map(s => {
        const m = makeSignalMarker(s, false);
        layer.addLayer(m);
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

    saveHistory(values);
    updateShareLink(values);
    $("share-btn").disabled = false;
  } catch (e) {
    setLoading(null);
    showToast(e.message ?? String(e), "error");
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
      finishDrive();
    }
    const p = pointAtDistance(r.coords, r.cumDist, state.drivePos);
    state.driver.setLatLng(p);
    if (state.driving && !state.followGps) map.panTo(p, { animate: false });
  }

  // Update slimme markers (route)
  for (let i = 0; i < r.signals.length; i++) {
    const s = r.signals[i];
    if (!s.smart) continue;
    const ph = phaseAt(s.offsetS);
    setSmartMarkerColor(r._signalMarkers[i], ph.color);
  }

  // Update slimme markers (city-wide layer)
  if (state.cityLightsLayer) {
    state.cityLightsLayer.eachLayer(m => {
      if (m._smartOffset !== undefined) {
        const ph = phaseAt(m._smartOffset);
        setSmartMarkerColor(m, ph.color);
      }
    });
  }

  // Snelheidslimieten op basis van OSM
  const intervals = r.limitIntervals || [];
  const fallbackKmh = state.profile === "driving" ? 50 : state.profile === "cycling" ? 25 : 5;
  const currentLimitKmh = speedLimitAt(intervals, state.drivePos, fallbackKmh);
  setSpeedSign(currentLimitKmh);

  // Volgend stoplicht
  const next = r.signals.find(s => s.distM > state.drivePos + 1);
  if (next) {
    const remainingM = next.distM - state.drivePos;
    if (next.smart) {
      const eta = remainingM / speed;
      const nowPh = phaseAt(next.offsetS);
      const arrPh = predictAtArrival(next.offsetS, eta);
      setNextLightUI({
        smart: true, color: nowPh.color, phase: nowPh.phase,
        secondsLeft: nowPh.secondsLeft, remainingM, arrival: arrPh.phase,
      });
      // GLOSA-advies — capped op de laagste limiet tussen hier en het licht
      if (state.driving) {
        const limKmh = lowestLimitBetween(intervals, state.drivePos, next.distM, fallbackKmh);
        const tip = computeGlosa(remainingM, next, speed, limKmh / 3.6);
        if (tip && tip.feasible) {
          const targetKmh = Math.round(tip.v * 3.6);
          if (Math.abs(targetKmh - Math.round(speed * 3.6)) <= 2) {
            setGlosa(`Op kruissnelheid haal je groen (max ${limKmh})`, "ok");
          } else {
            setGlosa(`Rijd ~${targetKmh} km/u voor groen (limiet ${limKmh})`, "ok");
          }
        } else {
          setGlosa(`Wordt rood — niet binnen limiet ${limKmh} te halen`, "warn");
        }
      } else setGlosa(null);
      // Spraak: 1x per licht aankondigen op ~150m
      if (state.driving && remainingM < 150 && !state.spokenLightIds.has(next.id)) {
        state.spokenLightIds.add(next.id);
        speak(`${arrPh.phase} licht over ${Math.round(remainingM)} meter`);
      }
    } else {
      setNextLightUI({ smart: false, remainingM });
      setGlosa(null);
      if (state.driving && remainingM < 150 && !state.spokenLightIds.has(next.id)) {
        state.spokenLightIds.add(next.id);
        speak(`Klassiek licht over ${Math.round(remainingM)} meter`);
      }
    }
  } else {
    setNextLightUI(null);
  }

  const t = Math.floor(performance.now() / 500);
  if (t !== tick._lastT) {
    tick._lastT = t;
    renderUpcoming(r.signals, state.drivePos, speed);
    renderEta();
  }
}
function startTickLoop() {
  function loop() {
    try { tick(); } catch (e) { console.error(e); }
    state.rafId = requestAnimationFrame(loop);
  }
  if (state.rafId) cancelAnimationFrame(state.rafId);
  loop();
}

function finishDrive() {
  // Verzamel stats van wat de driver passeerde
  const r = state.routes[state.activeRouteIdx];
  if (!r) return;
  const dur = (Date.now() / 1000) - state.driveStats.startedAt;
  const passed = r.signals.filter(s => s.distM <= state.drivePos);
  let red = 0, green = 0, amber = 0, classic = 0;
  for (const s of passed) {
    if (!s.smart) { classic++; continue; }
    const eta = s.distM / avgSpeedMS();
    const ph = predictAtArrival(s.offsetS, -dur + eta);
    if (ph.color === "red") red++;
    else if (ph.color === "green") green++;
    else if (ph.color === "amber") amber++;
  }
  $("stat-distance").textContent = fmtDistance(r.distance);
  $("stat-duration").textContent = fmtDuration(dur);
  $("stat-lights").textContent = passed.length;
  $("stat-red").textContent = red;
  $("stat-green").textContent = green;
  $("stats-modal").classList.remove("hidden");
}

// ============ Suggestions ============
let activeSuggestionInput = null;
let activeSuggestionIdx = -1;
let lastSuggestions = [];
const debouncedSuggest = debounce(async (input, q) => {
  if (input !== activeSuggestionInput) return;
  const items = await suggest(q);
  if (input !== activeSuggestionInput) return;
  lastSuggestions = items;
  renderSuggestions(items);
}, 250);
function renderSuggestions(items) {
  const box = $("suggestions");
  if (!items.length) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML = "";
  items.forEach((it, idx) => {
    const div = document.createElement("div");
    div.className = "suggestion" + (idx === activeSuggestionIdx ? " active" : "");
    const parts = (it.display_name || "").split(",");
    const primary = parts.slice(0, 2).join(",").trim();
    const secondary = parts.slice(2).join(",").trim();
    div.innerHTML = `
      <span class="primary">${primary}</span>
      <span class="secondary">${secondary || "Nederland"}</span>
    `;
    div.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSuggestion(idx);
    });
    box.appendChild(div);
  });
  // Position dropdown under the active input
  if (activeSuggestionInput) {
    const r = activeSuggestionInput.getBoundingClientRect();
    const sb = $("suggestions").parentElement.getBoundingClientRect();
    box.style.top = (r.bottom - sb.top + 4) + "px";
    box.style.left = (r.left - sb.left) + "px";
    box.style.right = "auto";
    box.style.width = r.width + "px";
  }
}
function hideSuggestions() {
  $("suggestions").classList.add("hidden");
  activeSuggestionIdx = -1;
}
function pickSuggestion(idx) {
  const it = lastSuggestions[idx];
  if (!it || !activeSuggestionInput) return;
  activeSuggestionInput.value = (it.display_name || "").split(",").slice(0, 3).join(",").trim();
  hideSuggestions();
}
function onSuggestInput(e) {
  activeSuggestionInput = e.target;
  activeSuggestionIdx = -1;
  const q = e.target.value.trim();
  if (q.length < 2) { hideSuggestions(); return; }
  debouncedSuggest(e.target, q);
}
function onInputKey(e) {
  if (e.key === "Enter" && $("suggestions").classList.contains("hidden")) {
    planRoute();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestionIdx = Math.min(lastSuggestions.length - 1, activeSuggestionIdx + 1);
    renderSuggestions(lastSuggestions);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestionIdx = Math.max(-1, activeSuggestionIdx - 1);
    renderSuggestions(lastSuggestions);
  } else if (e.key === "Enter" && activeSuggestionIdx >= 0) {
    e.preventDefault();
    pickSuggestion(activeSuggestionIdx);
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
}

// ============ History ============
function saveHistory(values) {
  const list = JSON.parse(localStorage.getItem("verkeerslicht.history") || "[]");
  const entry = { values, at: Date.now() };
  // dedup by stringified values
  const key = JSON.stringify(values);
  const filtered = list.filter(e => JSON.stringify(e.values) !== key);
  filtered.unshift(entry);
  localStorage.setItem("verkeerslicht.history", JSON.stringify(filtered.slice(0, 5)));
  renderHistory();
}
function renderHistory() {
  const box = $("history");
  const list = JSON.parse(localStorage.getItem("verkeerslicht.history") || "[]");
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = "";
  for (const e of list) {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `<span class="history-icon">↺</span><span>${e.values[0]} → ${e.values[e.values.length - 1]}</span>`;
    item.addEventListener("click", () => {
      // restore values; re-add stops if needed
      const inputs = getWaypointInputs();
      // remove extra rows
      while (getWaypointInputs().length > 2) {
        const vias = document.querySelectorAll('.search-row[data-role="via"]');
        if (vias.length) vias[vias.length - 1].remove();
        else break;
      }
      // add via stops as needed
      while (getWaypointInputs().length < e.values.length) addStop();
      getWaypointInputs().forEach((inp, i) => inp.value = e.values[i] ?? "");
      planRoute();
    });
    box.appendChild(item);
  }
}

// ============ Share ============
function updateShareLink(values) {
  const url = new URL(window.location.href);
  url.searchParams.set("from", values[0]);
  url.searchParams.set("to", values[values.length - 1]);
  if (values.length > 2) url.searchParams.set("via", values.slice(1, -1).join("|"));
  url.searchParams.set("p", state.profile);
  window.history.replaceState(null, "", url.toString());
}
function tryAutoplanFromUrl() {
  const url = new URL(window.location.href);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const via = url.searchParams.get("via");
  const p = url.searchParams.get("p");
  if (!from || !to) return;
  if (p && PROFILE_TO_OSRM[p]) setProfile(p);
  if (via) {
    for (const v of via.split("|")) addStop();
  }
  const inputs = getWaypointInputs();
  inputs[0].value = from;
  if (via) {
    via.split("|").forEach((v, i) => { if (inputs[i+1]) inputs[i+1].value = v; });
  }
  inputs[inputs.length - 1].value = to;
  planRoute();
}

// ============ Profile (auto/fiets/voet) ============
function setProfile(p) {
  state.profile = p;
  document.querySelectorAll(".pill").forEach(b => {
    b.classList.toggle("active", b.dataset.profile === p);
  });
}

// ============ GPS ============
function startGps() {
  if (!navigator.geolocation) { showToast("Geolocatie niet beschikbaar.", "error"); return; }
  state.gpsWatch = navigator.geolocation.watchPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    if (state.driver) state.driver.setLatLng([latitude, longitude]);
    else state.driver = makeDriverMarker(latitude, longitude);
    // Project onto active route (if any)
    const r = state.routes[state.activeRouteIdx];
    if (r) {
      const proj = projectOnPolyline([latitude, longitude], r.coords, r.cumDist);
      state.drivePos = proj.distAlong;
    }
    if (state.followGps) map.panTo([latitude, longitude], { animate: false });
  }, () => {}, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
}
function stopGps() {
  if (state.gpsWatch != null) {
    navigator.geolocation.clearWatch(state.gpsWatch);
    state.gpsWatch = null;
  }
}

// ============ Event wiring ============
function wireSuggestionsForInput(input) {
  input.addEventListener("input", onSuggestInput);
  input.addEventListener("focus", onSuggestInput);
  input.addEventListener("keydown", onInputKey);
  input.addEventListener("blur", () => setTimeout(hideSuggestions, 180));
}
document.querySelectorAll(".wp-input").forEach(wireSuggestionsForInput);

$("plan").addEventListener("click", planRoute);
$("add-stop").addEventListener("click", addStop);
$("swap").addEventListener("click", () => {
  const inputs = getWaypointInputs();
  if (inputs.length < 2) return;
  const a = inputs[0].value;
  inputs[0].value = inputs[inputs.length - 1].value;
  inputs[inputs.length - 1].value = a;
});
$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) { showToast("Geolocatie niet beschikbaar.", "error"); return; }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude, longitude } = pos.coords;
      const url = `${NOMINATIM_REV}?format=json&lat=${latitude}&lon=${longitude}&zoom=16`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const json = await res.json();
      const inputs = getWaypointInputs();
      inputs[0].value = json.display_name?.split(",").slice(0, 3).join(",") ?? `${latitude},${longitude}`;
    } catch {
      const inputs = getWaypointInputs();
      inputs[0].value = `${pos.coords.latitude},${pos.coords.longitude}`;
    }
  }, () => showToast("Kon je locatie niet ophalen.", "error"));
});
$("drive-toggle").addEventListener("click", () => {
  if (state.activeRouteIdx < 0) return;
  if (state.driving) {
    state.driving = false;
    $("drive-toggle").textContent = "Hervat";
  } else {
    state.driving = true;
    state.driveStart = performance.now() - (state.drivePos / avgSpeedMS()) * 1000;
    state.driveStats = { startedAt: Date.now() / 1000 };
    $("drive-toggle").textContent = "Pauze";
  }
});
$("theme-toggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});
$("voice-toggle").addEventListener("click", () => {
  state.voiceOn = !state.voiceOn;
  $("voice-toggle").textContent = state.voiceOn ? "🔊" : "🔇";
  $("voice-toggle").classList.toggle("active", state.voiceOn);
  if (state.voiceOn) speak("Spraak aan");
});
$("share-btn").addEventListener("click", async () => {
  const url = window.location.href;
  try {
    if (navigator.share) await navigator.share({ title: "Verkeerslicht-route", url });
    else {
      await navigator.clipboard.writeText(url);
      showToast("Link gekopieerd.");
    }
  } catch {}
});
document.querySelectorAll(".pill").forEach(b => {
  b.addEventListener("click", () => {
    setProfile(b.dataset.profile);
    if (state.routes.length) planRoute();
  });
});
$("prefer-fewest").addEventListener("change", (e) => {
  state.preferFewest = e.target.checked;
  if (state.routes.length) {
    // pick the first route after sort
    const indices = state.routes.map((_, i) => i);
    if (state.preferFewest) indices.sort((a, b) => (state.routes[a].signals?.length ?? 0) - (state.routes[b].signals?.length ?? 0));
    selectRoute(indices[0]);
  }
});
$("show-all-lights").addEventListener("change", refreshCityLights);
$("follow-gps").addEventListener("change", (e) => {
  state.followGps = e.target.checked;
  if (state.followGps) startGps();
  else stopGps();
});
$("api-base").value = state.apiBase;
$("api-save").addEventListener("click", () => {
  const v = $("api-base").value.trim().replace(/\/+$/, "");
  if (v) localStorage.setItem("verkeerslicht.apiBase", v);
  else localStorage.removeItem("verkeerslicht.apiBase");
  state.apiBase = v;
  showToast("Opgeslagen.");
});
$("stats-close").addEventListener("click", () => $("stats-modal").classList.add("hidden"));

map.on("zoomend moveend", refreshCityLightsDebounced);

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) hideSuggestions();
});

// ============ Boot ============
setMode("Demo", "demo");
renderHistory();
startTickLoop();
setTimeout(tryAutoplanFromUrl, 100);

// Service worker (minimal, voor PWA-installeerbaar)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
