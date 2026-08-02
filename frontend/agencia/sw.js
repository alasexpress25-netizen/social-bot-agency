// Service Worker — LaVMK Agencia (panel de automatización)
//
// Objetivo: cachear el "app shell" (el propio index.html, el manifest y los
// íconos) para que el panel abra rápido y ande aunque el celular tenga mala
// señal, SIN cachear nunca datos de Supabase (auth, clientes, leads, etc.) --
// esos siempre tienen que ir a la red, porque son datos en vivo y además
// llevan la sesión del usuario logueado.
//
// Estrategia:
//  - Peticiones a otros dominios (Supabase API/auth/storage, Edge
//    Functions, CDNs, buckets de medios como R2, etc.) -> nunca se
//    tocan, van directo a la red (fetch pass-through, ni siquiera
//    entran al cache). Se decide por origin, no por una lista de
//    dominios a mano.
//  - Navegación (abrir la app / F5) -> "network first, cache fallback": si
//    hay internet, siempre trae la versión más nueva del HTML; si no hay
//    señal, muestra la última copia guardada en vez de un error blanco.
//  - Assets estáticos propios (CSS/JS/ícono/manifest) -> "cache first,
//    actualiza en segundo plano" (stale-while-revalidate), para que carguen
//    instantáneo y a la vez se mantengan al día solos.

const CACHE_NAME = 'lavmk-agencia-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

function isCrossOrigin(url) {
  // Cualquier pedido que NO sea del propio dominio del panel pasa de largo,
  // sin cache ni logica del SW: Supabase (datos/auth en vivo), Edge
  // Functions, CDNs externos (supabase-js via jsdelivr), y CUALQUIER otro
  // host de medios (ej: bucket R2 de las imagenes de posts/leads/reseñas).
  // Antes esto era una lista fija de dominios (supabase.co, jsdelivr.net,
  // googleapis.com) y no incluia el host de R2 -> el SW intentaba
  // cachear esas imagenes con su propia logica y la request fallaba
  // ("Fetch failed loading"). Comparar contra el origin propio es a
  // prueba de futuros dominios nuevos, no hace falta acordarse de
  // agregarlos a mano cada vez.
  return url.origin !== self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // nunca cachear POST/PUT/DELETE

  const url = new URL(request.url);
  if (isCrossOrigin(url)) return; // deja pasar tal cual, sin SW

  // Navegación (abrir/recargar la app): network-first con fallback a cache.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Assets propios (JS/CSS/etc): network-first con fallback a cache.
  // Antes era cache-first (stale-while-revalidate): mostraba SIEMPRE la
  // version vieja primero y recien la proxima carga se veia la nueva --
  // eso obligaba a hacer 2 reloads despues de cada deploy. Con
  // network-first, si hay señal siempre se ve el cambio en el primer
  // load; el cache solo se usa como respaldo sin conexion.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});