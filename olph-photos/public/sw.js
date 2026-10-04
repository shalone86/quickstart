// Receives photos shared from the phone's gallery (Share → OLPH Photos) and hands them to the app.
const SHARE_CACHE = "olph-share";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share") {
    event.respondWith((async () => {
      const form = await event.request.formData();
      const files = form.getAll("photos").filter(f => f instanceof File);
      const cache = await caches.open(SHARE_CACHE);
      for (const key of await cache.keys()) await cache.delete(key);
      await Promise.all(files.map((f, i) => cache.put(`/shared/${i}`, new Response(f, {
        headers: { "Content-Type": f.type, "X-Name": encodeURIComponent(f.name), "X-Modified": String(f.lastModified || "") }
      }))));
      return Response.redirect(`/?shared=${files.length}`, 303);
    })());
  }
});
