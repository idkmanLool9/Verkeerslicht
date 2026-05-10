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

// ============ Adaptief leren ============
// Onthoud per signaal-id de werkelijke wachttijden die je opliep.
// Na een paar samples passen we onze fase-voorspelling aan.
function loadAdaptive() {
  try { return JSON.parse(localStorage.getItem("verkeerslicht.adaptive") || "{}"); }
  catch { return {}; }
}
function saveAdaptive(data) {
  try { localStorage.setItem("verkeerslicht.adaptive", JSON.stringify(data)); } catch {}
}
function recordObservedWait(signalId, waitSeconds) {
  const data = loadAdaptive();
  const e = data[signalId] || { samples: [], n: 0, sum: 0 };
  e.samples = [...e.samples.slice(-9), waitSeconds]; // laatste 10
  e.n = e.samples.length;
  e.sum = e.samples.reduce((a, b) => a + b, 0);
  e.avg = e.sum / e.n;
  data[signalId] = e;
  saveAdaptive(data);
}
function adaptiveStatsFor(signalId) {
  const data = loadAdaptive();
  const e = data[signalId];
  return e && e.n >= 2 ? e : null;
}

// ============ Cache ============
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
function cacheKey(prefix, key) { return `verkeerslicht.cache.${prefix}.${key}`; }
function cacheGet(prefix, key) {
  try {
    const raw = localStorage.getItem(cacheKey(prefix, key));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (Date.now() - obj.t > CACHE_TTL_MS) return null;
    return obj.v;
  } catch { return null; }
}
function cacheSet(prefix, key, v) {
  try { localStorage.setItem(cacheKey(prefix, key), JSON.stringify({ t: Date.now(), v })); } catch {}
}

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
  vehicle: loadVehicle(),
};

// ============ Theme ============
const THEME_ICONS = { dark: "🌙", light: "☀️", hc: "🟡" };
const THEME_ORDER = ["dark", "light", "hc"];
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme-toggle").textContent = THEME_ICONS[t] || "🌙";
  $("theme-toggle").title = `Thema: ${t} (klik om te wisselen)`;
  localStorage.setItem("verkeerslicht.theme", t);
}
applyTheme(localStorage.getItem("verkeerslicht.theme") || "dark");

// ============ Wake-lock ============
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch {}
}
async function releaseWakeLock() {
  try { if (wakeLock) await wakeLock.release(); } catch {}
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.driving) requestWakeLock();
});

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

// ============ Weer (Open-Meteo, gratis, geen key) ============
const WEATHER_ICON = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌦️",
  61: "🌧️", 63: "🌧️", 65: "🌧️",
  71: "🌨️", 73: "🌨️", 75: "❄️",
  80: "🌧️", 81: "🌧️", 82: "⛈️",
  95: "⛈️", 96: "⛈️", 99: "⛈️",
};
async function fetchWeather(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,weather_code,precipitation`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()).current ?? null;
  } catch { return null; }
}
function weatherFactor(w) {
  if (!w) return 1.0;
  const p = w.precipitation ?? 0;
  if (p > 5) return 0.82;
  if (p > 2) return 0.90;
  if (p > 0.2) return 0.95;
  return 1.0;
}
function renderWeather(w) {
  const el = $("weather");
  if (!w) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  $("weather-icon").textContent = WEATHER_ICON[w.weather_code] ?? "🌡️";
  $("weather-temp").textContent = `${Math.round(w.temperature_2m)}°`;
}
let currentWeather = null;
async function refreshWeather(lat, lon) {
  currentWeather = await fetchWeather(lat, lon);
  renderWeather(currentWeather);
}

// ============ CO2 / verbruik ============
const EMISSIONS = {
  driving: { co2_g_per_km: 120, label: "auto (gemiddeld)" },
  cycling: { co2_g_per_km: 0,   label: "fiets" },
  foot:    { co2_g_per_km: 0,   label: "lopen" },
};
const FUEL_DEFAULT_CO2 = {
  benzine: 120, diesel: 130, lpg: 110, cng: 100,
  elektriciteit: 50, hybride: 80, waterstof: 30, alcohol: 100,
};
function fmtCo2(grams) {
  if (grams < 1000) return `${Math.round(grams)} g`;
  return `${(grams / 1000).toFixed(1)} kg`;
}

// ============ Voertuig (RDW) ============
// LET OP: deze functies worden tijdens state-init aangeroepen, dus geen
// const-verwijzingen die hierna pas geinitialiseerd worden.
function normalizeKenteken(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").substring(0, 8);
}
function formatKenteken(s) {
  const k = normalizeKenteken(s);
  if (k.length <= 2) return k;
  if (k.length <= 4) return `${k.slice(0, 2)}-${k.slice(2)}`;
  if (k.length <= 6) return `${k.slice(0, 2)}-${k.slice(2, 4)}-${k.slice(4)}`;
  return `${k.slice(0, 2)}-${k.slice(2, 4)}-${k.slice(4, 6)}-${k.slice(6)}`;
}
function loadVehicle() {
  try { return JSON.parse(localStorage.getItem("verkeerslicht.vehicle") || "null"); } catch { return null; }
}
function saveVehicle(v) {
  try { localStorage.setItem("verkeerslicht.vehicle", JSON.stringify(v)); } catch {}
}
function clearVehicle() { localStorage.removeItem("verkeerslicht.vehicle"); }

function rdwDate(s) {
  if (!s) return null;
  const str = String(s);
  if (str.length >= 8) return `${str.substring(6, 8)}-${str.substring(4, 6)}-${str.substring(0, 4)}`;
  return str;
}
function rdwYear(s) {
  if (!s) return null;
  const str = String(s);
  return str.length >= 4 ? str.substring(0, 4) : str;
}

async function fetchVehicleByKenteken(kenteken) {
  const k = normalizeKenteken(kenteken);
  if (!k) throw new Error("Geen kenteken");
  const [base, fuel, recalls] = await Promise.all([
    fetch(`https://opendata.rdw.nl/resource/m9d7-ebf2.json?kenteken=${k}`).then(r => r.json()).catch(() => []),
    fetch(`https://opendata.rdw.nl/resource/8ys7-d773.json?kenteken=${k}`).then(r => r.json()).catch(() => []),
    fetch(`https://opendata.rdw.nl/resource/j9yg-7rg9.json?kenteken=${k}&$limit=20`).then(r => r.json()).catch(() => []),
  ]);
  if (!base.length) throw new Error("Kenteken niet gevonden");
  const v = base[0];
  const f = fuel[0] || {};
  const num = (x) => (x == null || x === "") ? null : parseFloat(x);
  const kw = num(f.nettomaximumvermogen) ?? num(f.nominaal_continu_maximumvermogen);
  return {
    kenteken: k,
    merk: (v.merk || "").trim(),
    model: (v.handelsbenaming || "").trim(),
    voertuigsoort: (v.voertuigsoort || "").trim(),
    inrichting: (v.inrichting || "").trim(),
    kleur: (v.eerste_kleur || "").trim(),
    tweedeKleur: (v.tweede_kleur || "").trim(),
    bouwjaar: rdwYear(v.datum_eerste_toelating),
    eersteToelating: rdwDate(v.datum_eerste_toelating),
    eersteTenaamstellingNL: rdwDate(v.datum_eerste_tenaamstelling_in_nederland),
    apkVervaldatum: rdwDate(v.vervaldatum_apk),
    wamVerzekerd: (v.wam_verzekerd || "").toLowerCase() === "ja",
    aantalZitplaatsen: num(v.aantal_zitplaatsen),
    aantalDeuren: num(v.aantal_deuren),
    aantalCilinders: num(v.aantal_cilinders),
    cilinderinhoud: num(v.cilinderinhoud),
    massaLedig: num(v.massa_ledig_voertuig),
    massa: num(v.massa_rijklaar),
    maxTrekkenGeremd: num(v.maximum_trekken_massa_geremd),
    maxTrekkenOngeremd: num(v.maximum_massa_trekken_ongeremd),
    lengte: num(v.lengte),
    breedte: num(v.breedte),
    hoogte: num(v.hoogte_voertuig),
    aantalWielen: num(v.aantal_wielen),
    aantalAssen: num(v.aantal_assen),
    maxSpeedKmh: num(v.maximum_constructie_snelheid) ?? num(v.maximum_constructie_snelheid_brom),
    catalogusprijs: num(v.catalogusprijs),
    brutoBpm: num(v.bruto_bpm),
    co2: num(v.co2_uitstoot_gecombineerd) ?? num(f.uitstoot_co2_gecombineerd_wltp) ?? num(f.uitstoot_co2_gecombineerd) ?? null,
    co2Gewogen: num(v.co2_uitstoot_gewogen),
    // Brandstof
    brandstof: (f.brandstof_omschrijving || "").toLowerCase().trim(),
    emissieKlasse: (f.emissiecode_omschrijving || "").trim(),
    verbruikStad: num(f.brandstof_verbruik_stad),
    verbruikBuiten: num(f.brandstof_verbruik_buiten),
    verbruikGecombineerd: num(f.brandstof_verbruik_gecombineerd),
    geluidStationair: num(f.geluidsniveau_stationair),
    geluidRijdend: num(f.geluidsniveau_rijdend),
    vermogenKw: kw,
    vermogenPk: kw ? Math.round(kw * 1.35962) : null,
    elektrischKwhPer100km: num(f.elektrisch_verbruik_extern_opladen_wltp) ?? num(f.elektrisch_verbruik_combined_wltp),
    actieradiusKm: num(f.actie_radius_extern_opladen_wltp) ?? num(f.actie_radius_extern_opladen_stad_wltp),
    klasseHybride: (f.klasse_hybride_elektrisch_voertuig || "").trim(),
    // Terugroepacties
    terugroepacties: Array.isArray(recalls) ? recalls.length : 0,
  };
}

