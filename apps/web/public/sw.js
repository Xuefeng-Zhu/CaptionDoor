const CACHE = "captiondoor-public-shell-v1";
const PUBLIC = ["/offline.html", "/icon.svg"];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PUBLIC))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("captiondoor-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      ),
  ),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET")
    return;
  if (PUBLIC.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((hit) => hit || fetch(event.request)),
    );
    return;
  }
  if (event.request.mode === "navigate")
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/offline.html")),
    );
});
self.addEventListener("push", (event) => {
  let value = {};
  try {
    value = event.data?.json() || {};
  } catch {}
  event.waitUntil(
    self.registration.showNotification("CaptionDoor", {
      body: "There is an update at your door. Open CaptionDoor to check.",
      tag: value.tag || "captiondoor-door",
      icon: "/icon.svg",
      data: { url: "/home" },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/home"));
});
