/* Sổ Job – service worker: nhận thông báo đẩy (Firebase Cloud Messaging) khi app đang tắt / chạy nền. */
self.window = self;
importScripts(
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js",
  "firebase-config.js"
);
if (self.SOJOB_FIREBASE) { firebase.initializeApp(self.SOJOB_FIREBASE); firebase.messaging(); }
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
// Bấm thông báo: mở / chuyển tới app, đúng job
self.addEventListener("notificationclick", e => {
  const d = (e.notification && e.notification.data) || {};
  const job = (d.FCM_MSG && d.FCM_MSG.data && d.FCM_MSG.data.job) || d.job || "";
  const url = new URL("./" + (job ? "?job=" + encodeURIComponent(job) : ""), self.registration.scope).href;
  e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) { if (c.url.startsWith(self.registration.scope)) { c.postMessage({ openJob: job }); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
