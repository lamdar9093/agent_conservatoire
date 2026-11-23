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
import crypto from "node:crypto";
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
  ".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};
/* Rôles et permissions. Chaque fonctionnalité réservée a sa permission ; un rôle reçoit la liste de ses permissions.
   Pour une nouvelle fonctionnalité : créer sa permission ici, l'attribuer aux rôles voulus, et la vérifier côté serveur.
   - membre        : lecture seule de ce qui le concerne
   - conservatoire : « suivi » = séances (appel, retards, motifs d'absence, sanctions, Tari), évaluations, bilan
   - admin         : tout (accès des membres, numéros WhatsApp, membres, rappels, dahira, khassidas, réglages) */
const ROLES = { membre: new Set(), conservatoire: new Set(["suivi"]), admin: null };
// Collection -> permission nécessaire pour la modifier et la lire en entier (sinon : administrateur seulement).
const PERMISSION_COLLECTION = { seances: "suivi", evaluations: "suivi" };
const roleDe = (sess) => (sess.admin ? "admin" : sess.conservatoire ? "conservatoire" : "membre");
const peut = (sess, perm) => { const r = ROLES[roleDe(sess)]; return r === null || (!!perm && r.has(perm)); };
// Collections lisibles par un membre (les autres sont réservées à l'administrateur).
const LECTURE_MEMBRE = new Set(["membres", "seances", "khassidas", "dahiras", "programmes", "evaluations", "chants", "reglages"]);
// Fichiers accessibles sans connexion (le logo et les icônes de /marque/ aussi : page de connexion, onglet, écran d'accueil).
const PUBLICS = new Set(["/connexion.html", "/local/connexion.js", "/favicon.ico"]);
const estPublic = (rel) => PUBLICS.has(rel) || /^\/marque\/[\w.-]+$/.test(rel);

// En production (Docker sur le VPS), les données doivent être dans PostgreSQL : un conteneur n'a pas de disque durable.
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant : en production, la plateforme a besoin de la base PostgreSQL (Neon). Voir .env.");
  process.exit(1);
}
const stock = await ouvrirStockage();

/* Chaque page de khassida du code porte sa fiche (plateforme/khassidas/<dossier>/fiche.json).
   Au démarrage, une fiche absente de la liste y est ajoutée ; pour une fiche déjà présente, seuls les champs
   manquants sont complétés (ex. le kourel) : ce qui a été modifié sur la plateforme n'est jamais écrasé. */
for (const dossier of await fsp.readdir(path.join(PLATEFORME, "khassidas")).catch(() => [])) {
  try {
    const { id, ...fiche } = JSON.parse(await fsp.readFile(path.join(PLATEFORME, "khassidas", dossier, "fiche.json"), "utf8"));
    const actuel = id ? await stock.lireDoc("khassidas", id) : null;
    if (id && !actuel) { await stock.ecrireDoc("khassidas", id, fiche); console.log("Khassida ajouté à la liste : " + fiche.titre); }
    else if (actuel) {
      const manque = Object.fromEntries(Object.entries(fiche).filter(([k]) => actuel[k] === undefined));
      if (Object.keys(manque).length) await stock.fusionnerDoc("khassidas", id, manque);
    }
  } catch { /* dossier sans fiche */ }
}
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
/* Anonymat total des idées : un ancien envoi anonyme qui portait encore un nom le perd (une seule fois, au démarrage). */
for (const d of await stock.lireCollection("_idees").catch(() => [])) {
  if (d.data.anonyme && d.data.auteur) { const { auteur, ...reste } = d.data; await stock.ecrireDoc("_idees", d.id, reste); }
}
/* Boîte à idées et support : 15 envois par heure et par membre. */
const envois = new Map();
function tropDenvois(membre) {
  const e = envois.get(membre);
  if (!e || Date.now() - e.t > 3600000) { envois.set(membre, { n: 1, t: Date.now() }); return false; }
  return ++e.n > 15;
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
  // Programme de chant : un membre ne voit que ce qui est retenu, sans les propositions ni leurs auteurs.
  if (col === "chants") return docs.map((d) => ({ id: d.id, data: { items: (d.data.items || []).filter((x) => x.statut === "retenu")
    .map((x) => ({ id: x.id, khassida: x.khassida, titre: x.titre, ere: x.ere, statut: x.statut })) } }));
  return docs;
}

