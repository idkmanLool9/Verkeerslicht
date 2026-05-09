// Minimale service worker voor "installeerbaar" — cachen we (nog) niet
// agressief omdat de map en API's altijd vers willen zijn. Houdt het
// installable-criterium voor PWA's tevreden.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  // pass-through: laat de browser z'n ding doen
});
