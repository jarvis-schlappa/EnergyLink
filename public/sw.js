// EnergyLink Service Worker – Push Notifications only (no caching)

self.addEventListener("push", (event) => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    const title = data.title || "EnergyLink";
    const options = {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: data.data || {},
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (error) {
    // Fallback for non-JSON payloads
    const text = event.data.text();
    event.waitUntil(
      self.registration.showNotification("EnergyLink", { body: text }),
    );
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus existing window if available
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            return client.focus();
          }
        }
        // Open new window
        return clients.openWindow("/");
      }),
  );
});