/* Programme de chant : kourels concernés par une clé, et qui décide. */
function infoChant(cle) {
  const m = /^(rep|dz)-(\d{4}-\d{2}-\d{2})-(k1|k2|rg|general)$/.exec(cle);
  return m ? { sorte: m[1], date: m[2], k: m[3], kourels: m[3] === "k1" ? ["k1"] : m[3] === "k2" ? ["k2"] : ["k1", "k2"] } : null;
}
async function decideChant(sess, info) {
  if (sess.admin) return true;
  const d = (((await stock.lireDoc("reglages", "kourels")) || {}).dieuwrigne) || {};
  return info.kourels.some((k) => d[k] === sess.membre);
}

/* Ce qu'un compte voit d'une collection selon son rôle. */
function filtrerPour(sess, col, docs) {
  if (sess.admin) return docs;
  if (peut(sess, "suivi")) {
    // Conservatoire : tout le suivi, mais jamais les numéros WhatsApp des membres.
    if (col === "membres") return docs.map((d) => { const { telephone, ...data } = d.data; return { id: d.id, data }; });
    return docs;
  }
  return filtrerPourMembre(col, docs, sess.membre);
}

/* Khassidas visibles par un membre (null = tous : administrateur et Conservatoire).
   Un membre voit : les khassidas de son ou ses kourels, ceux sans kourel indiqué, ceux prévus au programme
   d'une répétition générale à venir (les deux kourels la chantent ensemble) ou d'une répétition à venir de son kourel,
   et ceux d'un Tari qui le concerne et qu'il n'a pas encore maîtrisé (même règle que la page : Tari pour tous,
   pour les absents s'il était absent, ou individuel ; état « maîtrisé » = plus besoin). */
