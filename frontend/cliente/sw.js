// Service Worker mínimo — el único objetivo es cumplir el requisito técnico
// de Chrome/Android para que la PWA sea instalable. A propósito NO cachea
// nada de Supabase (datos dinámicos) ni el propio cliente.html, para evitar
// que el cliente vea contenido viejo. Solo cachea el "shell" estático
// (íconos + manifest) que casi nunca cambia.
const CACHE_NAME = 'lav-shell-v1';
const SHELL_FILES = [
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-icon-512.png',
  'manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Estrategia: solo responde desde cache para los archivos del shell.
// Todo lo demás (cliente.html, llamadas a Supabase) va directo a la red,
// nunca a cache, para que el cliente siempre vea datos actuales.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isShellFile = SHELL_FILES.some((f) => url.pathname.endsWith(f));
  if (!isShellFile) return; // deja pasar a la red sin intervenir

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
