/**
 * service-worker.js — PWA Porra Mundial 2026.
 *
 * Estrategia:
 *  - App shell (HTML/CSS/JS/assets): cache-first con precarga.
 *  - data/*.json: stale-while-revalidate — responde al instante con la caché
 *    y actualiza en segundo plano (los marcadores en vivo los refresca live.js).
 *  - Fuentes de Google: cache-first en tiempo de ejecución.
 *
 * Sube CACHE_VERSION al publicar cambios para invalidar cachés antiguas.
 */

const CACHE_VERSION = "porra2026-v14";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./js/engine.js",
  "./js/live.js",
  "./js/livesource.js",
  "./manifest.json",
  "./assets/logo.svg",
  "./assets/icon.svg",
  "https://unpkg.com/lucide@0.462.0/dist/umd/lucide.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Datos: stale-while-revalidate. Responde de inmediato con la copia en caché
  // (carga instantánea al entrar) y refresca en segundo plano para la próxima vez.
  if (url.pathname.includes("/data/") && url.pathname.endsWith(".json")) {
    e.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(e.request);
        const network = fetch(e.request)
          .then((res) => {
            if (res && res.ok) cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => cached);
        // Si hay caché, la servimos ya; si no, esperamos a la red.
        return cached || network;
      })
    );
    return;
  }

  // Resto (shell + fuentes): caché primero.
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok && (url.origin === location.origin || url.hostname.includes("gstatic") || url.hostname.includes("googleapis") || url.hostname === "unpkg.com")) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
