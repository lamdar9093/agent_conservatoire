// Serveur de la plateforme du Conservatoire.
// Lancement : npm start (depuis le dossier agent_conservatoire), puis http://localhost:8080
// - sert le dossier plateforme/ (avec la lecture par morceaux pour l'audio) ;
// - injecte l'adaptateur (claude-local.js) dans la page principale, sans modifier index.html ;
// - garde les données dans PostgreSQL (Neon) si DATABASE_URL est défini dans .env, sinon dans donnees/ ;
// - connexion obligatoire : chaque membre a son compte (mot de passe temporaire, puis personnel) ;
//   un membre ne lit que ce qui le concerne, seul un administrateur modifie ;
// - prévient les pages ouvertes à chaque modification (Server-Sent Events).
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ouvrirStockage, nomValide } from "./stockage.mjs";
import { creerComptes, COOKIE, DUREE_SESSION } from "./comptes.mjs";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const PLATEFORME = path.resolve(ICI, "..");
const PORT = Number(process.env.PORT) || 8080;
// Adresse publique utilisée dans les liens envoyés aux membres (ex. https://conservatoire.exemple.org).
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".mp3": "audio/mpeg",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8", ".ico": "image/x-icon"
};
// Collections lisibles par un membre (les autres sont réservées à l'administrateur).
const LECTURE_MEMBRE = new Set(["membres", "seances", "khassidas", "dahiras", "programmes", "evaluations"]);
// Fichiers accessibles sans connexion.
const PUBLICS = new Set(["/connexion.html", "/local/connexion.js", "/favicon.ico"]);

// En production (Docker sur le VPS), les données doivent être dans PostgreSQL : un conteneur n'a pas de disque durable.
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant : en production, la plateforme a besoin de la base PostgreSQL (Neon). Voir .env.");
  process.exit(1);
}
const stock = await ouvrirStockage();
const comptes = creerComptes(stock);

const clients = new Set();
function prevenir(collection) {
  const msg = "data: " + JSON.stringify({ collection }) + "\n\n";
  for (const c of clients) c.res.write(msg);
}

function lireCorps(req) {
  return new Promise((ok, ko) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 5e6) { ko(new Error("trop gros")); req.destroy(); } });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { ko(e); } });
  });
}
function json(res, code, obj, entetes) {
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, entetes || {}));
  res.end(JSON.stringify(obj));
}
function lireCookie(req, nom) {
  const m = new RegExp("(?:^|;\\s*)" + nom + "=([^;]+)").exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
}
function estHttps(req) { return PUBLIC_URL.startsWith("https://") || req.headers["x-forwarded-proto"] === "https"; }
function cookieSession(req, jeton, maxAge) {
  return COOKIE + "=" + (jeton ? encodeURIComponent(jeton) : "") + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + (estHttps(req) ? "; Secure" : "");
}
function adresse(req) { return PUBLIC_URL || ((estHttps(req) ? "https://" : "http://") + (req.headers.host || "localhost:" + PORT)); }

/* Limite des essais de connexion : 8 échecs par quart d'heure et par adresse. */
const echecs = new Map();
function ipDe(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim(); }
function tropDEchecs(req) {
  const e = echecs.get(ipDe(req));
  if (e && Date.now() - e.t > 15 * 60000) { echecs.delete(ipDe(req)); return false; }
  return !!e && e.n >= 8;
}
function noterEchec(req) {
  const ip = ipDe(req), e = echecs.get(ip) || { n: 0, t: Date.now() };
  e.n++; echecs.set(ip, e);
}
/* Limite des demandes d'inscription : 10 par heure et par adresse. */
const inscriptions = new Map();
function tropDInscriptions(req) {
  const ip = ipDe(req), e = inscriptions.get(ip);
  if (!e || Date.now() - e.t > 3600000) { inscriptions.set(ip, { n: 1, t: Date.now() }); return false; }
  e.n++; return e.n > 10;
}
const chiffres = (t) => String(t || "").replace(/\D/g, "");
const lienInscription = (req, code) => adresse(req) + "/inscription?c=" + encodeURIComponent(code);

