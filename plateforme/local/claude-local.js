/* Adaptateur local : remplace window.claude (base de claude.ai) par le serveur local.
   Mêmes fonctions que celles utilisées par index.html :
   - use("db")   : collection(nom).onSnapshot(cb, erreur), doc("col/id").set / update / delete
   - use("user") : canEdit(), compte(), deconnexion()
   - use("downloads") : save({ filename, data })
   - use("comptes") : accès des membres (administrateur) : liste, temporaire, envoye, role, revoquer,
     valider / refuser (demandes d'inscription), invitation (nouveau lien d'inscription)
   Chargé automatiquement par plateforme/local/serveur.mjs ; index.html n'est pas modifié. */
(function () {
  "use strict";
  var ecoutes = {}; // collection -> [{ cb, err }]

  function appel(methode, chemin, corps) {
    return fetch("/api/" + chemin, {
      method: methode,
      headers: corps ? { "Content-Type": "application/json" } : {},
      body: corps ? JSON.stringify(corps) : undefined,
      cache: "no-store",
      credentials: "same-origin"
    }).then(function (r) {
      if (r.status === 401 && chemin !== "moi") { location.href = "/connexion.html"; return new Promise(function () {}); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || "Erreur " + r.status); e.code = j.code || "unavailable"; throw e; }
        return j;
      });
    });
  }
  function instantane(docs) {
    return { docs: docs.map(function (d) { return { id: d.id, data: function () { return d.data; } }; }) };
  }
  function rafraichir(col) {
    var l = ecoutes[col];
    if (!l || !l.length) return;
    appel("GET", encodeURIComponent(col)).then(function (r) {
      var snap = instantane(r.docs || []);
      l.forEach(function (x) { try { x.cb(snap); } catch (e) { console.error(e); } });
    }, function (e) { l.forEach(function (x) { if (x.err) x.err(e); }); });
  }

  /* Mises à jour en direct : le serveur signale chaque collection modifiée. */
  try {
    var es = new EventSource("/api/evenements");
    es.onmessage = function (ev) {
      try {
        var col = JSON.parse(ev.data).collection;
        // Comptes et demandes d'accès : la page administrateur se met à jour d'elle-même.
        if (col === "_comptes") window.dispatchEvent(new Event("conservatoire-comptes"));
        else if (col === "_idees" || col === "_support") window.dispatchEvent(new Event("conservatoire-messages"));
        else rafraichir(col);
      } catch (e) { /* message ignoré */ }
    };
  } catch (e) { /* sans EventSource : pas de mise à jour en direct */ }

  function chemin(p) {
    var parts = String(p).split("/");
    if (parts.length !== 2) throw new Error("Chemin de document attendu : collection/id");
    return encodeURIComponent(parts[0]) + "/" + encodeURIComponent(parts[1]);
  }
  function apres(p) { var col = String(p).split("/")[0]; return function (r) { rafraichir(col); return r; }; }

  var db = Object.freeze({
    collection: function (nom) {
      return {
        onSnapshot: function (cb, err) {
          (ecoutes[nom] = ecoutes[nom] || []).push({ cb: cb, err: err });
          rafraichir(nom);
          return function () { ecoutes[nom] = (ecoutes[nom] || []).filter(function (x) { return x.cb !== cb; }); };
        }
      };
    },
    doc: function (p) {
      return {
        get: function () { return appel("GET", chemin(p)).then(function (r) { return { id: r.id, exists: true, data: function () { return r.data; } }; }); },
        set: function (data) { return appel("PUT", chemin(p), data).then(apres(p)); },
        update: function (data) { return appel("PATCH", chemin(p), data).then(apres(p)); },
        delete: function () { return appel("DELETE", chemin(p)).then(apres(p)); }
      };
    }
  });

  var moiPromesse = null;
  function moi() {
    if (!moiPromesse) moiPromesse = appel("GET", "moi").then(function (r) { return r || {}; }, function () { return {}; });
    return moiPromesse;
  }
  function admin() { return moi().then(function (r) { return !!r.admin; }); }
  var user = Object.freeze({
    canEdit: admin,
    isOwner: admin,
    can: function () { return admin(); },
    /* Compte connecté : { membre, nom, admin, role } (role : membre, conservatoire ou admin) */
    compte: function () { return moi().then(function (r) { return r.connecte ? { membre: r.membre, nom: r.nom, admin: !!r.admin, role: r.role || (r.admin ? "admin" : "membre"), tourVu: !!r.tourVu } : null; }); },
    /* Visite guidée vue : enregistrée sur le compte. */
    tourVu: function () { return appel("POST", "moi/tour", {}); },
    deconnexion: function () { return appel("POST", "deconnexion").then(function () { location.href = "/connexion.html"; }); }
  });

  var comptes = Object.freeze({
    liste: function () { return appel("GET", "comptes"); },
    temporaire: function (id, opts) { return appel("POST", "comptes/" + encodeURIComponent(id) + "/temporaire", opts || {}); },
    envoye: function (id) { return appel("POST", "comptes/" + encodeURIComponent(id) + "/envoye", {}); },
    role: function (id, role) { return appel("POST", "comptes/" + encodeURIComponent(id) + "/role", { role: role }); },
    revoquer: function (id) { return appel("DELETE", "comptes/" + encodeURIComponent(id)); },
    valider: function (id) { return appel("POST", "comptes/" + encodeURIComponent(id) + "/valider", {}); },
    refuser: function (id) { return appel("POST", "comptes/" + encodeURIComponent(id) + "/refuser", {}); },
    invitation: function () { return appel("POST", "comptes/_invitation", {}); }
  });

  var downloads = Object.freeze({
    save: function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data]);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = req.filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return Promise.resolve({ status: "saved" });
    }
  });

  /* Boîte à idées et support (voir serveur.mjs) */
  var messages = Object.freeze({
    liste: function (type) { return appel("GET", type); },
    envoyer: function (type, data) { return appel("POST", type, data); },
    maj: function (type, id, data) { return appel("PATCH", type + "/" + encodeURIComponent(id), data); }
  });

  var caps = { db: db, user: user, downloads: downloads, messages: messages };
  window.claude = Object.freeze({
    use: function (nom) {
      if (nom === "comptes") return admin().then(function (a) { return a ? comptes : null; });
      return Promise.resolve(caps[nom] || null);
    }
  });
})();