async function fetchVehiclePhoto(merk, model) {
  if (!merk || !model) return null;
  // RDW geeft model vaak met code-suffix ("TUCSON DM" of "GOLF VARIANT 1.4"),
  // pak alleen het eerste woord — dat is meestal de modelnaam.
  const modelHead = String(model).split(/\s+/)[0];
  // Generator=search vindt de juiste pagina ook bij rare casing of
  // modelnaam-variaties. Voorkomt dat we per ongeluk op de pagina
  // van het concern (bv. Hyundai HQ-gebouw) belanden.
  const queries = [
    `${merk} ${modelHead} car`,
    `${merk} ${modelHead}`,
  ];
  for (const q of queries) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=3&prop=pageimages&pithumbsize=600`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      const pages = Object.values(json.query?.pages || {});
      // Sorteer op zoekvolgorde (index) — eerste match heeft hoogste relevantie.
      pages.sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
      for (const p of pages) {
        if (p.thumbnail?.source) return p.thumbnail.source;
      }
    } catch {}
  }
  return null;
}

function ecoBand(co2) {
  if (co2 == null) return null;
  if (co2 < 50) return "A";
  if (co2 < 100) return "B";
  if (co2 < 140) return "C";
  if (co2 < 180) return "D";
  return "E";
}
function vehicleCo2PerKm(vehicle) {
  if (!vehicle) return null;
  if (vehicle.co2 != null && vehicle.co2 > 0) return vehicle.co2;
  if (vehicle.brandstof) {
    return FUEL_DEFAULT_CO2[vehicle.brandstof] ?? 120;
  }
  return null;
}

// ============ Confetti ============
function fireConfetti(durationMs = 2000) {
  const cv = $("confetti");
  cv.classList.remove("hidden");
  cv.width = window.innerWidth;
  cv.height = window.innerHeight;
  const ctx = cv.getContext("2d");
  const COLORS = ["#ffcc00", "#34c759", "#ff3b30", "#2997ff", "#ffffff"];
  const N = 160;
  const parts = Array.from({ length: N }, () => ({
    x: window.innerWidth / 2 + (Math.random() - 0.5) * 200,
    y: window.innerHeight / 2,
    vx: (Math.random() - 0.5) * 14,
    vy: (Math.random() - 0.9) * 14,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.4,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    size: 6 + Math.random() * 6,
  }));
  const start = performance.now();
  function frame(t) {
    const elapsed = t - start;
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.vy += 0.3;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
      ctx.restore();
    }
    if (elapsed < durationMs) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, cv.width, cv.height); cv.classList.add("hidden"); }
  }
  requestAnimationFrame(frame);
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

// Snelheidslimieten — query Overpass alleen rond de bekende stoplichten
// (daar doet GLOSA er iets mee) plus een paar route-samples voor lange
// stukken zonder lichten. Veel kleiner dan de hele route afdekken.
async function fetchMaxspeedAlongRoute(route) {
  const signals = route.signals || [];
  let pts = [];
  if (signals.length) {
    pts = signals.slice(0, 80).map(s => [s.lat, s.lon]);
  }
  // Vul aan met een paar route-samples zodat ook lange stukken zonder
  // lichten een limiet krijgen.
  const desiredSamples = Math.min(20, Math.max(4, Math.ceil(route.distance / 5000)));
  const stride = route.distance / desiredSamples;
  for (let d = stride / 2; d < route.distance && pts.length < 100; d += stride) {
    pts.push(pointAtDistance(route.coords, route.cumDist, d));
  }
  if (!pts.length) return [];
  const around = pts.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(",");
  const query = `[out:json][timeout:15];way["highway"]["maxspeed"](around:120,${around});out tags geom;`;
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

// Bouw [{fromM, toM, speed, roadClass}, …] door way-geometry op de
// route te projecteren. Een way overlapt waar zijn punten ≤25m van de
// route zitten. roadClass komt uit de OSM `highway`-tag en wordt door
// het AI-model gebruikt om realistische snelheden in te schatten.
function buildSpeedIntervals(ways, route) {
  const intervals = [];
  for (const w of ways) {
    const speed = parseMaxspeed(w.tags?.maxspeed);
    if (speed == null) continue;
    const cls = w.tags?.highway || "unclassified";
    const ds = [];
    for (const pt of w.geometry || []) {
      const proj = projectOnPolyline([pt.lat, pt.lon], route.coords, route.cumDist);
      if (proj.minD < 25) ds.push(proj.distAlong);
    }
    if (ds.length < 2) continue;
    intervals.push({ speed, roadClass: cls, fromM: Math.min(...ds), toM: Math.max(...ds) });
  }
  intervals.sort((a, b) => a.fromM - b.fromM);
  return intervals;
}

// ============ AI-inschatting ============
// Multi-factor model dat de naïeve gemiddelde snelheid (OSRM) verfijnt
// met wegtype, tijdstip (spitsuur), en daadwerkelijke voorspelde
// stoplicht-wachttijden. Doel: realistische ETA + transparant maken
// welke factoren meespelen.
const ROAD_SPEED_FACTORS = {
  motorway:        0.95, motorway_link: 0.85,
  trunk:           0.90, trunk_link:    0.82,
  primary:         0.85, primary_link:  0.78,
  secondary:       0.78, secondary_link:0.73,
  tertiary:        0.72, tertiary_link: 0.68,
  unclassified:    0.65,
  residential:     0.60,
  living_street:   0.40,
  service:         0.50,
  busway:          0.55,
  cycleway:        0.85,
  footway:         0.85,
};
const ROAD_CLASS_LABELS = {
  motorway: "snelweg", trunk: "autoweg", primary: "hoofdweg",
  secondary: "gebiedsweg", tertiary: "buurtontsluiting",
  residential: "wijkstraat", living_street: "woonerf",
  unclassified: "lokale weg", service: "ventweg",
};

function rushHourFactor(date = new Date()) {
  const day = date.getDay();
  const h = date.getHours() + date.getMinutes() / 60;
  if (day === 0 || day === 6) return 0.98;        // weekend
  if (h >= 7   && h < 9)   return 0.70;            // ochtendspits
  if (h >= 16  && h < 19)  return 0.65;            // avondspits
  if (h >= 9   && h < 16)  return 0.92;            // overdag
  if (h >= 19  && h < 22)  return 0.96;            // avond
  return 1.0;                                      // nacht
}
function rushHourLabel(date = new Date()) {
  const day = date.getDay();
  const h = date.getHours();
  if (day === 0 || day === 6) return "weekend";
  if (h >= 7   && h < 9)   return "ochtendspits";
  if (h >= 16  && h < 19)  return "avondspits";
  if (h >= 9   && h < 16)  return "overdag";
  if (h >= 19  && h < 22)  return "avond";
  return "nacht";
}

// Verwachte wachttijd bij een licht. Slim: gebruik de fase-voorspelling.
// Klassiek: aanname is 35% kans rood, gemiddelde wachttijd 12s als rood.
function expectedLightWait(signal, fromM, baseSpeedMS) {
  if (!signal.smart) return 0.35 * 12;
  const eta = (signal.distM - fromM) / baseSpeedMS;
  const ph = predictAtArrival(signal.offsetS, eta);
  if (ph.color === "red")   return Math.min(ph.secondsLeft, 25);
  if (ph.color === "amber") return 1;
  return 0;
}

// Realistische snelheid op een specifieke positie langs de route,
// rekening houdend met wegtype, wettelijke max en spitsuur. Gebruikt
// door de simulator EN als "huidige snelheid" voor GLOSA.
function aiSpeedAt(distM, route) {
  let speedKmh, factor;
  if (route.limitIntervals?.length) {
    let bestIv = null, bestSpan = Infinity;
    for (const iv of route.limitIntervals) {
      if (iv.fromM <= distM && distM <= iv.toM) {
        const span = iv.toM - iv.fromM;
        if (span < bestSpan) { bestSpan = span; bestIv = iv; }
      }
    }
    if (bestIv) {
      speedKmh = bestIv.speed;
      factor = ROAD_SPEED_FACTORS[bestIv.roadClass] ?? 0.70;
    }
  }
  const wf = weatherFactor(currentWeather);
  // Voertuig-cap: brommer/scootmobiel/etc. mogen niet 100 rijden
  const vehMax = state.vehicle?.maxSpeedKmh;
  let v;
  if (speedKmh == null) {
    const osrmKmh = (route.distance / route.duration) * 3.6;
    v = (osrmKmh / 3.6) * rushHourFactor() * wf;
  } else {
    v = (speedKmh / 3.6) * factor * rushHourFactor() * wf;
  }
  if (vehMax && vehMax > 0) {
    v = Math.min(v, (vehMax / 3.6) * 0.95);
  }
  return Math.max(2, v);
}

// Geïntegreerde reistijd over [fromM, toM] op realistische snelheid.
function aiTimeToReach(route, fromM, toM) {
  if (toM <= fromM) return 0;
  const dist = toM - fromM;
  const steps = Math.min(40, Math.max(3, Math.ceil(dist / 250)));
  const stride = dist / steps;
  let t = 0;
  for (let i = 0; i < steps; i++) {
    const d = fromM + (i + 0.5) * stride;
    t += stride / aiSpeedAt(d, route);
  }
  return t;
}

// Hoofdfunctie van het model. Levert {durationS, drivingS, lightWaitS,
// avgSpeedKmh, rushFactor, dominantClass}.
function aiEstimate(route, fromM = 0) {
  const remaining = Math.max(0, route.distance - fromM);
  const osrmSpeed = route.distance / route.duration; // m/s
  let drivingS;
  let dominantClass = null;

  if (route.limitIntervals?.length) {
    // Per-segment integratie obv wegtype-factor + maxspeed
    let covered = fromM;
    drivingS = 0;
    const classDist = {};
    for (const iv of route.limitIntervals) {
      if (iv.toM <= covered) continue;
      const segFrom = Math.max(covered, iv.fromM);
      const segTo = iv.toM;
      if (segTo <= segFrom) continue;
      // Gat ervoor: vul met OSRM-base
      if (segFrom > covered) {
        drivingS += (segFrom - covered) / osrmSpeed;
      }
      const d = segTo - segFrom;
      const factor = ROAD_SPEED_FACTORS[iv.roadClass] ?? 0.70;
      const v = (iv.speed / 3.6) * factor;
      drivingS += d / Math.max(v, 1);
      classDist[iv.roadClass] = (classDist[iv.roadClass] || 0) + d;
      covered = segTo;
    }
    if (covered < route.distance) {
      drivingS += (route.distance - covered) / osrmSpeed;
    }
    // Dominante wegtype
    let max = 0;
    for (const [k, v] of Object.entries(classDist)) {
      if (v > max) { max = v; dominantClass = k; }
    }
  } else {
    drivingS = remaining / osrmSpeed;
  }

  // Spitsuur factor (lager = langer)
  const rh = rushHourFactor();
  drivingS = drivingS / rh;

  // Stoplicht-wachttijd
  const ahead = (route.signals || []).filter(s => s.distM > fromM);
  let lightWaitS = 0;
  for (const s of ahead) {
    lightWaitS += expectedLightWait(s, fromM, osrmSpeed);
  }

  const durationS = drivingS + lightWaitS;
  const avgSpeedKmh = remaining > 0 ? (remaining / drivingS) * 3.6 : 0;

  return {
    durationS, drivingS, lightWaitS,
    avgSpeedKmh,
    rushFactor: rh,
    rushLabel: rushHourLabel(),
    dominantClass,
    hasLimits: !!route.limitIntervals?.length,
  };
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

// Fire-and-forget loader; vult r.limitIntervals zodra de data binnen is.
function backgroundLoadLimits(routes) {
  for (const r of routes) {
    fetchMaxspeedAlongRoute(r)
      .then((ways) => { r.limitIntervals = buildSpeedIntervals(ways, r); })
      .catch(() => { r.limitIntervals = []; });
  }
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
  const m = L.marker([s.lat, s.lon], { icon, interactive: true, keyboard: false });
  m._signalData = s;
  m.on("click", () => openLightPopup(m, s));
  if (addToMap) m.addTo(map);
  return m;
}

function openLightPopup(marker, s) {
  const tag = s.smart
    ? '<span class="lp-tag smart">slim — live status</span>'
    : '<span class="lp-tag classic">klassiek — geen timer</span>';
  let phaseRow = "";
  if (s.smart) {
    const ph = phaseAt(s.offsetS);
    phaseRow = `
      <div class="lp-row"><span>Huidige fase</span><b>${ph.phase}</b></div>
      <div class="lp-row"><span>Wisselt over</span><b>${Math.round(ph.secondsLeft)}s</b></div>`;
  }
  const learn = adaptiveStatsFor(s.id);
  const learnRow = learn
    ? `<div class="lp-row"><span>Geleerd (${learn.n}x)</span><b>${learn.avg.toFixed(0)}s gem.</b></div>`
    : "";
  const html = `
    <div class="light-popup">
      <div class="lp-title">Stoplicht ${s.id}</div>
      ${tag}
      <div class="lp-row"><span>Locatie</span><b>${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</b></div>
      ${phaseRow}
      ${learnRow}
      <div class="lp-row"><a href="https://www.openstreetmap.org/node/${s.id}" target="_blank" rel="noopener">Open in OSM</a></div>
    </div>`;
  marker.bindPopup(html, { closeButton: true, autoPanPadding: [40, 40] }).openPopup();
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
  const html = `
    <div class="driver-marker">
      <svg viewBox="0 0 24 24"><path d="M12 2 L19 20 L12 16 L5 20 Z"/></svg>
    </div>`;
  const icon = L.divIcon({
    className: "",
    html,
    iconSize: [28, 28], iconAnchor: [14, 14],
  });
  return L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(map);
}
function setDriverHeading(deg) {
  const el = state.driver?.getElement()?.querySelector(".driver-marker svg");
  if (el) el.style.transform = `rotate(${deg}deg)`;
}
// Compass-bearing van punt a → b in graden (0=N, 90=O).
function bearingDeg(a, b) {
  const φ1 = a[0] * Math.PI / 180, φ2 = b[0] * Math.PI / 180;
  const Δλ = (b[1] - a[1]) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
function setSpeedometer(kmh) {
  const el = $("speedo");
  if (!el) return;
  if (kmh == null) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  $("speedo-num").textContent = String(Math.round(kmh));
}

// ============ Groene-golf ============
// Voor opeenvolgende slimme lichten: zijn ze allemaal groen bij aankomst?
// Als ja, teken een groene streep over dat route-segment.
function detectGreenwaveSegments(route, fromM) {
  if (!route.signals) return [];
  const segments = [];
  let runStart = -1, runFrom = 0;
  for (let i = 0; i < route.signals.length; i++) {
    const s = route.signals[i];
    if (s.distM <= fromM) continue;
    if (!s.smart) {
      if (runStart >= 0 && i - runStart >= 2) {
        segments.push({ fromM: runFrom, toM: route.signals[i - 1].distM });
      }
      runStart = -1;
      continue;
    }
    const eta = aiTimeToReach(route, fromM, s.distM);
    const arr = predictAtArrival(s.offsetS, eta);
    if (arr.color === "green") {
      if (runStart < 0) { runStart = i; runFrom = s.distM; }
    } else {
      if (runStart >= 0 && i - runStart >= 2) {
        segments.push({ fromM: runFrom, toM: route.signals[i - 1].distM });
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && route.signals.length - runStart >= 2) {
    segments.push({ fromM: runFrom, toM: route.signals[route.signals.length - 1].distM });
  }
  return segments;
}
function renderGreenwave(route) {
  // Verwijder vorige
  if (route._gwLayers) {
    for (const l of route._gwLayers) map.removeLayer(l);
  }
  route._gwLayers = [];
  if (route !== state.routes[state.activeRouteIdx]) return;
  const segments = detectGreenwaveSegments(route, state.drivePos);
  for (const seg of segments) {
    const pts = [];
    // Sample punten op de route binnen het segment
    const nSamples = 20;
    for (let i = 0; i <= nSamples; i++) {
      const d = seg.fromM + ((seg.toM - seg.fromM) * i) / nSamples;
      pts.push(pointAtDistance(route.coords, route.cumDist, d));
    }
    const line = L.polyline(pts, {
      color: "#34c759", weight: 8, opacity: 0.55,
      lineCap: "round", lineJoin: "round",
      className: "greenwave-glow",
    });
    line.addTo(map);
    route._gwLayers.push(line);
  }
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
function setSidebarCompact(compact) {
  document.querySelector(".sidebar").classList.toggle("compact", compact);
}
function updateCompactSummary() {
  const r = state.routes[state.activeRouteIdx];
  if (!r) return;
  const ai = aiEstimate(r, state.drivePos);
  const remain = Math.max(0, r.distance - state.drivePos);
  const cs1 = $("cs-time"); if (cs1) cs1.textContent = fmtClock(new Date(Date.now() + ai.durationS * 1000));
  const cs2 = $("cs-dist"); if (cs2) cs2.textContent = fmtDistance(remain);
  const cs3 = $("cs-lights"); if (cs3) cs3.textContent = `${r.signals.length} lichten`;
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
  const remain = Math.max(0, r.distance - state.drivePos);
  const ai = aiEstimate(r, state.drivePos);
  $("eta-distance").textContent = fmtDistance(remain);
  $("eta-duration").textContent = fmtDuration(ai.durationS);
  $("eta-time").textContent = fmtClock(new Date(Date.now() + ai.durationS * 1000));
  $("eta-signals").textContent = r.signals.length;
  $("eta-smart").textContent = r.signals.filter(s => s.smart).length;
  // AI factoren
  const aiBadge = $("ai-badge");
  if (aiBadge) aiBadge.classList.toggle("active", ai.hasLimits);
  const aiRush = $("ai-rush");
  if (aiRush) aiRush.textContent = `${ai.rushLabel} (${Math.round(ai.rushFactor * 100)}%)`;
  const aiSpeed = $("ai-speed");
  if (aiSpeed) aiSpeed.textContent = ai.avgSpeedKmh > 0 ? `${Math.round(ai.avgSpeedKmh)} km/u` : "–";
  const aiLights = $("ai-lights");
  if (aiLights) aiLights.textContent = ai.lightWaitS > 0 ? `+${fmtDuration(ai.lightWaitS)}` : "geen";
  const aiRoad = $("ai-road");
  if (aiRoad) aiRoad.textContent = ai.dominantClass ? (ROAD_CLASS_LABELS[ai.dominantClass] ?? ai.dominantClass) : "onbekend";
  const aiSrc = $("ai-source");
  if (aiSrc) aiSrc.textContent = ai.hasLimits ? "OSM-wegtype + tijd + lichten" : "OSRM-basis + tijd + lichten";
}
function renderUpcoming(route, drivePosM) {
  const list = $("upcoming-list");
  list.innerHTML = "";
  const upcoming = route.signals.filter(s => s.distM > drivePosM + 1).slice(0, 8);
  for (const s of upcoming) {
    const li = document.createElement("li");
    const remain = s.distM - drivePosM;
    if (s.smart) {
      const eta = aiTimeToReach(route, drivePosM, s.distM);
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
    const bbox = bboxOfCoords(allCoords);
    let rawSignals = cacheGet("signals", bbox);
    if (!rawSignals) {
      rawSignals = await fetchSignalsBbox(bbox);
      cacheSet("signals", bbox, rawSignals);
    }

    for (const r of routes) {
      r.signals = filterSignalsToRoute(rawSignals, r.coords, r.cumDist);
    }

    // Weer ophalen vanaf bestemming (achtergrond)
    refreshWeather(points[points.length - 1].lat, points[points.length - 1].lon);

    // Snelheidslimieten halen we ASYNC op zodat de UI niet wacht.
    // Tot ze binnen zijn gebruiken we een fallback (50 / 25 / 5 km/u).
    routes.forEach(r => { r.limitIntervals = []; });
    backgroundLoadLimits(routes);

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
    setSidebarCompact(true);
    updateCompactSummary();
  } catch (e) {
    setLoading(null);
    showToast(e.message ?? String(e), "error");
    console.error(e);
  }
}

function tick() {
  const r = state.routes[state.activeRouteIdx];
  if (!r) return;

  if (state.driving) {
    const now = performance.now();
    const dt = tick._lastTickMs ? Math.min(1, (now - tick._lastTickMs) / 1000) : 0;
    tick._lastTickMs = now;
    const v = aiSpeedAt(state.drivePos, r);
    const prevPos = state.drivePos;
    state.drivePos = Math.min(r.distance, state.drivePos + v * dt);

    // Adaptief leren: detecteer als we een licht passeerden tijdens rood/geel
    if (r.signals) {
      for (const s of r.signals) {
        if (s.distM > prevPos && s.distM <= state.drivePos && s.smart) {
          const ph = phaseAt(s.offsetS);
          // Bij naderen werd het advies al gegeven; nu loggen we de
          // werkelijke fase op het moment van passage als "ervaring".
          const wait = ph.color === "red" ? ph.secondsLeft : ph.color === "amber" ? 1 : 0;
          recordObservedWait(s.id, wait);
        }
      }
    }

    if (state.drivePos >= r.distance) {
      state.driving = false;
      tick._lastTickMs = null;
      $("drive-toggle").textContent = "Start rit";
      $("drive-stop").classList.add("hidden");
      releaseWakeLock();
      finishDrive();
    }
    const p = pointAtDistance(r.coords, r.cumDist, state.drivePos);
    if (state.driver) state.driver.setLatLng(p);
    if (state.driving && !state.followGps) map.panTo(p, { animate: false });
    // Heading: kijk 25m vooruit
    const lookAhead = pointAtDistance(r.coords, r.cumDist, Math.min(r.distance, state.drivePos + 25));
    setDriverHeading(bearingDeg(p, lookAhead));
    setSpeedometer(v * 3.6);
  } else {
    tick._lastTickMs = null;
    setSpeedometer(null);
  }
  // Realistische "huidige snelheid" voor GLOSA en upcoming-ETAs
  const speed = state.driving ? aiSpeedAt(state.drivePos, r) : avgSpeedMS();

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

  // Volgend stoplicht — gebruik geïntegreerde AI-tijd voor accurate ETA
  const next = r.signals.find(s => s.distM > state.drivePos + 1);
  if (next) {
    const remainingM = next.distM - state.drivePos;
    if (next.smart) {
      const eta = aiTimeToReach(r, state.drivePos, next.distM);
      const nowPh = phaseAt(next.offsetS);
      const arrPh = predictAtArrival(next.offsetS, eta);
      setNextLightUI({
        smart: true, color: nowPh.color, phase: nowPh.phase,
        secondsLeft: nowPh.secondsLeft, remainingM, arrival: arrPh.phase,
      });
      if (state.driving) {
        const limKmh = lowestLimitBetween(intervals, state.drivePos, next.distM, fallbackKmh);
        const tip = computeGlosa(remainingM, next, speed, limKmh / 3.6);
        const currentKmh = Math.round(speed * 3.6);
        if (tip && tip.feasible) {
          const targetKmh = Math.round(tip.v * 3.6);
          const diff = targetKmh - currentKmh;
          // Coast-to-light: als doelsnelheid lager is en huidige is al boven
          // het doel, suggereer rollend uitlopen
          if (diff < -5 && nowPh.color === "red") {
            setGlosa(`💨 Gas los — rol uit naar ${targetKmh} km/u, dan groen`, "ok");
          } else if (Math.abs(diff) <= 2) {
            setGlosa(`Hou ~${currentKmh} km/u aan — groen bij aankomst`, "ok");
          } else if (diff > 0) {
            setGlosa(`Versnel naar ${targetKmh} km/u (nu ${currentKmh}, max ${limKmh})`, "ok");
          } else {
            setGlosa(`Houd in tot ${targetKmh} km/u (nu ${currentKmh}) voor groen`, "ok");
          }
        } else {
          if (arrPh.color === "red") {
            setGlosa(`Wordt rood — ~${Math.round(arrPh.secondsLeft)}s wachten (nu ${currentKmh} km/u)`, "warn");
          } else {
            setGlosa(`Niet groen haalbaar binnen ${limKmh} km/u`, "warn");
          }
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
    renderUpcoming(r, state.drivePos);
    renderEta();
    updateCompactSummary();
  }
  // Greenwave update minder vaak
  const tg = Math.floor(performance.now() / 1500);
  if (tg !== tick._lastGw) {
    tick._lastGw = tg;
    renderGreenwave(r);
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
  const r = state.routes[state.activeRouteIdx];
  if (!r) return;
  const dur = (Date.now() / 1000) - (state.driveStats?.startedAt || Date.now() / 1000);
  const passed = r.signals.filter(s => s.distM <= state.drivePos);
  let red = 0, green = 0, amber = 0, classic = 0;
  for (const s of passed) {
    if (!s.smart) { classic++; continue; }
    const eta = s.distM / Math.max(1, avgSpeedMS());
    const ph = predictAtArrival(s.offsetS, -dur + eta);
    if (ph.color === "red") red++;
    else if (ph.color === "green") green++;
    else if (ph.color === "amber") amber++;
  }
  const co2PerKm = state.profile === "driving"
    ? (vehicleCo2PerKm(state.vehicle) ?? EMISSIONS.driving.co2_g_per_km)
    : (EMISSIONS[state.profile]?.co2_g_per_km || 0);
  const co2g = co2PerKm * (r.distance / 1000);
  $("stat-distance").textContent = fmtDistance(r.distance);
  $("stat-duration").textContent = fmtDuration(dur);
  $("stat-lights").textContent = passed.length;
  $("stat-red").textContent = red;
  $("stat-green").textContent = green;
  $("stat-co2").textContent = fmtCo2(co2g);
  $("stats-modal").classList.remove("hidden");
  // Confetti als de meerderheid groen was
  const totalSmart = red + green + amber;
  if (totalSmart > 0 && green / totalSmart > 0.7) fireConfetti(2200);
}

// Stop een rit volledig: simulatie uit, kaart leeg, terug naar zoek-state.
function stopRit() {
  state.driving = false;
  tick._lastTickMs = null;
  releaseWakeLock();
  $("drive-toggle").textContent = "Start rit";
  $("drive-stop").classList.add("hidden");
  setSpeedometer(null);
  $("speed-sign").classList.add("hidden");
  setGlosa(null);
  clearAll();
  $("sheet").classList.add("hidden");
  $("share-btn").disabled = true;
  setSidebarCompact(false);
  // URL opschonen
  const url = new URL(window.location.href);
  ["from", "to", "via", "p"].forEach(p => url.searchParams.delete(p));
  window.history.replaceState(null, "", url.toString());
  // Inputs leeg
  getWaypointInputs().forEach(i => i.value = "");
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

$("expand-toggle").addEventListener("click", () => {
  const sb = document.querySelector(".sidebar");
  sb.classList.toggle("compact");
});
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
    tick._lastTickMs = null;
    $("drive-toggle").textContent = "Hervat";
    releaseWakeLock();
  } else {
    state.driving = true;
    tick._lastTickMs = null;
    if (!state.driveStats?.startedAt) state.driveStats = { startedAt: Date.now() / 1000 };
    $("drive-toggle").textContent = "Pauze";
    $("drive-stop").classList.remove("hidden");
    requestWakeLock();
  }
});
$("drive-stop").addEventListener("click", stopRit);
$("theme-toggle").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "dark";
  const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
  applyTheme(next);
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
map.on("zoomend moveend", refreshCityLightsDebounced);

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) hideSuggestions();
  if (!e.target.closest(".map-menu")) $("map-menu").classList.add("hidden");
});

// Long-press / right-click op kaart → menu om vertrek/tussen/bestemming te zetten
map.on("contextmenu", (e) => {
  const menu = $("map-menu");
  menu.style.left = `${e.containerPoint.x + 6}px`;
  menu.style.top = `${e.containerPoint.y + 6}px`;
  menu.classList.remove("hidden");
  menu._latlng = e.latlng;
});
$("map-menu").addEventListener("click", async (e) => {
  const role = e.target.dataset.role;
  if (!role) return;
  const ll = $("map-menu")._latlng;
  $("map-menu").classList.add("hidden");
  if (!ll) return;
  try {
    const url = `${NOMINATIM_REV}?format=json&lat=${ll.lat}&lon=${ll.lng}&zoom=16`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const json = await res.json();
    const label = json.display_name?.split(",").slice(0, 3).join(",").trim() || `${ll.lat.toFixed(4)},${ll.lng.toFixed(4)}`;
    const inputs = getWaypointInputs();
    if (role === "from") inputs[0].value = label;
    else if (role === "to") inputs[inputs.length - 1].value = label;
    else if (role === "via") {
      addStop();
      const all = getWaypointInputs();
      all[all.length - 2].value = label;
    }
    setSidebarCompact(false);
  } catch {}
});

// Toetsenbord-shortcuts
document.addEventListener("keydown", (e) => {
  // Niet hijacken in zoekvelden
  if (e.target.matches("input, textarea")) return;
  if (e.key === " ") { e.preventDefault(); $("drive-toggle").click(); }
  else if (e.key === "s" || e.key === "S") { e.preventDefault(); if (state.routes.length) stopRit(); }
  else if (e.key === "r" || e.key === "R") { e.preventDefault(); $("drive-stop")?.click(); }
  else if (e.key === "l" || e.key === "L") { $("follow-gps").click(); }
  else if (e.key === "m" || e.key === "M") { $("theme-toggle").click(); }
  else if (e.key === "v" || e.key === "V") { $("voice-toggle").click(); }
  else if (e.key === "/") { e.preventDefault(); getWaypointInputs()[0]?.focus(); }
});

// Error-overlay
function showError(text) {
  $("error-text").textContent = text;
  $("error-overlay").classList.remove("hidden");
}
window.addEventListener("error", (e) => {
  showError(`${e.message}\n\n${e.error?.stack || ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
  showError(`Promise rejected: ${e.reason?.message || e.reason}\n\n${e.reason?.stack || ""}`);
});
$("error-close")?.addEventListener("click", () => $("error-overlay").classList.add("hidden"));
$("error-copy")?.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("error-text").textContent); showToast("Gekopieerd."); } catch {}
});
$("stats-close").addEventListener("click", () => {
  $("stats-modal").classList.add("hidden");
});