/* Ce qu'un membre (non administrateur) peut voir. */
function filtrerPourMembre(col, docs, moi) {
  if (col === "membres") return docs.map((d) => ({ id: d.id, data: { nom: d.data.nom, k1: d.data.k1, k2: d.data.k2, statut: d.data.statut, actif: d.data.actif, depuis: d.data.depuis } }));
  if (col === "evaluations") return docs.filter((d) => d.id === moi);
  if (col === "seances") return docs.map((d) => {
    const s = { ...d.data };
    if (s.prevenus) { const p = {}; for (const k of Object.keys(s.prevenus)) p[k] = s.prevenus[k] ? (k === moi ? s.prevenus[k] : { motif: "", note: "" }) : s.prevenus[k]; s.prevenus = p; }
    if (s.discipline) s.discipline = s.discipline[moi] ? { [moi]: s.discipline[moi] } : {};
    return { id: d.id, data: s };
  });
  return docs;
}

/* Départ définitif : l'accès du membre est supprimé (déconnecté partout, demande en cours effacée).
   S'il revient, il refait une demande avec le lien du groupe. */
async function apresMembre(col, id) {
  if (col !== "membres" || !id) return;
  const m = await stock.lireDoc("membres", id);
  if (!m || m.statut !== "parti") return;
  await comptes.revoquer(id); // refusé s'il s'agit du dernier administrateur
  await comptes.refuser(id);
  prevenir("_comptes");
}

