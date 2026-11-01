// Task Tracker service worker – push notifications
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Task Tracker", body: event.data && event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(d.title || "Task Tracker", {
      body: d.body || "",
      tag: d.tag || "tt",
      renotify: true,
      requireInteraction: !!d.requireInteraction,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      data: { url: d.url || "./" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const id = new URL(url).searchParams.get("open");
      for (const c of list) if (c.url.startsWith(self.registration.scope)) {
        if (id) c.postMessage({ type: "open", id }); // open that task in the running app
        return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