const aujourdhui = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const KOURELS = { k1: ["k1"], k2: ["k2"], k1k2: ["k1", "k2"] };
async function khassidasVisibles(sess) {
  if (peut(sess, "suivi")) return null;
  const m = (await stock.lireDoc("membres", sess.membre)) || {};
  const ok = new Set(), t = aujourdhui();
  for (const d of await stock.lireCollection("khassidas")) {
    const ks = KOURELS[d.data.kourel];
    if (!ks || ks.some((k) => m[k])) ok.add(d.id);
  }
  for (const p of await stock.lireCollection("programmes")) {
    const date = p.id.slice(0, 10), type = p.id.slice(11);
    if (p.data.khassida && !p.data.annulee && date >= t && (type === "rg" || m[type])) ok.add(p.data.khassida);
  }
  // Programme de chant à venir de son kourel (ou des deux kourels ensemble) : khassidas retenus.
  for (const c of await stock.lireCollection("chants")) {
    const info = infoChant(c.id);
    if (!info || info.date < t || !info.kourels.some((k) => m[k])) continue;
    for (const x of c.data.items || []) if (x.statut === "retenu" && x.khassida) ok.add(x.khassida);
  }
  for (const s of await stock.lireCollection("seances")) {
    const d = s.data, moi = sess.membre, kh = d.tariDetail && d.tariDetail.khassida, t = d.tari || "aucun";
    if (!kh || t === "aucun" || !(d.participants || []).includes(moi)) continue;
    const concerne = t === "tous" || (d.tariIndividuel || {})[moi] || (t === "choisis" ? !!(d.tariChoisis || {})[moi] : ((d.statuts || {})[moi] || "P") === "A");
    const etat = (d.tariEtat || {})[moi] || ((d.tariRecu || {})[moi] ? "maitrise" : "attendu");
    if (concerne && etat !== "maitrise") ok.add(kh);
  }
  return ok;
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
    if (r.erreur === "attente") return json(res, 403, { code: "attente", message: "Votre demande d’accès est bien reçue : elle attend la validation de l’admin. Vous serez prévenu sur WhatsApp." });
    if (r.erreur === "ambigu") return json(res, 401, { code: "ambigu", message: "Plusieurs membres ont ce nom : tapez votre numéro WhatsApp, ou votre prénom et votre nom." });
    if (r.erreur) noterEchec(req); else echecs.delete(ipDe(req));
    if (r.erreur === "expire") return json(res, 401, { code: "expire", message: "Ce mot de passe temporaire a expiré. Demandez-en un nouveau à l’admin." });
    if (r.erreur === "inconnu") return json(res, 401, { code: "identifiants", message: "Aucun accès à ce numéro ou ce nom. Tapez le numéro WhatsApp donné à l’inscription. Pas encore inscrit ? Ouvrez le lien d’inscription partagé dans le groupe WhatsApp du Kourel." });
    if (r.erreur) return json(res, 401, { code: "identifiants", message: "Mot de passe incorrect." });
    return json(res, 200, { ok: true, doitChanger: r.temporaire }, { "Set-Cookie": cookieSession(req, r.jeton, DUREE_SESSION / 1000) });
  }
  /* --- Inscription libre (sans session) : lien du groupe WhatsApp, puis validation par un administrateur --- */
  if (parts[0] === "inscription") {
    const corps = req.method === "POST" ? await lireCorps(req) : {};
    const code = req.method === "POST" ? corps.c : new URL(req.url, "http://x").searchParams.get("c");
    if (!(await comptes.codeValide(code))) return json(res, 404, { code: "lien", message: "Ce lien d’inscription n’est plus valable. Demandez le nouveau lien à l’admin." });
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
    if (existant && existant.admin) return json(res, 403, { code: "admin", message: "Pour ce compte, le mot de passe se change uniquement auprès de l’admin." });
    const tel = chiffres(corps.telephone);
    if (tel.length < 10 || tel.length > 15) return json(res, 400, { code: "telephone", message: "Saisissez votre numéro WhatsApp complet (10 chiffres au moins)." });
    if (typeof corps.motDePasse !== "string" || corps.motDePasse.length < 8) return json(res, 400, { code: "court", message: "Choisissez un mot de passe d’au moins 8 caractères." });
    await comptes.demander(m.id, String(corps.telephone).trim().slice(0, 30), corps.motDePasse);
    prevenir("_comptes");
    return json(res, 200, { ok: true, identifiant: m.id, nom: m.data.nom, telephone: String(corps.telephone).trim() });
  }
  // Visite guidée des onglets : vue une fois par personne (enregistré sur son compte, valable sur tous ses appareils).
  if (parts[0] === "moi" && parts[1] === "tour" && req.method === "POST") {
    if (!sess) return json(res, 401, { code: "non_connecte" });
    await stock.fusionnerDoc("_comptes", sess.membre, { tourVu: Date.now() });
    return json(res, 200, { ok: true });
  }
  if (parts[0] === "moi") {
    if (!sess) return json(res, 200, { connecte: false, aucunCompte: await comptes.aucunCompte() });
    const m = await stock.lireDoc("membres", sess.membre), c = (await stock.lireDoc("_comptes", sess.membre)) || {};
    return json(res, 200, { connecte: true, membre: sess.membre, nom: m ? m.nom : sess.membre, admin: sess.admin, role: roleDe(sess), doitChanger: sess.temporaire, tourVu: !!c.tourVu, k1: !!(m && m.k1), k2: !!(m && m.k2) });
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

  /* --- Boîte à idées et support ---
     Idées (_idees) : tout membre envoie, signé ou anonyme. Le Conservatoire et l'administrateur les lisent et répondent.
     Anonymat total (choix de l'utilisateur) : pour une idée anonyme, l'auteur n'est jamais enregistré, personne
     (ni le Conservatoire, ni l'administrateur, ni la base) ne peut savoir qui l'a écrite. L'auteur la retrouve
     grâce à son identifiant aléatoire, gardé sur son appareil (?ids=…).
     Support (_support) : un membre signale un souci ; seul l'administrateur le lit et répond.
     Chacun retrouve ses propres envois (avec la réponse) dans Mon espace. */
  if ((parts[0] === "idees" || parts[0] === "support") && !sess.temporaire) {
    const col = "_" + parts[0], id = parts[1], lecteur = parts[0] === "idees" ? peut(sess, "suivi") : sess.admin;
    const noms = Object.fromEntries((await stock.lireCollection("membres")).map((d) => [d.id, d.data.nom]));
    const mesAnonymes = new Set((new URL(req.url, "http://x").searchParams.get("ids") || "").split(",").filter((x) => /^[0-9a-f]{32}$/.test(x)));
    const vue = (d) => {
      const x = { id: d.id, ...d.data, moi: (!!d.data.auteur && d.data.auteur === sess.membre) || (!!d.data.anonyme && mesAnonymes.has(d.id)) };
      if (x.anonyme) delete x.auteur;
      if (x.auteur) x.nom = noms[x.auteur] || x.auteur;
      return x;
    };
    if (!id && req.method === "GET") {
      const docs = (await stock.lireCollection(col)).filter((d) => lecteur || d.data.auteur === sess.membre || (d.data.anonyme && mesAnonymes.has(d.id)));
      return json(res, 200, { docs: docs.map(vue).sort((a, b) => b.creeLe - a.creeLe), lecteur });
    }
    if (!id && req.method === "POST") {
      const c = await lireCorps(req), texte = String(c.texte || "").trim().slice(0, 3000);
      if (texte.length < 3) return json(res, 400, { code: "court", message: "Écrivez votre message avant d’envoyer." });
      if (tropDenvois(sess.membre)) return json(res, 429, { code: "trop", message: "Trop d’envois rapprochés : réessayez dans une heure." });
      const anonyme = parts[0] === "idees" && !!c.anonyme;
      // Idée anonyme : identifiant long et aléatoire (sert de clé à son auteur), et aucun nom enregistré.
      const nid = anonyme ? crypto.randomBytes(16).toString("hex") : Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
      const doc = parts[0] === "idees"
        ? { ...(anonyme ? {} : { auteur: sess.membre }), anonyme, type: ["idee", "suggestion", "positif", "ameliorer"].includes(c.type) ? c.type : "idee", texte, creeLe: Date.now(), statut: "nouveau" }
        : { auteur: sess.membre, texte, contexte: String(c.contexte || "").slice(0, 300), creeLe: Date.now(), statut: "ouvert" };
      await stock.ecrireDoc(col, nid, doc); prevenir(col);
      return json(res, 200, { ok: true, id: nid });
    }
    if (id && req.method === "PATCH") {
      if (!lecteur || !nomValide(id)) return json(res, 403, { code: "invalid_argument", message: "Réservé au Conservatoire." });
      const c = await lireCorps(req), maj = {};
      if (["nouveau", "lu", "traite", "ouvert", "resolu"].includes(c.statut)) maj.statut = c.statut;
      if (typeof c.reponse === "string") { maj.reponse = c.reponse.trim().slice(0, 3000); maj.reponduLe = Date.now(); maj.reponduPar = noms[sess.membre] || sess.membre; }
      if (!(await stock.fusionnerDoc(col, id, maj))) return json(res, 404, { code: "not_found" });
      prevenir(col); return json(res, 200, { ok: true });
    }
    return json(res, 405, { code: "invalid_argument" });
  }

  /* --- Programme de chant (répétitions et dahiras) ---
     chants/{clé} = { items: [{ id, khassida, titre, ere, statut: "retenu"|"propose", par, parNom, le }] }
     Clé : rep-AAAA-MM-JJ-(k1|k2|rg) pour une répétition, dz-AAAA-MM-JJ-(k1|k2|general) pour un passage au dahira.
     Le dieuwrigne du kourel (reglages/kourels.dieuwrigne) et l'admin décident : ce qu'ils ajoutent est retenu.
     Un autre membre du Conservatoire propose : sa proposition attend que le dieuwrigne la retienne ou l'écarte. */
  if (parts[0] === "chants" && (parts.length > 2 || req.method !== "GET")) {
    if (!peut(sess, "suivi")) return json(res, 403, { code: "invalid_argument", message: "Réservé au Conservatoire." });
    const cle = parts[1] || "", info = infoChant(cle);
    if (!info || !nomValide(cle)) return json(res, 400, { code: "invalid_argument" });
    const decideur = await decideChant(sess, info);
    const items = ((await stock.lireDoc("chants", cle)) || {}).items || [];
    const moiNom = ((await stock.lireDoc("membres", sess.membre)) || {}).nom || sess.membre;
    const c = req.method === "POST" || req.method === "PATCH" ? await lireCorps(req) : {};
    const ere = (x) => String(x || "").trim().slice(0, 80);
    let message = "";
    if (parts[2] === "items" && !parts[3] && req.method === "POST") {
      if (items.length >= 30) return json(res, 400, { code: "plein", message: "Le programme est déjà bien rempli (30 khassidas au plus)." });
      const kh = c.khassida && nomValide(String(c.khassida)) ? await stock.lireDoc("khassidas", String(c.khassida)) : null;
      const titre = kh ? kh.titre : String(c.titre || "").trim().slice(0, 120);
      if (!titre) return json(res, 400, { code: "titre", message: "Choisissez un khassida ou écrivez son titre." });
      items.push({ id: crypto.randomBytes(5).toString("hex"), khassida: kh ? String(c.khassida) : "", titre, ere: ere(c.ere !== undefined ? c.ere : kh && kh.ere),
        statut: decideur ? "retenu" : "propose", par: sess.membre, parNom: moiNom, le: Date.now() });
      message = decideur ? "ajoute" : "propose";
    } else if (parts[2] === "items" && parts[3]) {
      const i = items.findIndex((x) => x.id === parts[3]);
      if (i < 0) return json(res, 404, { code: "not_found", message: "Ce khassida n’est plus au programme." });
      const it = items[i], auteur = it.par === sess.membre && it.statut === "propose";
      if (req.method === "DELETE") {
        if (!decideur && !auteur) return json(res, 403, { code: "dieuwrigne", message: "Seul le dieuwrigne de ce kourel peut retirer un khassida du programme." });
        items.splice(i, 1);
      } else if (req.method === "PATCH") {
        if (c.statut !== undefined || c.deplacer !== undefined) {
          if (!decideur) return json(res, 403, { code: "dieuwrigne", message: "Seul le dieuwrigne de ce kourel décide du programme." });
          if (c.statut === "retenu") it.statut = "retenu";
          if (c.deplacer === "haut" || c.deplacer === "bas") {
            const ret = items.filter((x) => x.statut === "retenu"), j = ret.indexOf(it), k = c.deplacer === "haut" ? j - 1 : j + 1;
            if (j > -1 && k >= 0 && k < ret.length) { const a = items.indexOf(ret[k]); items[i] = ret[k]; items[a] = it; }
          }
        }
        if (c.ere !== undefined) {
          if (!decideur && !auteur) return json(res, 403, { code: "dieuwrigne", message: "Seul le dieuwrigne de ce kourel peut changer l’ère." });
          it.ere = ere(c.ere);
        }
      } else return json(res, 405, { code: "invalid_argument" });
    } else return json(res, 405, { code: "invalid_argument" });
    await stock.ecrireDoc("chants", cle, { items, majLe: Date.now(), majPar: moiNom });
    prevenir("chants");
    return json(res, 200, { ok: true, decideur, message });
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
      // Lien de connexion avec le numéro déjà rempli.
      return json(res, 200, { ok: true, telephone: r.telephone, lien: adresse(req) + "/connexion.html?u=" + encodeURIComponent(r.telephone || membre) });
    }
    if (action === "refuser" && req.method === "POST") { await comptes.refuser(membre); prevenir("_comptes"); return json(res, 200, { ok: true }); }
    if (action === "envoye" && req.method === "POST") { await comptes.marquerEnvoye(membre); return json(res, 200, { ok: true }); }
    if (action === "role" && req.method === "POST") {
      const r = await comptes.definirRole(membre, String((await lireCorps(req)).role || ""));
      if (!r.erreur) prevenir("_comptes");
      return r.erreur ? json(res, 400, { code: r.erreur, message: r.erreur === "dernier-admin" ? "Il faut garder au moins un administrateur." : r.erreur === "role" ? "Rôle inconnu." : "Ce membre n’a pas encore d’accès." }) : json(res, 200, { ok: true });
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
    docs = filtrerPour(sess, col, docs);
    if (col === "khassidas") { const vis = await khassidasVisibles(sess); if (vis) docs = docs.filter((d) => vis.has(d.id)); }
    if (id) return docs[0] ? json(res, 200, docs[0]) : json(res, 404, { code: "not_found" });
    return json(res, 200, { docs });
  }
  const corps = req.method === "PUT" || req.method === "PATCH" ? await lireCorps(req) : null;
  // Conservatoire : il peut marquer un khassida « en répétition » (et seulement cela).
  const marqueRepetition = col === "khassidas" && req.method === "PATCH" && corps && Object.keys(corps).length > 0
    && Object.keys(corps).every((k) => ["enRepetition", "enRepetitionLe", "enRepetitionPar"].includes(k));
  if (!peut(sess, marqueRepetition ? "suivi" : PERMISSION_COLLECTION[col])) return json(res, 403, { code: "invalid_argument", message: "Vous n’avez pas le droit de modifier ceci." });
  // Conservatoire : il crée une séance et fait l'appel, mais seul l'administrateur la supprime
  // ou change ce qui la définit (date, répétition, horaire), même en cas d'erreur.
  if (col === "seances" && !sess.admin) {
    const avant = id ? await stock.lireDoc("seances", id) : null;
    const PROTEGES = ["date", "type", "horaire", "creeLe"];
    const different = (k) => JSON.stringify(corps[k]) !== JSON.stringify(avant[k]);
    const refuse = req.method === "DELETE"
      || (avant && req.method === "PUT" && PROTEGES.some(different))
      || (avant && req.method === "PATCH" && PROTEGES.some((k) => k in corps && different(k)));
    if (refuse) return json(res, 403, { code: "admin_seance", message: "Seul l’administrateur peut modifier ou supprimer une séance. Contactez-le si c’est une erreur." });
  }
  if (req.method === "PUT") { await stock.ecrireDoc(col, id, corps); prevenir(col); await apresMembre(col, id); return json(res, 200, { ok: true }); }
  if (req.method === "PATCH") {
    if (!(await stock.fusionnerDoc(col, id, corps))) return json(res, 404, { code: "not_found" });
    prevenir(col); await apresMembre(col, id); return json(res, 200, { ok: true });
  }
  if (req.method === "DELETE") { await stock.supprimerDoc(col, id); prevenir(col); return json(res, 200, { ok: true }); }
  return json(res, 405, { code: "invalid_argument" });
}