async function api(req, res, parts, sess) {
  /* --- Connexion (sans session) --- */
  if (parts[0] === "connexion" && req.method === "POST") {
    if (tropDEchecs(req)) return json(res, 429, { code: "rate_limited", message: "Trop d’essais. Réessayez dans un quart d’heure." });
    const corps = await lireCorps(req);
    const r = await comptes.connecter(corps.identifiant, corps.motDePasse, await stock.lireCollection("membres"));
    if (r.erreur === "attente") return json(res, 403, { code: "attente", message: "Votre demande d’accès est bien reçue : elle attend la validation du Conservatoire. Vous serez prévenu sur WhatsApp." });
    if (r.erreur) noterEchec(req); else echecs.delete(ipDe(req));
    if (r.erreur === "expire") return json(res, 401, { code: "expire", message: "Ce mot de passe temporaire a expiré. Demandez-en un nouveau au Conservatoire." });
    if (r.erreur === "inconnu") return json(res, 401, { code: "identifiants", message: "Aucun accès à ce nom ou ce numéro. Pas encore inscrit ? Ouvrez le lien d’inscription partagé dans le groupe WhatsApp du Kourel." });
    if (r.erreur) return json(res, 401, { code: "identifiants", message: "Mot de passe incorrect." });
    return json(res, 200, { ok: true, doitChanger: r.temporaire }, { "Set-Cookie": cookieSession(req, r.jeton, DUREE_SESSION / 1000) });
  }
  /* --- Inscription libre (sans session) : lien du groupe WhatsApp, puis validation par un administrateur --- */
  if (parts[0] === "inscription") {
    const corps = req.method === "POST" ? await lireCorps(req) : {};
    const code = req.method === "POST" ? corps.c : new URL(req.url, "http://x").searchParams.get("c");
    if (!(await comptes.codeValide(code))) return json(res, 404, { code: "lien", message: "Ce lien d’inscription n’est plus valable. Demandez le nouveau lien au Conservatoire." });
    const membres = (await stock.lireCollection("membres")).filter((m) => m.data.statut !== "parti");
    if (req.method === "GET") {
      const etats = await comptes.etatDemandes();
      return json(res, 200, { membres: membres.map((m) => ({ id: m.id, nom: m.data.nom, etat: etats[m.id] || "libre" })).sort((a, b) => a.nom.localeCompare(b.nom, "fr")) });
    }
    if (req.method !== "POST") return json(res, 405, { code: "invalid_argument" });
    if (tropDInscriptions(req)) return json(res, 429, { code: "rate_limited", message: "Trop de demandes depuis cet appareil. Réessayez dans une heure." });
    const m = membres.find((x) => x.id === corps.membre);
    if (!m) return json(res, 400, { code: "membre", message: "Choisissez votre nom dans la liste." });
    // Un compte administrateur ne se réinitialise jamais par le lien du groupe (personne ne peut demander à sa place).
    const existant = (await comptes.liste())[m.id];
    if (existant && existant.admin) return json(res, 403, { code: "admin", message: "Pour ce compte, le mot de passe se change uniquement auprès du Conservatoire." });
    const tel = chiffres(corps.telephone);
    if (tel.length < 10 || tel.length > 15) return json(res, 400, { code: "telephone", message: "Saisissez votre numéro WhatsApp complet (10 chiffres au moins)." });
    if (typeof corps.motDePasse !== "string" || corps.motDePasse.length < 8) return json(res, 400, { code: "court", message: "Choisissez un mot de passe d’au moins 8 caractères." });
    await comptes.demander(m.id, String(corps.telephone).trim().slice(0, 30), corps.motDePasse);
    prevenir("_comptes");
    return json(res, 200, { ok: true, identifiant: m.id, nom: m.data.nom });
  }
  if (parts[0] === "moi") {
    if (!sess) return json(res, 200, { connecte: false, aucunCompte: await comptes.aucunCompte() });
    const m = await stock.lireDoc("membres", sess.membre);
    return json(res, 200, { connecte: true, membre: sess.membre, nom: m ? m.nom : sess.membre, admin: sess.admin, doitChanger: sess.temporaire });
  }
  if (parts[0] === "deconnexion" && req.method === "POST") {
    if (sess) await comptes.deconnecter(sess.id);
    return json(res, 200, { ok: true }, { "Set-Cookie": cookieSession(req, "", 0) });
  }
  if (!sess) return json(res, 401, { code: "non_connecte", message: "Connexion nécessaire." });
  if (parts[0] === "mot-de-passe" && req.method === "POST") {
    const corps = await lireCorps(req);
    const r = await comptes.changer(sess.membre, sess.id, corps.actuel, corps.nouveau);
    const msg = { actuel: "Le mot de passe actuel est incorrect.", court: "Choisissez au moins 8 caractères.", identique: "Choisissez un mot de passe différent de l’ancien.", compte: "Compte introuvable." };
    return r.erreur ? json(res, 400, { code: r.erreur, message: msg[r.erreur] }) : json(res, 200, { ok: true });
  }
  if (sess.temporaire) return json(res, 403, { code: "doit_changer", message: "Choisissez d’abord votre mot de passe." });

  /* --- Mises à jour en direct --- */
  if (parts[0] === "evenements") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": ok\n\n");
    const c = { res };
    clients.add(c);
    const battement = setInterval(() => res.write(": \n\n"), 25000);
    req.on("close", () => { clearInterval(battement); clients.delete(c); });
    return;
  }

  /* --- Comptes des membres (administrateur) --- */
  if (parts[0] === "comptes") {
    if (!sess.admin) return json(res, 403, { code: "invalid_argument", message: "Réservé à l’administrateur." });
    const [, membre, action] = parts;
    if (!membre && req.method === "GET") {
      const inv = await comptes.invitation();
      return json(res, 200, { comptes: await comptes.liste(), demandes: await comptes.demandes(), invitation: { lien: lienInscription(req, inv.code), creeLe: inv.creeLe },
        adresse: adresse(req), adressePublique: !!PUBLIC_URL });
    }
    if (membre === "_invitation" && req.method === "POST") {
      const inv = await comptes.nouvelleInvitation();
      return json(res, 200, { lien: lienInscription(req, inv.code), creeLe: inv.creeLe });
    }
    if (!nomValide(membre || "") || !(await stock.lireDoc("membres", membre))) return json(res, 404, { code: "not_found", message: "Membre introuvable." });
    if (action === "temporaire" && req.method === "POST") {
      const corps = await lireCorps(req);
      const r = await comptes.genererTemporaire(membre, corps.admin);
      return json(res, 200, { ...r, identifiant: membre, lien: adresse(req) + "/connexion.html?u=" + encodeURIComponent(membre) });
    }
    if (action === "valider" && req.method === "POST") {
      const r = await comptes.valider(membre);
      if (r.erreur) return json(res, 404, { code: "not_found", message: "Cette demande n’existe plus." });
      // Le numéro saisi par le membre est enregistré sur sa fiche.
      if (r.telephone) { await stock.fusionnerDoc("membres", membre, { telephone: r.telephone }); prevenir("membres"); }
      prevenir("_comptes");
      return json(res, 200, { ok: true, telephone: r.telephone, lien: adresse(req) + "/connexion.html?u=" + encodeURIComponent(membre) });
    }
    if (action === "refuser" && req.method === "POST") { await comptes.refuser(membre); prevenir("_comptes"); return json(res, 200, { ok: true }); }
    if (action === "envoye" && req.method === "POST") { await comptes.marquerEnvoye(membre); return json(res, 200, { ok: true }); }
    if (action === "admin" && req.method === "POST") {
      const r = await comptes.definirAdmin(membre, !!(await lireCorps(req)).admin);
      return r.erreur ? json(res, 400, { code: r.erreur, message: r.erreur === "dernier-admin" ? "Il faut garder au moins un administrateur." : "Ce membre n’a pas encore d’accès." }) : json(res, 200, { ok: true });
    }
    if (!action && req.method === "DELETE") {
      const r = await comptes.revoquer(membre);
      return r.erreur ? json(res, 400, { code: r.erreur, message: "Il faut garder au moins un administrateur." }) : json(res, 200, { ok: true });
    }
    return json(res, 405, { code: "invalid_argument" });
  }

  /* --- Documents --- */
  const [col, id] = parts;
  if (!col || !nomValide(col) || col.startsWith("_") || (id !== undefined && !nomValide(id)) || parts.length > 2) return json(res, 400, { code: "invalid_argument" });
  if (req.method === "GET") {
    if (!sess.admin && !LECTURE_MEMBRE.has(col)) return json(res, 403, { code: "invalid_argument" });
    let docs = id ? [{ id, data: await stock.lireDoc(col, id) }].filter((d) => d.data) : await stock.lireCollection(col);
    if (!sess.admin) docs = filtrerPourMembre(col, docs, sess.membre);
    if (id) return docs[0] ? json(res, 200, docs[0]) : json(res, 404, { code: "not_found" });
    return json(res, 200, { docs });
  }
  if (!sess.admin) return json(res, 403, { code: "invalid_argument", message: "Seul l’administrateur peut modifier." });
  if (req.method === "PUT") { await stock.ecrireDoc(col, id, await lireCorps(req)); prevenir(col); await apresMembre(col, id); return json(res, 200, { ok: true }); }
  if (req.method === "PATCH") {
    if (!(await stock.fusionnerDoc(col, id, await lireCorps(req)))) return json(res, 404, { code: "not_found" });
    prevenir(col); await apresMembre(col, id); return json(res, 200, { ok: true });
  }
  if (req.method === "DELETE") { await stock.supprimerDoc(col, id); prevenir(col); return json(res, 200, { ok: true }); }
  return json(res, 405, { code: "invalid_argument" });
}

