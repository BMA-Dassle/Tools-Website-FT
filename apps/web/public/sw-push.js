/*
 * THE DESK ALARM'S SERVICE WORKER — deadline alerts on a phone.
 *
 * Deliberately the smallest thing that can work: it receives a push, shows a
 * notification, and focuses the board when one is tapped. It does NOT cache,
 * intercept fetches, or precache a shell — this worker is registered on admin
 * routes only, and an admin surface that silently served a stale cached page
 * would be a far worse bug than a missed buzz.
 *
 * Registered by useDeskAlarm (check-in board gear) at the site root scope so
 * one worker serves every admin tab. Kept as a plain .js file in /public so it
 * is served from the origin root — a service worker cannot control pages above
 * its own path, and a bundled route would sit too deep.
 */

// Take over as soon as a new copy is installed, so a fixed worker reaches the
// desk on the next page load rather than after every tab is closed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  /* A push with no readable payload is still worth showing — a silent failure
     here would be indistinguishable from no alert at all. */
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = data.title || "FastTrax desk";
  const body = data.body || "A session deadline needs attention.";
  /* `tag` collapses one session's three alerts into a single notification that
     updates in place; `renotify` makes each update buzz anyway, which is the
     whole point of a three-beat countdown. */
  const tag = data.tag || "desk-alarm";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      requireInteraction: false,
      // Vibrate rather than rely on a ring tone: the phone is in a pocket in a
      // building with karts running.
      vibrate: [200, 100, 200],
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      // Prefer a board that is already open — the person tapping wants the
      // screen they were told about, not a second copy of it.
      for (const client of list) {
        if (client.url.includes("/checkin") && "focus" in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
    }),
  );
});
