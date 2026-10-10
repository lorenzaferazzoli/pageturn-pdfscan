// Service worker: l'app funziona offline. Il motore OCR viene messo in cache al primo uso.
const VERSION = 'sfoglia-1.0.0';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/db.js',
  'js/queue.js',
  'js/sync.js',
  'js/camera.js',
  'js/detect.js',
  'js/proc.js',
  'js/render.js',
  'js/jobs.js',
  'js/proc-worker.js',
  'js/icons.js',
  'js/export.js',
  'js/ocr.js',
  'vendor/pdf-lib.esm.min.js',
  'vendor/fflate.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const OCR_CACHE = 'sfoglia-ocr-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== OCR_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/')) return; // server di backup: mai in cache
  if (url.pathname.includes('/vendor/tesseract') || url.pathname.includes('/vendor/tessdata')) {
    e.respondWith(
      caches.open(OCR_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const r = await fetch(e.request);
        if (r.ok) c.put(e.request, r.clone());
        return r;
      }),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() => caches.match('index.html'))),
  );
});