async function fichier(req, res, urlPath, sess) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith("/")) rel += "index.html";
  // Lien court à partager dans le groupe : /inscription?c=CODE
  if (rel === "/inscription") {
    const c = new URL(req.url, "http://x").searchParams.get("c") || "";
    res.writeHead(302, { Location: "/connexion.html?inscription=" + encodeURIComponent(c), "Cache-Control": "no-store" });
    return res.end();
  }
  // Connexion obligatoire pour tout le reste (pages, audio, images).
  if (!PUBLICS.has(rel) && (!sess || sess.temporaire)) {
    if (rel.endsWith(".html")) {
      const dest = "/connexion.html" + (sess ? "?changer=1" : "");
      res.writeHead(302, { Location: dest, "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Connexion nécessaire");
  }
  const cible = path.resolve(PLATEFORME, "." + rel);
  if (!cible.startsWith(PLATEFORME + path.sep)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = await fsp.stat(cible); } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Introuvable"); }
  if (st.isDirectory()) { res.writeHead(302, { Location: urlPath.replace(/\/?$/, "/") }); return res.end(); }
  const type = TYPES[path.extname(cible).toLowerCase()] || "application/octet-stream";
  // Page principale : on ajoute l'adaptateur avant tout le reste.
  if (cible === path.join(PLATEFORME, "index.html")) {
    const html = await fsp.readFile(cible, "utf8");
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    return res.end('<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script src="/local/claude-local.js"></script></head><body>' + html + "</body></html>");
  }
  // Lecture par morceaux (Range) : indispensable pour avancer dans l'audio.
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let debut = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
    let fin = range[1] !== "" && range[2] !== "" ? Number(range[2]) : st.size - 1;
    if (isNaN(debut) || debut < 0 || debut >= st.size || fin < debut) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
    fin = Math.min(fin, st.size - 1);
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${debut}-${fin}/${st.size}`, "Content-Length": fin - debut + 1 });
    return fs.createReadStream(cible, { start: debut, end: fin }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": st.size, "Cache-Control": "no-cache" });
  fs.createReadStream(cible).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    // Contrôle de santé (Docker) : sans session ni base de données.
    if (url.pathname === "/api/sante") return json(res, 200, { ok: true });
    const sess = await comptes.session(lireCookie(req, COOKIE));
    if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname.slice(5).split("/").filter(Boolean), sess);
    return await fichier(req, res, url.pathname, sess);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { code: "erreur", message: "Erreur du serveur." });
    else res.end();
  }
}).listen(PORT, async () => {
  console.log("Plateforme du Conservatoire : http://localhost:" + PORT);
  console.log("Données : " + stock.nom);
  if (await comptes.aucunCompte()) {
    console.log("\nAucun compte pour l’instant. Créez le premier administrateur :");
    console.log('  npm run admin -- "Prénom Nom"\n');
  }
});