// ============ Voertuig UI ============
function renderVehicleButton() {
  const v = state.vehicle;
  const lbl = $("vehicle-label");
  if (!lbl) return;
  if (v && v.merk) {
    lbl.textContent = `${v.merk} ${v.model || ""} ${v.bouwjaar ? `· ${v.bouwjaar}` : ""}`.trim();
  } else {
    lbl.textContent = "Mijn auto toevoegen";
  }
}
function openVehicleModal() {
  $("vehicle-modal").classList.remove("hidden");
  if (state.vehicle) {
    $("kenteken-input").value = formatKenteken(state.vehicle.kenteken);
    showVehicleCard(state.vehicle);
    refreshVehicleSilently(state.vehicle.kenteken);
  } else {
    $("kenteken-input").value = "";
    $("vehicle-card").classList.add("hidden");
    $("vehicle-save").disabled = true;
  }
  setTimeout(() => $("kenteken-input").focus(), 50);
}

async function refreshVehicleSilently(kenteken) {
  try {
    const fresh = await fetchVehicleByKenteken(kenteken);
    if ($("vehicle-modal").classList.contains("hidden")) return;
    if (normalizeKenteken($("kenteken-input").value) !== normalizeKenteken(kenteken)) return;
    saveVehicle(fresh);
    state.vehicle = fresh;
    showVehicleCard(fresh);
  } catch {}
}
function closeVehicleModal() {
  $("vehicle-modal").classList.add("hidden");
  pendingVehicle = null;
}
let pendingVehicle = null;

