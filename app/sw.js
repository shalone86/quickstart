// Offline support: the whole app is cached so it opens instantly with no connection.
// Updated files are fetched in the background and used on the next launch.
const VERSION = 'scriptorium-v4';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'vendor/Readability.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/ai.js', 'js/article.js', 'js/db.js', 'js/editor.js', 'js/exporter.js', 'js/feeds.js',
  'js/history.js', 'js/icons.js', 'js/markdown.js', 'js/mathx.js', 'js/media.js', 'js/pickers.js',
  'js/provenance.js', 'js/reading.js', 'js/sanitize.js', 'js/search.js', 'js/sources.js', 'js/settings.js', 'js/sketch.js', 'js/store.js',
  'js/text.js', 'js/theme.js', 'js/ui.js', 'js/util.js', 'js/voice.js', 'js/websearch.js', 'js/zip.js',
  'js/sync/engine.js', 'js/sync/github.js', 'js/sync/server.js',
  'js/views/ask.js', 'js/views/askpanel.js', 'js/views/calendar.js', 'js/views/common.js', 'js/views/historyview.js', 'js/views/home.js',
  'js/views/list.js', 'js/views/news.js', 'js/views/note.js', 'js/views/organize.js', 'js/views/search.js',
  'js/views/settings.js', 'js/views/syncbadge.js', 'js/views/toolbar.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.includes('/s/')) return;
  // stale-while-revalidate
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const key = e.request.mode === 'navigate' ? new URL('./', location.href).href : e.request;
    const cached = await cache.match(key, { ignoreSearch: true });
    const network = fetch(e.request).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
