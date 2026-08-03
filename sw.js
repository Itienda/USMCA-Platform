/* PRODENSA · USMCA Intelligence — service worker (v3.2)
   Objetivo: que el directivo pueda ABRIR la plataforma sin señal y leer lo
   último que vio. NO cachea datos de Supabase: los datos frescos siempre
   exigen red, y el chip de salud de la interfaz declara la antigüedad.
   Estrategia: network-first para el cascarón (así un deploy nuevo se ve de
   inmediato), cache-first solo para el ícono y el manifiesto. */
const CACHE = "usmca-v3.2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./status.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // Nunca interceptar APIs ni terceros: los datos deben ser frescos o fallar visiblemente
  if (url.origin !== location.origin) return;
  if (url.pathname.includes("/rest/v1/") || url.pathname.includes("/functions/v1/")) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});
