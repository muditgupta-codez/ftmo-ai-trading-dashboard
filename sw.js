self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) { d = { title: "FTMO AI Bot", body: (e.data && e.data.text()) || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "FTMO AI Bot", {
    body: d.body || "",
    tag: d.tag || "ftmo-bot",
    silent: !!d.silent,     // live position updates replace in place, no sound
    sound: d.critical ? "default" : undefined,
    requireInteraction: !!d.critical,  // stays on screen (desktop)
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: d.url || "/" }
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return clients.openWindow("/");
  }));
});
