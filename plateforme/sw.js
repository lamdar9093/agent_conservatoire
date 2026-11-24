/* Service worker de la plateforme du Conservatoire : notifications sur le téléphone et chiffre sur l'icône.
   Le serveur envoie un « push » sans contenu ; on demande alors le message et la pastille (voir local/notifications.mjs). */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  e.waitUntil(
    fetch("/api/notifs/resume", { credentials: "include", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; })
      .then(function (d) {
        var badge = Number(d.badge) || 0;
        var pastille = self.navigator && self.navigator.setAppBadge
          ? (badge ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(function () {})
          : Promise.resolve();
        return pastille.then(function () {
          return self.registration.showNotification(d.titre || "Conservatoire", {
            body: d.texte || "Du nouveau sur la plateforme.",
            icon: "/marque/icone-192.png",
            badge: "/marque/icone-192.png",
            tag: "conservatoire",
            renotify: true,
            data: { url: d.url || "/" }
          });
        });
      })
  );
});

/* Toucher la notification : ouvre la plateforme à la bonne page. */
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (fenetres) {
    for (var i = 0; i < fenetres.length; i++) {
      var f = fenetres[i];
      if (f.url.indexOf(self.location.origin) === 0 && "focus" in f) {
        return (f.navigate ? f.navigate(url).catch(function () { return f; }) : Promise.resolve(f)).then(function (g) { return (g || f).focus(); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