const COLOR_MAP = {
  rood: "#c0392b", blauw: "#2980b9", zwart: "#1a1a1a", wit: "#ecf0f1",
  grijs: "#7f8c8d", groen: "#27ae60", geel: "#f1c40f", bruin: "#795548",
  beige: "#d4b896", zilvergrijs: "#bdc3c7", zilver: "#bdc3c7",
  oranje: "#e67e22", paars: "#8e44ad", goud: "#daa520", roze: "#e91e63",
  donkerblauw: "#1a4480", lichtblauw: "#5dade2",
  donkergrijs: "#444", lichtgrijs: "#bbb",
  donkergroen: "#155724",
};
function colorForKleur(kleur) {
  if (!kleur) return null;
  const k = kleur.toLowerCase().replace(/\s+/g, "");
  return COLOR_MAP[k] || null;
}
function fmtPrice(eur) {
  if (eur == null) return "–";
  return `€ ${eur.toLocaleString("nl-NL", { maximumFractionDigits: 0 })}`;
}

function showVehicleCard(v) {
  const card = $("vehicle-card");
  card.classList.remove("hidden");
  const set = (id, val) => { const el = $(id); if (el) el.textContent = val == null || val === "" ? "–" : val; };

  set("v-merk", v.merk || "–");
  set("v-model", v.model || "");
  set("v-bouwjaar", v.bouwjaar);
  set("v-brandstof", v.brandstof);
  set("v-kleur", (v.kleur || "").toLowerCase());

  // Specs
  set("v-vermogen", v.vermogenKw ? `${Math.round(v.vermogenKw)} kW (${v.vermogenPk} pk)` : null);
  set("v-cilinder", v.cilinderinhoud ? `${Math.round(v.cilinderinhoud)} cm³` : null);
  set("v-cilinders", v.aantalCilinders);
  set("v-inrichting", (v.inrichting || "").toLowerCase());
  set("v-massa", v.massa ? `${Math.round(v.massa)} kg` : null);
  set("v-maxspeed", v.maxSpeedKmh ? `${Math.round(v.maxSpeedKmh)} km/u` : null);
  set("v-lengte", v.lengte ? `${(v.lengte / 100).toFixed(2)} m` : null);
  set("v-zitplaatsen", v.aantalZitplaatsen);

  // Verbruik
  const co2 = vehicleCo2PerKm(v);
  set("v-co2", co2 != null ? `${Math.round(co2)} g/km` : null);
  set("v-verb-gec", v.verbruikGecombineerd ? `${v.verbruikGecombineerd.toFixed(1)} l/100km` :
                    v.elektrischKwhPer100km ? `${v.elektrischKwhPer100km.toFixed(1)} kWh/100km` : null);
  set("v-verb-stad", v.verbruikStad ? `${v.verbruikStad.toFixed(1)} l/100km` : null);
  set("v-verb-buiten", v.verbruikBuiten ? `${v.verbruikBuiten.toFixed(1)} l/100km` : null);
  set("v-range", v.actieradiusKm ? `${Math.round(v.actieradiusKm)} km` : null);
  set("v-emissie", v.emissieKlasse || null);

  // Registratie
  set("v-apk", v.apkVervaldatum);
  set("v-wam", v.wamVerzekerd ? "Ja" : "Nee");
  set("v-eerste-toel", v.eersteToelating);
  set("v-nl-sinds", v.eersteTenaamstellingNL);
  set("v-prijs", fmtPrice(v.catalogusprijs));
  set("v-bpm", fmtPrice(v.brutoBpm));

  // Eco-band
  const band = ecoBand(co2);
  const eco = $("v-eco");
  if (band) {
    eco.classList.remove("hidden");
    const badge = eco.querySelector(".eco-badge");
    badge.className = `eco-badge ${band.toLowerCase()}`;
    badge.textContent = band;
  } else {
    eco.classList.add("hidden");
  }

  // APK-tag
  const apkTag = $("v-apk-tag");
  const apkStatus = $("v-apk-status");
  if (v.apkVervaldatum) {
    apkTag.classList.remove("hidden", "warn", "ok");
    // parseer vervaldatum
    const [d, m, y] = v.apkVervaldatum.split("-");
    const dt = new Date(`${y}-${m}-${d}`);
    const now = new Date();
    if (dt < now) {
      apkTag.classList.add("warn");
      apkStatus.textContent = "VERLOPEN";
    } else {
      apkTag.classList.add("ok");
      apkStatus.textContent = `tot ${v.apkVervaldatum}`;
    }
  } else {
    apkTag.classList.add("hidden");
  }

  // Recalls
  const rec = $("v-recalls");
  if (v.terugroepacties > 0) {
    rec.classList.remove("hidden");
    $("v-recalls-n").textContent = String(v.terugroepacties);
  } else {
    rec.classList.add("hidden");
  }

  // Foto-fallback achtergrondkleur op basis van eerste_kleur
  const photoWrap = $("vehicle-photo-img").parentElement;
  const tint = colorForKleur(v.kleur);
  photoWrap.style.setProperty("--vehicle-color", tint || "");
  // Foto laden
  const photo = $("vehicle-photo-img");
  photoWrap.classList.remove("has-img");
  photo.src = "";
  if (v.photoUrl) {
    photo.src = v.photoUrl;
    photoWrap.classList.add("has-img");
  } else if (v.merk) {
    fetchVehiclePhoto(v.merk, v.model).then(url => {
      if (!url) return;
      // Race-check: kaart kan inmiddels een ander voertuig tonen.
      if (normalizeKenteken($("kenteken-input").value) !== normalizeKenteken(v.kenteken)) return;
      photo.src = url;
      photoWrap.classList.add("has-img");
      if (pendingVehicle && pendingVehicle.kenteken === v.kenteken) pendingVehicle.photoUrl = url;
      if (state.vehicle && state.vehicle.kenteken === v.kenteken) {
        state.vehicle.photoUrl = url;
        saveVehicle(state.vehicle);
      }
    });
  }
  $("vehicle-save").disabled = false;
}

