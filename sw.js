// Service worker met cache-first strategie voor:
//  - app-shell (HTML/CSS/JS/manifest)
//  - OSM-tegels (tile.openstreetmap.org)
//  - Overpass-respons (stoplichten + maxspeed) — netwerk-eerst, fallback cache
//
// Versie-bump invalideert oude caches. Bump bij elke release waarbij de
// app-shell verandert om "stale js"-bugs te voorkomen.
const VERSION = "v3";
const SHELL_CACHE = `verkeerslicht-shell-${VERSION}`;
const TILE_CACHE  = `verkeerslicht-tiles-${VERSION}`;
const API_CACHE   = `verkeerslicht-api-${VERSION}`;

const SHELL_URLS = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_URLS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, TILE_CACHE, API_CACHE]);
    const names = await caches.keys();
    await Promise.all(names.filter(n => !keep.has(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isTileRequest(url) {
  return /tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(url);
}
function isOverpass(url) {
  return /overpass-api\.de\/api\/interpreter/.test(url);
}
function isShell(url) {
  const u = new URL(url);
  if (u.origin !== self.location.origin) return false;
  return SHELL_URLS.some(s => u.pathname.endsWith(s.replace(/^\.\//, "/")));
}

async function staleWhileRevalidate(cacheName, request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || fetchPromise || new Response("", { status: 504 });
}

async function networkFirstWithFallback(cacheName, request) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    return cached || new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = req.url;

  if (isTileRequest(url)) {
    e.respondWith(staleWhileRevalidate(TILE_CACHE, req));
    return;
  }
  if (isOverpass(url) || (req.method === "POST" && /overpass-api\.de/.test(url))) {
    // Overpass POST kunnen we niet cachen via de standaard API; alleen GET.
    return;
  }
  if (isShell(url)) {
    e.respondWith(staleWhileRevalidate(SHELL_CACHE, req));
    return;
  }
  // Andere requests: netwerk; stilletjes negeren als offline.
});

// Cache-grootte in toom houden voor tegels (browsers limiteren ook al,
// maar we kappen 500 oudste entries als we erover gaan).
async function trimCache(name, maxEntries) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const drop = keys.length - maxEntries;
  for (let i = 0; i < drop; i++) await cache.delete(keys[i]);
}
self.addEventListener("message", (e) => {
  if (e.data?.type === "trim-tiles") trimCache(TILE_CACHE, 500);
});