// Icône d'onglet, écran d'accueil du téléphone et couleur de la barre du navigateur.
const ICONES = '<link rel="icon" href="/marque/favicon.ico" sizes="any"><link rel="icon" type="image/png" href="/marque/favicon-96.png" sizes="96x96">' +
  '<link rel="apple-touch-icon" href="/marque/apple-touch-icon.png"><link rel="manifest" href="/marque/site.webmanifest">' +
  '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#161b19" media="(prefers-color-scheme: dark)">' +
  '<meta name="apple-mobile-web-app-title" content="Conservatoire">';

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
  if (rel === "/favicon.ico") rel = "/marque/favicon.ico";
  if (!estPublic(rel) && (!sess || sess.temporaire)) {
    if (rel.endsWith(".html")) {
      const dest = "/connexion.html" + (sess ? "?changer=1" : "");
      res.writeHead(302, { Location: dest, "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Connexion nécessaire");
  }
  // Page, audio et manuscrit d'un khassida qui ne concerne pas ce membre : refusés aussi.
  const dossierKh = /^\/khassidas\/([\w-]+)\//.exec(rel);
  if (dossierKh && sess && !peut(sess, "suivi")) {
    const fiche = await fsp.readFile(path.join(PLATEFORME, "khassidas", dossierKh[1], "fiche.json"), "utf8").then(JSON.parse, () => null);
    const vis = fiche && fiche.id ? await khassidasVisibles(sess) : null;
    if (vis && !vis.has(fiche.id)) { res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Ce khassida est réservé à un autre kourel."); }
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
    return res.end('<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' + ICONES + '<script src="/local/claude-local.js"></script></head><body>' + html + "</body></html>");
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
  const cache = rel.startsWith("/marque/") ? "public, max-age=604800" : "no-cache";
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": st.size, "Cache-Control": cache });
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