async function lookupVehicle() {
  const k = $("kenteken-input").value;
  if (!normalizeKenteken(k)) { showToast("Vul een kenteken in.", "error"); return; }
  $("vehicle-lookup").disabled = true;
  $("vehicle-lookup").textContent = "Bezig…";
  try {
    const v = await fetchVehicleByKenteken(k);
    pendingVehicle = v;
    showVehicleCard(v);
  } catch (e) {
    showToast(e.message || "Niet gevonden", "error");
    $("vehicle-card").classList.add("hidden");
    $("vehicle-save").disabled = true;
  } finally {
    $("vehicle-lookup").disabled = false;
    $("vehicle-lookup").textContent = "Zoek";
  }
}

$("vehicle-btn")?.addEventListener("click", openVehicleModal);
$("vehicle-close")?.addEventListener("click", closeVehicleModal);
$("vehicle-lookup")?.addEventListener("click", lookupVehicle);
$("kenteken-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); lookupVehicle(); }
});
$("kenteken-input")?.addEventListener("input", (e) => {
  const cur = e.target.selectionStart;
  const before = e.target.value;
  const formatted = formatKenteken(before);
  e.target.value = formatted;
  // Behoud cursor
  e.target.setSelectionRange(formatted.length, formatted.length);
});
$("vehicle-save")?.addEventListener("click", () => {
  const v = pendingVehicle || state.vehicle;
  if (!v) return;
  saveVehicle(v);
  state.vehicle = v;
  renderVehicleButton();
  closeVehicleModal();
  showToast(`${v.merk} ${v.model || ""} opgeslagen.`);
});
$("vehicle-clear")?.addEventListener("click", () => {
  clearVehicle();
  state.vehicle = null;
  pendingVehicle = null;
  renderVehicleButton();
  $("vehicle-card").classList.add("hidden");
  $("kenteken-input").value = "";
  $("vehicle-save").disabled = true;
  showToast("Voertuig verwijderd.");
});

// ============ Boot ============
setMode("Demo", "demo");
renderHistory();
renderVehicleButton();
startTickLoop();
setTimeout(tryAutoplanFromUrl, 100);

// Service worker (minimal, voor PWA-installeerbaar)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
