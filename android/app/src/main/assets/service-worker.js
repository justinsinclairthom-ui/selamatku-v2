/* ============================================================
   SelamatKu Service Worker
   Cache strategy:
   - Static assets  → cache-first (app shell, Leaflet CDN, icons)
   - API responses  → network-first with fallback to cached data
   ============================================================ */

const STATIC_CACHE  = 'selamatku-v2-static';
const DATA_CACHE    = 'selamatku-v2-data';
const RUNTIME_CACHE = 'selamatku-v2-runtime';

// URLs to pre-cache on install
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  // Leaflet from CDN — cache so map works offline
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
];

// ── INSTALL ─────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  const validCaches = [STATIC_CACHE, DATA_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !validCaches.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ───────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // ── Strategy 1: Static assets → cache-first ──
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // ── Strategy 2: API calls → network-first ──
  if (isApiRequest(url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // ── Strategy 3: Map tiles → runtime cache (cache-first, no expiry for now) ──
  if (isMapTile(url)) {
    event.respondWith(cacheFirstRuntime(event.request));
    return;
  }
});

// ── HELPERS ─────────────────────────────────────────────────────

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin ||
    url.hostname === 'cdn.jsdelivr.net'
  ) && (
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.json') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.ico')
  );
}

function isApiRequest(url) {
  return (
    url.hostname.includes('bmkg.go.id') ||
    url.hostname.includes('usgs.gov') ||
    url.hostname.includes('overpass-api.de') ||
    url.hostname.includes('project-osrm.org')
  );
}

function isMapTile(url) {
  return url.hostname.includes('cartocdn.com') ||
         url.hostname.includes('openstreetmap.org') ||
         url.hostname.includes('tile');
}

// Cache-first: check cache, fall back to network, update cache
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const resp = await fetch(request);
  if (resp.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, resp.clone());
  }
  return resp;
}

// Network-first: try network, fall back to cache
async function networkFirst(request) {
  try {
    const resp = await fetch(request);
    if (resp.ok) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) {
      // Add header indicating this is stale data
      const headers = new Headers(cached.headers);
      headers.set('x-selamatku-stale', 'true');
      return new Response(cached.body, { status: 200, headers });
    }
    // No cache available — return opaque error
    return new Response(JSON.stringify({ error: 'offline', message: 'Tidak ada koneksi internet dan tidak ada data cached.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Runtime cache for map tiles — cache-first with size limit
async function cacheFirstRuntime(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const resp = await fetch(request);
    if (resp.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, resp.clone());
      // Limit tile cache to ~50MB (roughly 5000 tiles)
      trimCache(RUNTIME_CACHE, 5000);
    }
    return resp;
  } catch (e) {
    return new Response(null, { status: 503 });
  }
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    await cache.delete(keys[0]);
    trimCache(cacheName, maxEntries);
  }
}

// ── MESSAGE HANDLER (for cache clearing from main thread) ───────
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data === 'CLEAR_DATA_CACHE') {
    caches.delete(DATA_CACHE);
  }
});
