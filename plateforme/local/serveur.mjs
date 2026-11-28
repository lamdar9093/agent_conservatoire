// Serveur de la plateforme du Conservatoire.
// Lancement : npm start (depuis le dossier agent_conservatoire), puis http://localhost:8080
// - sert le dossier plateforme/ (avec la lecture par morceaux pour l'audio) ;
// - injecte l'adaptateur (claude-local.js) dans la page principale, sans modifier index.html ;
// - garde les données dans PostgreSQL (Neon) si DATABASE_URL est défini dans .env, sinon dans donnees/ ;
//   les audios des Taris enregistrés vont dans AUDIOS_DIR (volume Docker en production) ;
// - connexion obligatoire : chaque membre a son compte (mot de passe temporaire, puis personnel) ;
//   un membre ne lit que ce qui le concerne, seul un administrateur modifie ;
// - prévient les pages ouvertes à chaque modification (Server-Sent Events).
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ouvrirStockage, nomValide } from "./stockage.mjs";
import { creerComptes, COOKIE, DUREE_SESSION } from "./comptes.mjs";
import { creerNotifications } from "./notifications.mjs";

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
const LECTURE_MEMBRE = new Set(["membres", "seances", "khassidas", "dahiras", "programmes", "evaluations", "chants", "reglages", "taris", "audiosSeances", "commentairesAudios"]);
// Fichiers accessibles sans connexion (le logo et les icônes de /marque/ aussi : page de connexion, onglet, écran d'accueil).
const PUBLICS = new Set(["/connexion.html", "/local/connexion.js", "/favicon.ico", "/sw.js"]);
const estPublic = (rel) => PUBLICS.has(rel) || /^\/marque\/[\w.-]+$/.test(rel);

// En production (Docker sur le VPS), les données doivent être dans PostgreSQL : un conteneur n'a pas de disque durable.
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant : en production, la plateforme a besoin de la base PostgreSQL (Neon). Voir .env.");
  process.exit(1);
}
const stock = await ouvrirStockage();

/* Audios des Taris enregistrés par les membres : fichiers sur le disque (pas dans la base).
   En production (Docker), AUDIOS_DIR est un volume gardé d'un déploiement à l'autre (voir docker-compose.yml).
   En local : le dossier audios-taris/ à la racine (exclu de git). */
const AUDIOS = path.resolve(process.env.AUDIOS_DIR || path.resolve(ICI, "..", "..", "audios-taris"));
try {
  await fsp.mkdir(AUDIOS, { recursive: true });
  await fsp.access(AUDIOS, fs.constants.W_OK);
  // Réceptions interrompues lors d'un arrêt précédent.
  for (const f of await fsp.readdir(AUDIOS)) if (f.startsWith(".recu-")) await fsp.rm(path.join(AUDIOS, f), { force: true });
} catch (e) { console.error("Dossier des audios des Taris inaccessible (" + AUDIOS + ") : " + e.message); }
/* Audios des répétitions (enregistrés par le Conservatoire pendant une séance) : sous-dossier seances/ du même volume. */
const AUDIOS_SEANCES = path.join(AUDIOS, "seances");
try {
  await fsp.mkdir(AUDIOS_SEANCES, { recursive: true });
  for (const f of await fsp.readdir(AUDIOS_SEANCES)) if (f.startsWith(".recu-")) await fsp.rm(path.join(AUDIOS_SEANCES, f), { force: true });
} catch (e) { console.error("Dossier des audios des répétitions inaccessible (" + AUDIOS_SEANCES + ") : " + e.message); }
/* ffmpeg (présent dans l'image Docker) convertit chaque envoi en m4a (AAC) : lisible sur tous les téléphones,
   y compris un iPhone qui écoute un enregistrement fait sur Android. Sans ffmpeg, le fichier est gardé tel quel. */
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const ffmpegDispo = await new Promise((ok) => {
  try {
    const p = spawn(FFMPEG, ["-version"], { stdio: "ignore" });
    p.on("error", () => ok(false));
    p.on("exit", (c) => ok(c === 0));
  } catch { ok(false); }
});

/* Chaque page de khassida du code porte sa fiche (plateforme/khassidas/<dossier>/fiche.json).
   Au démarrage, une fiche absente de la liste y est ajoutée ; pour une fiche déjà présente, seuls les champs
   manquants sont complétés (ex. le kourel) : ce qui a été modifié sur la plateforme n'est jamais écrasé. */
const khassidasAuDepart = (await stock.lireCollection("khassidas")).length, khassidasNouveaux = [];
for (const dossier of await fsp.readdir(path.join(PLATEFORME, "khassidas")).catch(() => [])) {
  try {
    const { id, ...fiche } = JSON.parse(await fsp.readFile(path.join(PLATEFORME, "khassidas", dossier, "fiche.json"), "utf8"));
    const actuel = id ? await stock.lireDoc("khassidas", id) : null;
    if (id && !actuel) {
      await stock.ecrireDoc("khassidas", id, { ...fiche, ajouteLe: Date.now() }); console.log("Khassida ajouté à la liste : " + fiche.titre);
      // Annoncé aux membres (pas lors de la toute première installation, où tout le répertoire arrive d'un coup).
      if (khassidasAuDepart) khassidasNouveaux.push(id);
    }
    else if (actuel) {
      const manque = Object.fromEntries(Object.entries(fiche).filter(([k]) => actuel[k] === undefined));
      if (Object.keys(manque).length) await stock.fusionnerDoc("khassidas", id, manque);
    }
  } catch { /* dossier sans fiche */ }
}
const comptes = creerComptes(stock);
const notifs = await creerNotifications(stock, { sujet: PUBLIC_URL.startsWith("https://") ? PUBLIC_URL : "https://conservatoire.mthbichri.ca" });

/* Nouveau khassida : chaque membre qui peut le voir (son kourel ; Conservatoire, Discipline et admin : tous) est prévenu,
   une minute après l'ajout (le temps de corriger une faute de frappe) ; plusieurs ajouts rapprochés partent ensemble. */
const khassidasAAnnoncer = new Map(); let minuterieKhassidas = null;
function annoncerKhassida(id, par) {
  khassidasAAnnoncer.set(id, par || "");
  clearTimeout(minuterieKhassidas);
  minuterieKhassidas = setTimeout(() => envoyerAnnoncesKhassidas().catch((e) => console.error(e)), Number(process.env.DELAI_NOTIF_KHASSIDA || 60000));
}
async function envoyerAnnoncesKhassidas() {
  const lot = [...khassidasAAnnoncer]; khassidasAAnnoncer.clear();
  const membres = new Map((await stock.lireCollection("membres")).map((d) => [d.id, d.data]));
  const pour = new Map();   // membre -> khassidas qu'il peut voir
  const khs = [];
  for (const [id, par] of lot) { const kh = await stock.lireDoc("khassidas", id); if (kh) khs.push({ id, par, kh }); }
  for (const c of await stock.lireCollection("_comptes")) {
    const m = membres.get(c.id); if (!m || !actif(m)) continue;
    const tout = c.data.admin || c.data.conservatoire || c.data.discipline;
    for (const x of khs) {
      const ks = KOURELS[x.kh.kourel];
      if (c.id !== x.par && (tout || !ks || ks.some((k) => m[k]))) (pour.get(c.id) || pour.set(c.id, []).get(c.id)).push(x);
    }
  }
  const groupes = new Map();   // même liste de khassidas -> mêmes destinataires
  for (const [mid, l] of pour) { const cle = l.map((x) => x.id).join(","); (groupes.get(cle) || groupes.set(cle, { l, membres: [] }).get(cle)).membres.push(mid); }
  for (const { l, membres: dest } of groupes.values()) {
    const un = l.length === 1;
    await notifs.notifier(dest, {
      titre: un ? "📖 Nouveau khassida" : "📖 " + l.length + " nouveaux khassidas",
      texte: un ? l[0].kh.titre + (l[0].kh.ere ? " (ère " + l[0].kh.ere + ")" : "") + (l[0].kh.page ? " est sur la plateforme : texte, phonétique, traduction et audio." : " a été ajouté au répertoire.")
        : l.map((x) => x.kh.titre).join(", ") + " ont été ajoutés au répertoire.",
      url: un ? "/#khassida/" + encodeURIComponent(l[0].id) : "/#khassidas"
    });
  }
}
if (khassidasNouveaux.length) for (const id of khassidasNouveaux) annoncerKhassida(id, "");

/* ---------- Notifications : qui prévenir, et le chiffre de la pastille sur l'icône ---------- */
async function lecteursTaris(sauf) {
  return (await stock.lireCollection("_comptes")).filter((d) => (d.data.admin || d.data.conservatoire) && d.id !== sauf).map((d) => d.id);
}
async function admins() { return (await stock.lireCollection("_comptes")).filter((d) => d.data.admin).map((d) => d.id); }
const actif = (m) => !!m && (m.statut || (m.actif === false ? "pause" : "actif")) === "actif";
/* Pastille de l'icône : Taris à enregistrer, Taris à écouter (Conservatoire), demandes d'accès (admin). */
async function badgePour(membre) {
  const c = (await stock.lireDoc("_comptes", membre)) || {}, suivi = !!(c.admin || c.conservatoire);
  const seances = await stock.lireCollection("seances"), taris = new Map((await stock.lireCollection("taris")).map((d) => [d.id, d.data]));
  const membres = new Map((await stock.lireCollection("membres")).map((d) => [d.id, d.data]));
  let n = 0;
  for (const { id: sid, data: s } of seances) {
    for (const mid of s.participants || []) {
      if (!tariConcerneServeur(s, mid) || etatTariServeur(s, mid) === "maitrise" || !actif(membres.get(mid))) continue;
      const envois = (taris.get(sid + "~" + mid) || {}).envois || [], dernier = envois[envois.length - 1];
      const enAttente = dernier && !dernier.verdict;
      if (mid === membre && !enAttente) n++;
      else if (suivi && mid !== membre && enAttente && !(priseActive(dernier) && dernier.prise.par !== membre)) n++;
    }
  }
  if (c.admin) n += Object.keys((await comptes.demandes()) || {}).length;
  if (suivi) {
    const dw = (((await stock.lireDoc("reglages", "kourels")) || {}).dieuwrigne) || {};
    for (const ch of await stock.lireCollection("chants")) {
      const info = infoChant(ch.id);
      if (info && info.date >= aujourdhui() && (c.admin || dw[kourelDecideur(info)] === membre)) n += (ch.data.items || []).filter((x) => x.statut === "propose").length;
    }
  }
  return n;
}
/* Tari demandé dans une séance : on attend 90 secondes que le Conservatoire ait fini de choisir (mode, membres, khassida),
   puis on prévient les nouveaux concernés, une seule fois par séance. */
const tarisEnAttente = new Map();
function concernesTari(s) {
  return new Set(s ? (s.participants || []).filter((m) => tariConcerneServeur(s, m) && etatTariServeur(s, m) !== "maitrise") : []);
}
function planifierTari(sid, avant) {
  const p = tarisEnAttente.get(sid);
  if (p) clearTimeout(p.minuteur);
  const debut = p ? p.avant : concernesTari(avant);
  tarisEnAttente.set(sid, { avant: debut, minuteur: setTimeout(() => annoncerTari(sid, debut).catch((e) => console.error(e)), Number(process.env.DELAI_NOTIF_TARI || 90000)) });
}
async function annoncerTari(sid, avant) {
  tarisEnAttente.delete(sid);
  const s = await stock.lireDoc("seances", sid);
  if (!s) return;
  const deja = ((await stock.lireDoc("_notifsTaris", sid)) || {}).membres || {};
  const membres = new Map((await stock.lireCollection("membres")).map((d) => [d.id, d.data]));
  const nouveaux = [...concernesTari(s)].filter((m) => !avant.has(m) && !deja[m] && actif(membres.get(m)));
  if (!nouveaux.length) return;
  const td = s.tariDetail || {}, kh = td.khassida && nomValide(td.khassida) ? await stock.lireDoc("khassidas", td.khassida) : null;
  const plage = td.tout ? "khassida entier" : td.de ? (td.a && Number(td.a) !== Number(td.de) ? "beuyites " + td.de + " à " + td.a : "beuyite " + td.de) : "";
  await stock.ecrireDoc("_notifsTaris", sid, { membres: Object.assign({}, deja, Object.fromEntries(nouveaux.map((m) => [m, Date.now()]))) });
  await notifs.notifier(nouveaux, { titre: "🎙️ Tari à enregistrer", texte: [kh ? kh.titre : "", plage, td.consigne].filter(Boolean).join(" · ") || "Le Conservatoire vous demande un Tari.", url: "/#tari/" + encodeURIComponent(sid) });
}

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

/* ---------- Taris enregistrés sur la plateforme ----------
   taris/{séance~membre} = { seance, membre, date, type, envois: [{ id, fichier, mime, taille, duree, le,
     khassida, titre, de, a, tout, consigne,              ← ce qui était demandé au moment de l'envoi
     prise: { par, nom, le } | null,                       ← membre du Conservatoire qui l'écoute (les autres voient « pris par … »)
     verdict: null | "maitrise" | "retravailler", mot, par, parNom, corrigeLe }] }
   Le membre envoie ; un envoi pas encore écouté peut être remplacé. Le Conservatoire « prend » le dernier envoi,
   l'écoute et répond : la réponse met à jour l'état du Tari de la séance (tariEtat), comme les boutons de la séance. */
const PRISE_MS = 45 * 60000;          // une prise oubliée se libère seule après 45 minutes
const MAX_AUDIO = 40 * 1024 * 1024;   // 40 Mo par envoi
const TYPES_AUDIO = { webm: "audio/webm", m4a: "audio/mp4", ogg: "audio/ogg", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac" };
// Nom d'un fichier audio : <membre>--<32 caractères aléatoires>.<format> (le membre se lit dans le nom : contrôle d'accès simple).
const FICHIER_AUDIO = /^(.+)--[0-9a-f]{32}\.(webm|m4a|ogg|mp3|wav|aac)$/;
function tariConcerneServeur(s, id) {
  const t = s.tari || "aucun";
  if (t === "aucun" || !(s.participants || []).includes(id)) return false;
  if (t === "tous" || (s.tariIndividuel || {})[id]) return true;
  if (t === "choisis") return !!(s.tariChoisis || {})[id];
  return ((s.statuts || {})[id] || "P") === "A";
}
const etatTariServeur = (s, id) => (s.tariEtat || {})[id] || ((s.tariRecu || {})[id] ? "maitrise" : "attendu");
const priseActive = (e) => !!(e && e.prise && Date.now() - e.prise.le < PRISE_MS);
// Format reconnu d'après les premiers octets (jamais d'après ce que le navigateur annonce).
function formatAudio(b) {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (b.toString("latin1", 4, 8) === "ftyp") return "m4a";
  if (b.toString("latin1", 0, 4) === "OggS") return "ogg";
  if (b.toString("latin1", 0, 5) === "#!AMR") return "amr";   // vieux enregistreurs Android : converti en m4a, sinon refusé
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE") return "wav";
  if (b.toString("latin1", 0, 3) === "ID3") return "mp3";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return (b[1] & 0x06) === 0 ? "aac" : "mp3";
  return null;
}
/* Réception d'un fichier envoyé tel quel (sans JSON), avec une taille maximale. */
function recevoirFichier(req, cible, max) {
  return new Promise((ok, ko) => {
    let taille = 0, tete = Buffer.alloc(0), fini = false;
    const out = fs.createWriteStream(cible);
    const echec = (code) => {
      if (fini) return;
      fini = true; req.unpipe(out); out.destroy();
      fsp.rm(cible, { force: true }).finally(() => ko(Object.assign(new Error(code), { code })));
    };
    req.on("data", (c) => {
      taille += c.length;
      if (tete.length < 16) tete = Buffer.concat([tete, c.subarray(0, 16 - tete.length)]);
      if (taille > max) { echec("trop_gros"); req.destroy(); }
    });
    req.on("aborted", () => echec("interrompu"));
    req.on("error", () => echec("interrompu"));
    out.on("error", () => echec("disque"));
    out.on("finish", () => { if (!fini) { fini = true; ok({ taille, tete }); } });
    req.pipe(out);
  });
}
/* debit : 96k pour les Taris, 48k pour les audios des répétitions ; maxSecondes : durée gardée au plus (0 = tout). */
function convertirEnM4a(source, cible, debit = "96k", maxSecondes = 0) {
  return new Promise((ok) => {
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", debit];
    if (maxSecondes) args.push("-t", String(maxSecondes));
    args.push("-movflags", "+faststart", cible);
    const p = spawn(FFMPEG, args, { stdio: "ignore" });
    const minuteur = setTimeout(() => p.kill("SIGKILL"), maxSecondes ? 600000 : 120000);
    p.on("error", () => { clearTimeout(minuteur); ok(false); });
    p.on("exit", (c) => { clearTimeout(minuteur); ok(c === 0); });
  });
}
/* Reçoit un audio (corps de la requête), vérifie son format, le convertit en m4a si ffmpeg est là.
   prefixe = le membre à qui il appartient (il pourra l'écouter). Renvoie { fichier, taille } ou { erreur, code, message }. */
async function enregistrerAudio(req, prefixe) {
  if (Number(req.headers["content-length"] || 0) > MAX_AUDIO) return { erreur: 413, code: "trop_gros", message: "Fichier trop lourd : 40 Mo au plus." };
  const tmp = path.join(AUDIOS, ".recu-" + crypto.randomBytes(8).toString("hex"));
  let recu;
  try { recu = await recevoirFichier(req, tmp, MAX_AUDIO); }
  catch (e) { return { erreur: e.code === "trop_gros" ? 413 : 400, code: e.code, message: e.code === "trop_gros" ? "Fichier trop lourd : 40 Mo au plus." : "L’envoi a été interrompu. Réessayez.", coupe: true }; }
  const fmt = formatAudio(recu.tete);
  if (recu.taille < 1000 || !fmt) {
    await fsp.rm(tmp, { force: true });
    return { erreur: 415, code: "format", message: recu.taille < 1000 ? "L’enregistrement est vide : recommencez." : "Ce fichier n’est pas un audio reconnu (m4a, mp3, ogg, wav, 3gp ou amr)." };
  }
  const base = prefixe + "--" + crypto.randomBytes(16).toString("hex");
  let fichier = base + "." + fmt, taille = recu.taille;
  if (ffmpegDispo && await convertirEnM4a(tmp, path.join(AUDIOS, base + ".m4a"))) {
    fichier = base + ".m4a";
    taille = (await fsp.stat(path.join(AUDIOS, fichier))).size;
    await fsp.rm(tmp, { force: true });
  } else {
    if (ffmpegDispo) await fsp.rm(path.join(AUDIOS, base + ".m4a"), { force: true });
    // AMR : aucun navigateur ne sait le lire ; sans conversion possible, on le refuse.
    if (fmt === "amr") { await fsp.rm(tmp, { force: true }); return { erreur: 415, code: "format", message: "Ce format d’enregistrement (AMR) n’a pas pu être converti : enregistrez directement sur la plateforme." }; }
    await fsp.rename(tmp, path.join(AUDIOS, fichier));
  }
  return { fichier, taille };
}
const dureeDe = (req) => Math.max(0, Math.min(3600, Math.round(10 * (Number(new URL(req.url, "http://x").searchParams.get("duree")) || 0)) / 10));

/* ----- Audios des répétitions (collection audiosSeances, fichiers dans AUDIOS/seances/<id>.m4a) -----
   Le Conservatoire et l'admin en ajoutent dans une séance (enregistrés sur place ou envoyés : Dictaphone, audio WhatsApp).
   Compressés en mono 48 kb/s (assez pour la voix et le chant : environ 22 Mo par heure), 30 minutes au plus par audio.
   Gardés 1 an après la répétition puis effacés automatiquement, sauf ceux épinglés (choix de l'utilisateur, 26 novembre 2026). */
const MAX_AUDIO_SEANCE = 100 * 1024 * 1024;
const DUREE_MAX_SEANCE = 30 * 60;
const ID_AUDIO_SEANCE = /^[0-9a-f]{32}$/;
const NOMS_SEANCES = { k1: "Kourel 1", k2: "Kourel 2", rg: "Répétition générale" };
async function enregistrerAudioSeance(req, id) {
  const tropGros = { erreur: 413, code: "trop_gros", message: "Fichier trop lourd : 100 Mo au plus." };
  if (Number(req.headers["content-length"] || 0) > MAX_AUDIO_SEANCE) return tropGros;
  const tmp = path.join(AUDIOS_SEANCES, ".recu-" + id), cible = path.join(AUDIOS_SEANCES, id + ".m4a");
  let recu;
  try { recu = await recevoirFichier(req, tmp, MAX_AUDIO_SEANCE); }
  catch (e) { return e.code === "trop_gros" ? { ...tropGros, coupe: true } : { erreur: 400, code: e.code, message: "L’envoi a été interrompu. Réessayez.", coupe: true }; }
  const fmt = formatAudio(recu.tete);
  if (recu.taille < 1000 || !fmt) {
    await fsp.rm(tmp, { force: true });
    return { erreur: 415, code: "format", message: recu.taille < 1000 ? "L’enregistrement est vide : recommencez." : "Ce fichier n’est pas un audio reconnu (m4a, mp3, ogg, wav, 3gp ou amr)." };
  }
  if (ffmpegDispo && await convertirEnM4a(tmp, cible, "48k", DUREE_MAX_SEANCE)) {
    await fsp.rm(tmp, { force: true });
    return { fichier: id + ".m4a", taille: (await fsp.stat(cible)).size };
  }
  if (ffmpegDispo) await fsp.rm(cible, { force: true });
  if (fmt === "amr") { await fsp.rm(tmp, { force: true }); return { erreur: 415, code: "format", message: "Ce format d’enregistrement (AMR) n’a pas pu être converti : enregistrez directement sur la plateforme." }; }
  await fsp.rename(tmp, path.join(AUDIOS_SEANCES, id + "." + fmt));
  return { fichier: id + "." + fmt, taille: recu.taille };
}
/* Qui écoute les audios d'une séance : le Conservatoire, l'admin et la Discipline ; un membre, ceux des répétitions
   de son kourel (répétition générale : les deux kourels) ou d'une séance où il était. */
async function audiosSeancesVisibles(sess, docs) {
  if (peut(sess, "suivi") || sess.discipline) return docs;
  const m = (await stock.lireDoc("membres", sess.membre)) || {};
  const seances = new Map((await stock.lireCollection("seances")).map((x) => [x.id, x.data]));
  return docs.filter((d) => {
    const s = seances.get(d.data.seance);
    if (s && (s.participants || []).includes(sess.membre)) return true;
    return d.data.type === "rg" ? !!(m.k1 || m.k2) : !!m[d.data.type];
  });
}
const dateIso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
/* Date avant laquelle un audio a plus d'un an (decalage en jours : 30 = ceux qui seront effacés dans les 30 jours). */
function limiteConservation(decalage = 0) { const d = new Date(); d.setDate(d.getDate() + decalage); d.setFullYear(d.getFullYear() - 1); return dateIso(d); }
async function supprimerAudioSeance(id, data) {
  if (data && /^[0-9a-f]{32}\.\w+$/.test(data.fichier || "")) await fsp.rm(path.join(AUDIOS_SEANCES, data.fichier), { force: true });
  await stock.supprimerDoc("audiosSeances", id);
  // Ses commentaires partent avec lui.
  for (const c of await stock.lireCollection("commentairesAudios")) if (c.data.audio === id) await stock.supprimerDoc("commentairesAudios", c.id);
}
async function nettoyerAudiosSeances() {
  const limite = limiteConservation(0);
  let n = 0;
  for (const d of await stock.lireCollection("audiosSeances")) {
    if (d.data.epingle || !d.data.date || d.data.date >= limite) continue;
    await supprimerAudioSeance(d.id, d.data); n++;
  }
  // Commentaires sur l'ensemble d'une séance de plus d'un an (ceux d'un audio partent avec lui).
  for (const c of await stock.lireCollection("commentairesAudios")) if (!c.data.audio && String(c.data.seance || "").slice(0, 10) < limite) { await stock.supprimerDoc("commentairesAudios", c.id); prevenir("commentairesAudios"); }
  if (n) { prevenir("audiosSeances"); prevenir("commentairesAudios"); console.log(n + " audio(s) de répétition de plus d’un an effacé(s)."); }
}
setTimeout(() => nettoyerAudiosSeances().catch((e) => console.error(e)), 30000);
setInterval(() => nettoyerAudiosSeances().catch((e) => console.error(e)), 6 * 3600000);
/* Chaque audio porte le nom de son khassida et son ère (demande de l'utilisateur), plus une précision facultative (titre). */
const libelleAudio = (d) => (d.khTitre || d.titre || "Audio") + (d.khTitre && d.titre ? ", " + d.titre : "") + (d.ere ? " (ère " + d.ere + ")" : "");
/* Nom lisible d'un audio (téléchargement, zip, WhatsApp) : « 2026-11-20 Kourel 2 - Zallat, beuyites 1 à 4 (ère Serigne Cissé) ». */
const nomAudioSeance = (d) => (d.date + " " + (NOMS_SEANCES[d.type] || "") + " - " + libelleAudio(d)).replace(/[\/\\:*?"<>|\r\n]+/g, "-").replace(/\s+/g, " ").trim();
/* Nouvel audio : tous ceux qui peuvent l'écouter sont prévenus (demande de l'utilisateur), sauf celui qui l'a ajouté.
   Plusieurs audios ajoutés à la suite dans une même séance partent en une seule notification, 90 secondes après le dernier. */
const audiosAAnnoncer = new Map();
function annoncerAudioSeance(sid, id) {
  const e = audiosAAnnoncer.get(sid) || { ids: new Set(), minuteur: null };
  e.ids.add(id);
  clearTimeout(e.minuteur);
  e.minuteur = setTimeout(() => { audiosAAnnoncer.delete(sid); envoyerAnnonceAudios(sid, [...e.ids]).catch((er) => console.error(er)); }, Number(process.env.DELAI_NOTIF_AUDIO || 90000));
  audiosAAnnoncer.set(sid, e);
}
async function envoyerAnnonceAudios(sid, ids) {
  const docs = (await Promise.all(ids.map((id) => stock.lireDoc("audiosSeances", id)))).filter(Boolean);
  if (!docs.length) return;
  const s = (await stock.lireDoc("seances", sid)) || {}, t = docs[0].type;
  const membres = new Map((await stock.lireCollection("membres")).map((d) => [d.id, d.data]));
  const auteurs = new Set(docs.map((d) => d.par)), dest = [];
  for (const c of await stock.lireCollection("_comptes")) {
    const m = membres.get(c.id);
    if (!m || !actif(m) || (auteurs.size === 1 && auteurs.has(c.id))) continue;
    if (c.data.admin || c.data.conservatoire || c.data.discipline || (s.participants || []).includes(c.id) || (t === "rg" ? (m.k1 || m.k2) : m[t])) dest.push(c.id);
  }
  const jour = new Date(docs[0].date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  await notifs.notifier(dest, {
    titre: docs.length === 1 ? "🎧 Nouvel audio de la répétition" : "🎧 " + docs.length + " nouveaux audios de la répétition",
    texte: ((NOMS_SEANCES[t] || "Répétition") + " du " + jour + " : " + docs.map(libelleAudio).join(" · ")).slice(0, 180),
    url: "/#audios"
  });
}
const dispo = (nom) => "attachment; filename=\"" + nom.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "") + "\"; filename*=UTF-8''" + encodeURIComponent(nom);
/* Place prise par un dossier (fichiers seulement, sans les envois en cours). */
async function tailleDossier(dir) {
  let octets = 0, fichiers = 0;
  for (const f of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!f.isFile() || f.name.startsWith(".")) continue;
    try { octets += (await fsp.stat(path.join(dir, f.name))).size; fichiers++; } catch { /* effacé entre-temps */ }
  }
  return { octets, fichiers };
}
/* Zip sans compression (les m4a le sont déjà), écrit au fil de l'eau : ni fichier temporaire, ni mémoire. */
const TABLE_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf, crc = 0) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf, crc);
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function envoyerZip(res, nomZip, fichiers) {
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": dispo(nomZip), "Cache-Control": "no-store" });
  const maintenant = new Date();
  const heure = (maintenant.getHours() << 11) | (maintenant.getMinutes() << 5) | Math.floor(maintenant.getSeconds() / 2);
  const jour = ((maintenant.getFullYear() - 1980) << 9) | ((maintenant.getMonth() + 1) << 5) | maintenant.getDate();
  let position = 0;
  const ecrire = (b) => new Promise((ok, ko) => {
    if (res.destroyed) return ko(new Error("ferme"));
    position += b.length;
    if (res.write(b)) return ok();
    const suite = () => { res.off("drain", suite); res.off("close", suite); res.destroyed ? ko(new Error("ferme")) : ok(); };
    res.on("drain", suite); res.on("close", suite);
  });
  const central = [];
  try {
    for (const f of fichiers) {
      const nom = Buffer.from(f.nom, "utf8"), debut = position;
      const entete = Buffer.alloc(30);
      entete.writeUInt32LE(0x04034b50, 0); entete.writeUInt16LE(20, 4); entete.writeUInt16LE(0x0808, 6);   // descripteur après les données + noms en UTF-8
      entete.writeUInt16LE(0, 8); entete.writeUInt16LE(heure, 10); entete.writeUInt16LE(jour, 12); entete.writeUInt16LE(nom.length, 26);
      await ecrire(entete); await ecrire(nom);
      let crc = 0, taille = 0;
      for await (const morceau of fs.createReadStream(f.chemin)) { crc = crc32(morceau, crc); taille += morceau.length; await ecrire(morceau); }
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc >>> 0, 4); desc.writeUInt32LE(taille, 8); desc.writeUInt32LE(taille, 12);
      await ecrire(desc);
      central.push({ nom, crc, taille, debut });
    }
    const debutCentral = position;
    for (const c of central) {
      const e = Buffer.alloc(46);
      e.writeUInt32LE(0x02014b50, 0); e.writeUInt16LE(20, 4); e.writeUInt16LE(20, 6); e.writeUInt16LE(0x0808, 8); e.writeUInt16LE(0, 10);
      e.writeUInt16LE(heure, 12); e.writeUInt16LE(jour, 14); e.writeUInt32LE(c.crc >>> 0, 16); e.writeUInt32LE(c.taille, 20); e.writeUInt32LE(c.taille, 24);
      e.writeUInt16LE(c.nom.length, 28); e.writeUInt32LE(c.debut, 42);
      await ecrire(e); await ecrire(c.nom);
    }
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(central.length, 8); fin.writeUInt16LE(central.length, 10);
    fin.writeUInt32LE(position - debutCentral, 12); fin.writeUInt32LE(debutCentral, 16);
    await ecrire(fin);
    res.end();
  } catch { if (!res.destroyed) res.destroy(); }
}
/* Un seul traitement à la fois par dossier de Tari (deux membres du Conservatoire qui le prennent en même temps). */
const verrous = new Map();
function sousVerrou(cle, fn) {
  const suite = (verrous.get(cle) || Promise.resolve()).then(() => fn());
  const fin = suite.catch(() => {});
  verrous.set(cle, fin);
  fin.then(() => { if (verrous.get(cle) === fin) verrous.delete(cle); });
  return suite;
}
/* 30 envois d'audio par heure et par membre. */
const envoisAudio = new Map();
function tropDAudios(membre) {
  const e = envoisAudio.get(membre);
  if (!e || Date.now() - e.t > 3600000) { envoisAudio.set(membre, { n: 1, t: Date.now() }); return false; }
  return ++e.n > 30;
}
/* Envoi d'un fichier du disque, avec la lecture par morceaux (Range) : indispensable pour avancer dans un audio. */
async function envoyerFichier(req, res, cible, type, cache) {
  let st;
  try { st = await fsp.stat(cible); } catch { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Introuvable"); }
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let debut = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
    let fin = range[1] !== "" && range[2] !== "" ? Number(range[2]) : st.size - 1;
    if (isNaN(debut) || debut < 0 || debut >= st.size || fin < debut) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
    fin = Math.min(fin, st.size - 1);
    res.writeHead(206, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${debut}-${fin}/${st.size}`, "Content-Length": fin - debut + 1, "Cache-Control": cache });
    return fs.createReadStream(cible, { start: debut, end: fin }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": st.size, "Cache-Control": cache });
  fs.createReadStream(cible).pipe(res);
}

/* Ce qu'un membre (non administrateur) peut voir. */
function filtrerPourMembre(col, docs, moi, discipline, mesSeances) {
  if (col === "membres") return docs.map((d) => ({ id: d.id, data: { nom: d.data.nom, k1: d.data.k1, k2: d.data.k2, statut: d.data.statut, actif: d.data.actif, depuis: d.data.depuis } }));
  if (col === "evaluations") return docs.filter((d) => d.id === moi);
  if (col === "seances") return docs.map((d) => {
    const s = { ...d.data };
    if (s.prevenus) { const p = {}; for (const k of Object.keys(s.prevenus)) p[k] = s.prevenus[k] ? (k === moi ? s.prevenus[k] : { motif: "", note: "" }) : s.prevenus[k]; s.prevenus = p; }
    if (s.discipline && !discipline) s.discipline = s.discipline[moi] ? { [moi]: s.discipline[moi] } : {};
    if (s.retardsPrevenus && !discipline) s.retardsPrevenus = s.retardsPrevenus[moi] ? { [moi]: s.retardsPrevenus[moi] } : {};
    return { id: d.id, data: s };
  });
  // Programme de chant : un membre ne voit que ce qui est retenu, sans les propositions ni leurs auteurs.
  if (col === "chants") return docs.map((d) => ({ id: d.id, data: { items: (d.data.items || []).filter((x) => x.statut === "retenu" || (x.statut === "propose" && x.par === moi))
    .map((x) => ({ id: x.id, khassida: x.khassida, titre: x.titre, ere: x.ere, statut: x.statut, propose: !!x.propose,
      parNom: x.propose || x.par === moi ? x.parNom : undefined, par: x.par === moi ? x.par : undefined })) } }));
  // Taris enregistrés : chacun ne voit que les siens. La commission de discipline voit la liste de tous (qui a envoyé,
  // quoi, la réponse « maîtrisé / à retravailler »), sans les audios ni le mot du correcteur : elle n'écoute pas (choix de l'utilisateur).
  if (col === "taris") {
    // Membre : ses Taris en entier ; ceux des autres membres de ses séances (son kourel) réduits à « a envoyé » et
    // à la réponse (maîtrisé / à retravailler), pour motiver chacun à envoyer le sien (choix de l'utilisateur, 25 novembre 2026).
    // Jamais l'audio, le mot ni le vocal du correcteur des autres.
    if (!discipline) return docs.filter((d) => d.data.membre === moi || (mesSeances && mesSeances.has(d.data.seance)))
      .map((d) => d.data.membre === moi ? d : { id: d.id, data: { seance: d.data.seance, membre: d.data.membre, date: d.data.date, type: d.data.type,
        envois: (d.data.envois || []).map((e) => ({ id: e.id, le: e.le, verdict: e.verdict, corrigeLe: e.corrigeLe })) } });
    return docs.map((d) => d.data.membre === moi ? d : { id: d.id, data: { ...d.data, envois: (d.data.envois || []).map((e) => ({
      id: e.id, le: e.le, duree: e.duree, khassida: e.khassida, titre: e.titre, de: e.de, a: e.a, tout: e.tout,
      prise: e.prise, verdict: e.verdict, par: e.par, parNom: e.parNom, corrigeLe: e.corrigeLe })) } });
  }
  return docs;
}

/* Programme de chant : kourels concernés par une clé, et qui décide. */
function infoChant(cle) {
  const m = /^(rep|dz)-(\d{4}-\d{2}-\d{2})-(k1|k2|rg|general)$/.exec(cle);
  return m ? { sorte: m[1], date: m[2], k: m[3], kourels: m[3] === "k1" ? ["k1"] : m[3] === "k2" ? ["k2"] : ["k1", "k2"] } : null;
}
/* Sanctions (tenue, coiffure) : la commission de discipline, le dieuwrigne du kourel de la séance et l'admin.
   Le Conservatoire seul ne sanctionne pas (choix de l'utilisateur, 24 novembre 2026), sauf s'il a aussi la casquette Discipline. */
async function peutSanctionner(sess, s) {
  if (sess.admin || sess.discipline) return true;
  const d = (((await stock.lireDoc("reglages", "kourels")) || {}).dieuwrigne) || {};
  return !!s && d[s.type === "k2" ? "k2" : "k1"] === sess.membre;
}
/* Sanction notée : le membre est prévenu une minute après (le temps de corriger une erreur de toucher). */
const sanctionsEnAttente = new Map();
function planifierSanctions(sid, avant, apres) {
  const a = (avant && avant.discipline) || {}, b = (apres && apres.discipline) || {};
  for (const mid of Object.keys(b)) for (const type of ["tenue", "coiffure"]) {
    if (!(b[mid] || {})[type] || ((a[mid] || {})[type])) continue;
    const cle = sid + "~" + mid + "~" + type;
    clearTimeout(sanctionsEnAttente.get(cle));
    sanctionsEnAttente.set(cle, setTimeout(() => annoncerSanction(sid, mid, type).catch((e) => console.error(e)), Number(process.env.DELAI_NOTIF_SANCTION || 60000)));
  }
}
async function annoncerSanction(sid, mid, type) {
  sanctionsEnAttente.delete(sid + "~" + mid + "~" + type);
  const s = await stock.lireDoc("seances", sid);
  if (!s || !(((s.discipline || {})[mid] || {})[type])) return;
  let texte = "Coiffure non conforme : vous ne participez pas à cette séance.";
  if (type === "tenue") {
    const mois = s.date.slice(0, 7);
    const rang = (await stock.lireCollection("seances")).filter((x) => x.data.date.slice(0, 7) === mois && (x.data.date < s.date || (x.data.date === s.date && x.data.type <= s.type)) && (((x.data.discipline || {})[mid] || {}).tenue)).length;
    texte = rang >= 2 ? "Tenue non conforme, deuxième fois ce mois-ci : vous ne participez pas à cette séance." : "Avertissement : tenue non conforme. Une deuxième fois ce mois-ci écarte de la séance.";
  }
  const jour = new Date(s.date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  await notifs.notifier([mid], { titre: "Commission de discipline", texte: texte + " (répétition du " + jour + ")", url: "/#moi" });
}
/* Qui décide : le dieuwrigne du kourel ; pour la répétition générale et le Kourel général, celui du Kourel 1. */
const kourelDecideur = (info) => (info.k === "k2" ? "k2" : "k1");
async function decideChant(sess, info) {
  if (sess.admin) return true;
  const d = (((await stock.lireDoc("reglages", "kourels")) || {}).dieuwrigne) || {};
  return d[kourelDecideur(info)] === sess.membre;
}

/* Ce qu'un compte voit d'une collection selon son rôle. */
function filtrerPour(sess, col, docs, mesSeances) {
  if (sess.admin) return docs;
  if (peut(sess, "suivi")) {
    // Conservatoire : tout le suivi, mais jamais les numéros WhatsApp des membres.
    if (col === "membres") return docs.map((d) => { const { telephone, ...data } = d.data; return { id: d.id, data }; });
    return docs;
  }
  return filtrerPourMembre(col, docs, sess.membre, sess.discipline, mesSeances);
}

/* Khassidas visibles par un membre (null = tous : administrateur, Conservatoire et commission de discipline).
   Un membre voit : les khassidas de son ou ses kourels, ceux sans kourel indiqué, ceux prévus au programme
   d'une répétition générale à venir (les deux kourels la chantent ensemble) ou d'une répétition à venir de son kourel,
   et ceux d'un Tari qui le concerne et qu'il n'a pas encore maîtrisé (même règle que la page : Tari pour tous,
   pour les absents s'il était absent, ou individuel ; état « maîtrisé » = plus besoin). */
const aujourdhui = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const KOURELS = { k1: ["k1"], k2: ["k2"], k1k2: ["k1", "k2"] };
async function khassidasVisibles(sess) {
  // La commission de discipline suit les Taris de tous les kourels (qui doit quoi, qui l'a maîtrisé) : elle voit tout le répertoire.
  if (peut(sess, "suivi") || sess.discipline) return null;
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
    const kh = s.data.tariDetail && s.data.tariDetail.khassida;
    if (kh && tariConcerneServeur(s.data, sess.membre) && etatTariServeur(s.data, sess.membre) !== "maitrise") ok.add(kh);
  }
  return ok;
}

/* Départ définitif : l'accès du membre est supprimé (déconnecté partout, demande en cours effacée).
   S'il revient, il refait une demande avec le lien du groupe. */
async function apresMembre(col, id, avant) {
  if (col !== "membres" || !id) return;
  const m = await stock.lireDoc("membres", id);
  if (m && avant) await retirerDesSeancesAVenir(id, avant, m);
  if (!m || m.statut !== "parti") return;
  await comptes.revoquer(id); // refusé s'il s'agit du dernier administrateur
  await comptes.refuser(id);
  prevenir("_comptes");
}

/* Un membre retiré d'un kourel, mis en pause ou parti quitte aussi les séances de ce kourel pas encore passées (celle du jour comprise),
   si rien n'a été noté pour lui : l'historique des séances passées ne change pas (remarques de l'utilisateur, 26 et 28 novembre 2026).
   En pause, il garde son accès et voit toujours les activités de son kourel, mais il ne compte plus dans les séances. */
const jourLocal = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.FUSEAU || "America/Toronto" });
async function retirerDesSeancesAVenir(id, avant, m) {
  const actif = (x) => (x.statut || (x.actif === false ? "pause" : "actif")) === "actif";
  const dans = (x, t) => (t === "rg" ? !!(x.k1 || x.k2) : !!x[t]) && actif(x);
  const t0 = jourLocal();
  for (const d of await stock.lireCollection("seances")) {
    const s = d.data;
    if (!s.date || s.date < t0 || !(s.participants || []).includes(id)) continue;
    if (!dans(avant, s.type) || dans(m, s.type)) continue;   // il n'a pas quitté ce kourel
    const note = ((s.statuts || {})[id] || "P") !== "P" || (s.prevenus || {})[id] || (s.retardsPrevenus || {})[id] || (s.discipline || {})[id]
      || (s.tariEtat || {})[id] || (s.tariRecu || {})[id] || (s.tariIndividuel || {})[id] || (s.tariChoisis || {})[id];
    if (note) continue;
    const statuts = { ...(s.statuts || {}) };
    delete statuts[id];
    await stock.ecrireDoc("seances", d.id, { ...s, participants: s.participants.filter((x) => x !== id), statuts });
    prevenir("seances");
  }
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
    admins().then((l) => notifs.notifier(l, { titre: "Nouvelle demande d’accès", texte: m.data.nom + " demande l’accès à la plateforme : à valider.", url: "/#reglages/acces" })).catch((e) => console.error(e));
    return json(res, 200, { ok: true, identifiant: m.id, nom: m.data.nom, telephone: String(corps.telephone).trim() });
  }
  // Visite guidée des onglets : vue une fois par personne (enregistré sur son compte, valable sur tous ses appareils).
  // Nouveautés (bulle affichée une seule fois, ex. « programme ») : enregistrées aussi sur le compte.
  if (parts[0] === "moi" && (parts[1] === "tour" || parts[1] === "vu") && req.method === "POST") {
    if (!sess) return json(res, 401, { code: "non_connecte" });
    if (parts[1] === "tour") await stock.fusionnerDoc("_comptes", sess.membre, { tourVu: Date.now() });
    else {
      const cle = String((await lireCorps(req)).cle || "");
      if (!/^[a-z0-9-]{1,40}$/.test(cle)) return json(res, 400, { code: "invalid_argument" });
      await stock.fusionnerDoc("_comptes", sess.membre, { vu: { [cle]: Date.now() } });
    }
    return json(res, 200, { ok: true });
  }
  if (parts[0] === "moi") {
    if (!sess) return json(res, 200, { connecte: false, aucunCompte: await comptes.aucunCompte() });
    const m = await stock.lireDoc("membres", sess.membre), c = (await stock.lireDoc("_comptes", sess.membre)) || {};
    return json(res, 200, { connecte: true, membre: sess.membre, nom: m ? m.nom : sess.membre, admin: sess.admin, discipline: !!sess.discipline, role: roleDe(sess), doitChanger: sess.temporaire, tourVu: !!c.tourVu, vu: Object.keys(c.vu || {}), k1: !!(m && m.k1), k2: !!(m && m.k2) });
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

  /* --- Notifications sur le téléphone (voir notifications.mjs) --- */
  if (parts[0] === "notifs") {
    if (parts[1] === "cle" && req.method === "GET") return json(res, 200, { cle: notifs.clePublique, abonne: (await notifs.abonnes()).has(sess.membre) });
    if (parts[1] === "resume" && req.method === "GET") {
      const d = (await notifs.dernier(sess.membre)) || {};
      return json(res, 200, { titre: d.titre || "Conservatoire", texte: d.texte || "Du nouveau sur la plateforme.", url: d.url || "/", badge: await badgePour(sess.membre) });
    }
    if (parts[1] === "badge" && req.method === "GET") return json(res, 200, { badge: await badgePour(sess.membre) });
    if (parts[1] === "abonnement" && req.method === "POST") {
      const c = await lireCorps(req);
      if (c.retirer) { await notifs.desabonner(sess.membre, c.endpoint); return json(res, 200, { ok: true }); }
      if (!(await notifs.abonner(sess.membre, c.abonnement))) return json(res, 400, { code: "invalid_argument", message: "Abonnement refusé." });
      return json(res, 200, { ok: true });
    }
    if (parts[1] === "essai" && req.method === "POST") {
      const n = await notifs.notifier([sess.membre], { titre: "🔔 Notifications activées", texte: "Vous serez prévenu ici : Taris à enregistrer ou à écouter, réponses du Conservatoire.", url: "/#moi" });
      return json(res, 200, { ok: true, envoyes: n });
    }
    return json(res, 405, { code: "invalid_argument" });
  }

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
     Idée rendue publique (public: true) : seul l'administrateur décide (choix de l'utilisateur, 24 novembre 2026) ;
     tous les membres voient alors le texte et la réponse, jamais le nom de l'auteur. Le Conservatoire lit et répond, sans publier.
     Support (_support) : un membre signale un souci ; seul l'administrateur le lit et répond.
     Chacun retrouve ses propres envois (avec la réponse) dans Mon espace. */
  if ((parts[0] === "idees" || parts[0] === "support") && !sess.temporaire) {
    const col = "_" + parts[0], id = parts[1], lecteur = parts[0] === "idees" ? peut(sess, "suivi") : sess.admin;
    const noms = Object.fromEntries((await stock.lireCollection("membres")).map((d) => [d.id, d.data.nom]));
    const mesAnonymes = new Set((new URL(req.url, "http://x").searchParams.get("ids") || "").split(",").filter((x) => /^[0-9a-f]{32}$/.test(x)));
    const vue = (d) => {
      const moi = (!!d.data.auteur && d.data.auteur === sess.membre) || (!!d.data.anonyme && mesAnonymes.has(d.id));
      // Idée publique vue par un autre membre : le texte et la réponse seulement, sans auteur.
      if (!lecteur && !moi) return { id: d.id, type: d.data.type, texte: d.data.texte, creeLe: d.data.creeLe, reponse: d.data.reponse, public: true, publieLe: d.data.publieLe, moi: false };
      const x = { id: d.id, ...d.data, moi };
      if (x.anonyme) delete x.auteur;
      if (x.auteur) x.nom = noms[x.auteur] || x.auteur;
      return x;
    };
    if (!id && req.method === "GET") {
      const docs = (await stock.lireCollection(col)).filter((d) => lecteur || d.data.auteur === sess.membre || (d.data.anonyme && mesAnonymes.has(d.id)) || (col === "_idees" && d.data.public));
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
      if (parts[0] === "support") admins().then((l) => notifs.notifier(l.filter((x) => x !== sess.membre), { titre: "🛟 Souci signalé", texte: (noms[sess.membre] || "Un membre") + " : " + texte.slice(0, 120), url: "/#messages" })).catch((e) => console.error(e));
      return json(res, 200, { ok: true, id: nid });
    }
    if (id && req.method === "PATCH") {
      if (!lecteur || !nomValide(id)) return json(res, 403, { code: "invalid_argument", message: "Réservé au Conservatoire." });
      const c = await lireCorps(req), maj = {};
      if (["nouveau", "lu", "traite", "ouvert", "resolu"].includes(c.statut)) maj.statut = c.statut;
      if (typeof c.reponse === "string") { maj.reponse = c.reponse.trim().slice(0, 3000); maj.reponduLe = Date.now(); maj.reponduPar = noms[sess.membre] || sess.membre; }
      if (c.public !== undefined) {
        if (col !== "_idees" || !sess.admin) return json(res, 403, { code: "invalid_argument", message: "Seul l’administrateur peut rendre une idée visible à tous." });
        maj.public = !!c.public; maj.publieLe = c.public ? Date.now() : null; maj.publiePar = c.public ? (noms[sess.membre] || sess.membre) : null;
      }
      if (!(await stock.fusionnerDoc(col, id, maj))) return json(res, 404, { code: "not_found" });
      prevenir(col); return json(res, 200, { ok: true });
    }
    return json(res, 405, { code: "invalid_argument" });
  }

  /* --- Erreurs signalées dans un beuyite (_signalements) ---
     Tout membre connecté signale une erreur depuis la page d'un khassida (texte arabe, phonétique, traduction, audio…).
     Le Conservatoire et l'admin les voient (Mon espace › Boîte à idées › Erreurs signalées), sont prévenus, et les marquent
     « corrigé » ou « pas une erreur » ; la correction elle-même se fait dans la page du khassida. Chacun suit les siens.
       GET   signalements          les siens (tous pour le Conservatoire et l'admin)
       POST  signalements          { dossier, seg, libelle, quoi, texte, extrait }
       PATCH signalements/<id>     { statut: ouvert | corrige | non, reponse } (Conservatoire, admin)
       DELETE signalements/<id>    son auteur le retire, tant que le Conservatoire ne l'a pas traité (statut ouvert) */
  if (parts[0] === "signalements" && !sess.temporaire) {
    const id = parts[1], lecteur = peut(sess, "suivi");
    const noms = Object.fromEntries((await stock.lireCollection("membres")).map((d) => [d.id, d.data.nom]));
    const vue = (d) => ({ id: d.id, ...d.data, nom: noms[d.data.auteur] || d.data.auteur, moi: d.data.auteur === sess.membre });
    if (!id && req.method === "GET") {
      const docs = (await stock.lireCollection("_signalements")).filter((d) => lecteur || d.data.auteur === sess.membre);
      return json(res, 200, { docs: docs.map(vue).sort((x, y) => y.creeLe - x.creeLe), lecteur });
    }
    if (!id && req.method === "POST") {
      const c = await lireCorps(req), texte = String(c.texte || "").trim().slice(0, 2000), dossier = String(c.dossier || "");
      if (texte.length < 3) return json(res, 400, { code: "court", message: "Décrivez l’erreur avant d’envoyer." });
      if (!/^[\w-]+$/.test(dossier)) return json(res, 400, { code: "invalid_argument", message: "Khassida inconnu." });
      const fiche = await fsp.readFile(path.join(PLATEFORME, "khassidas", dossier, "fiche.json"), "utf8").then(JSON.parse, () => null);
      if (!fiche) return json(res, 400, { code: "invalid_argument", message: "Khassida inconnu." });
      if (tropDenvois(sess.membre)) return json(res, 429, { code: "trop", message: "Trop d’envois rapprochés : réessayez dans une heure." });
      const QUOI = ["arabe", "phonetique", "traduction", "audio", "autre"];
      const doc = { auteur: sess.membre, khassida: fiche.id || dossier, dossier, titre: fiche.titre || dossier,
        seg: String(c.seg || "").replace(/[^\w-]/g, "").slice(0, 20), libelle: String(c.libelle || "").slice(0, 60),
        quoi: QUOI.includes(c.quoi) ? c.quoi : "autre", texte, extrait: String(c.extrait || "").slice(0, 400), creeLe: Date.now(), statut: "ouvert" };
      const nid = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
      await stock.ecrireDoc("_signalements", nid, doc); prevenir("_signalements");
      lecteursTaris(sess.membre).then((l) => notifs.notifier(l, { titre: "📖 Erreur signalée", texte: (noms[sess.membre] || "Un membre") + " · " + doc.titre + (doc.libelle ? ", " + doc.libelle.toLowerCase() : "") + " : " + texte.slice(0, 100), url: "/#messages" })).catch((e) => console.error(e));
      return json(res, 200, { ok: true, id: nid });
    }
    if (id && req.method === "PATCH") {
      if (!lecteur || !nomValide(id)) return json(res, 403, { code: "invalid_argument", message: "Réservé au Conservatoire." });
      const c = await lireCorps(req), maj = {};
      if (["ouvert", "corrige", "non"].includes(c.statut)) { maj.statut = c.statut; maj.traiteLe = Date.now(); maj.traitePar = noms[sess.membre] || sess.membre; }
      if (typeof c.reponse === "string") maj.reponse = c.reponse.trim().slice(0, 1000);
      if (!(await stock.fusionnerDoc("_signalements", id, maj))) return json(res, 404, { code: "not_found" });
      prevenir("_signalements"); return json(res, 200, { ok: true });
    }
    if (id && req.method === "DELETE") {
      const d = nomValide(id) ? await stock.lireDoc("_signalements", id) : null;
      if (!d) return json(res, 404, { code: "not_found", message: "Ce signalement n’existe plus." });
      if (d.auteur !== sess.membre) return json(res, 403, { code: "invalid_argument", message: "Seul son auteur peut retirer ce signalement." });
      if (d.statut !== "ouvert") return json(res, 409, { code: "traite", message: "Le Conservatoire a déjà traité ce signalement : il ne peut plus être retiré." });
      await stock.supprimerDoc("_signalements", id);
      prevenir("_signalements"); return json(res, 200, { ok: true });
    }
    return json(res, 405, { code: "invalid_argument" });
  }

  /* --- Programme de chant (répétitions et dahiras) ---
     chants/{clé} = { items: [{ id, khassida, titre, ere, statut: "retenu"|"propose", par, parNom, le }] }
     Clé : rep-AAAA-MM-JJ-(k1|k2|rg) pour une répétition, dz-AAAA-MM-JJ-(k1|k2|general) pour un passage au dahira.
     Le dieuwrigne du kourel (reglages/kourels.dieuwrigne) et l'admin décident : ce qu'ils ajoutent est retenu.
     Un autre membre du Conservatoire propose : sa proposition attend que le dieuwrigne la retienne ou l'écarte. */
  if (parts[0] === "chants" && (parts.length > 2 || req.method !== "GET")) {
    const cle = parts[1] || "", info = infoChant(cle);
    if (!info || !nomValide(cle)) return json(res, 400, { code: "invalid_argument" });
    // Un membre simple propose un khassida pour un événement à venir de son kourel, et peut retirer sa propre proposition.
    if (!peut(sess, "suivi")) {
      const mm = (await stock.lireDoc("membres", sess.membre)) || {};
      const geste = parts[2] === "items" && ((!parts[3] && req.method === "POST") || (parts[3] && req.method === "DELETE"));
      if (!geste) return json(res, 403, { code: "invalid_argument", message: "Seul le dieuwrigne du kourel décide du programme." });
      if (!info.kourels.some((k) => mm[k]) || info.date < aujourdhui()) return json(res, 403, { code: "invalid_argument", message: "Vous pouvez proposer seulement pour un programme à venir de votre kourel." });
    }
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
      const simple = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const deja = items.filter((x) => kh ? x.khassida === String(c.khassida) : simple(x.titre) === simple(titre))[0];
      if (deja) return json(res, 409, { code: "doublon", message: deja.statut === "retenu" ? "Ce khassida est déjà au programme." : "Ce khassida est déjà proposé : le dieuwrigne va décider." });
      if (!decideur && items.filter((x) => x.statut === "propose" && x.par === sess.membre).length >= 3) return json(res, 429, { code: "trop", message: "Vous avez déjà 3 propositions en attente pour ce programme : attendez la décision du dieuwrigne." });
      items.push({ id: crypto.randomBytes(5).toString("hex"), khassida: kh ? String(c.khassida) : "", titre, ere: ere(c.ere !== undefined ? c.ere : kh && kh.ere),
        statut: decideur ? "retenu" : "propose", propose: !decideur, par: sess.membre, parNom: moiNom, le: Date.now() });
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
    if (message === "propose") {
      const dw = (((await stock.lireDoc("reglages", "kourels")) || {}).dieuwrigne) || {};
      let cibles = [dw[kourelDecideur(info)]].filter(Boolean);
      if (!cibles.length) cibles = await admins();
      const jour = new Date(info.date + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      const it = items[items.length - 1];
      notifs.notifier(cibles.filter((x) => x !== sess.membre), { titre: "💡 Proposition pour le programme", texte: moiNom + " propose « " + it.titre + " » pour " + (info.sorte === "rep" ? "la répétition du " : "le dahira du ") + jour + ".", url: "/#dahira" }).catch((e) => console.error(e));
    }
    return json(res, 200, { ok: true, decideur, message });
  }

  /* --- Audios des répétitions (voir plus haut : audiosSeances) ---
     POST   audios-seances/<séance>?duree=&titre=&khassida=   ajouter un audio (corps = le fichier) : Conservatoire, admin
     PATCH  audios-seances/<id>   { titre, khassida, epingle }   ·   DELETE audios-seances/<id>   (Conservatoire, admin)
     GET    audios-seances/fichier/<id>[?dl=1]   écouter ou télécharger (droits : audiosSeancesVisibles)
     GET    audios-seances/zip?seance=<id> | ?bientot=1 (admin : ceux effacés dans les 30 jours)
     GET    audios-seances/espace   place prise sur le disque du serveur (admin) */
  if (parts[0] === "audios-seances") {
    const [, a, b] = parts, q = new URL(req.url, "http://x").searchParams;
    if (a === "fichier" && req.method === "GET" && parts.length === 3) {
      const d = ID_AUDIO_SEANCE.test(b || "") ? await stock.lireDoc("audiosSeances", b) : null;
      if (!d) return json(res, 404, { code: "not_found", message: "Cet audio n’existe plus." });
      if (!(await audiosSeancesVisibles(sess, [{ id: b, data: d }])).length) return json(res, 403, { code: "invalid_argument", message: "Cet audio est réservé au kourel de la répétition." });
      const ext = String(d.fichier || "").split(".").pop();
      if (q.get("dl")) res.setHeader("Content-Disposition", dispo(nomAudioSeance(d) + "." + ext));
      return envoyerFichier(req, res, path.join(AUDIOS_SEANCES, d.fichier), TYPES_AUDIO[ext] || "application/octet-stream", "private, max-age=31536000, immutable");
    }
    if (a === "zip" && req.method === "GET" && parts.length === 2) {
      let docs = await stock.lireCollection("audiosSeances"), nomZip = "";
      if (q.get("seance")) {
        docs = docs.filter((d) => d.data.seance === q.get("seance"));
        nomZip = docs.length ? "Audios " + docs[0].data.date + " " + (NOMS_SEANCES[docs[0].data.type] || "") + ".zip" : "Audios.zip";
      } else if (q.get("bientot") && sess.admin) {
        const lim = limiteConservation(30);
        docs = docs.filter((d) => !d.data.epingle && d.data.date && d.data.date < lim);
        nomZip = "Audios des répétitions effacés bientôt (" + dateIso(new Date()) + ").zip";
      } else return json(res, 400, { code: "invalid_argument" });
      docs = (await audiosSeancesVisibles(sess, docs)).sort((x, y) => (x.data.date < y.data.date ? -1 : x.data.date > y.data.date ? 1 : (x.data.le || 0) - (y.data.le || 0)));
      if (!docs.length) return json(res, 404, { code: "vide", message: "Aucun audio à télécharger." });
      if (docs.reduce((n, d) => n + (d.data.taille || 0), 0) > 3.5e9) return json(res, 413, { code: "trop_gros", message: "Trop d’audios pour un seul fichier : téléchargez-les séance par séance." });
      const vus = new Set();
      const fichiers = docs.map((d) => {
        const base = nomAudioSeance(d.data), ext = String(d.data.fichier || "").split(".").pop();
        let nom = base, k = 2;
        while (vus.has(nom)) nom = base + " (" + k++ + ")";
        vus.add(nom);
        return { nom: nom + "." + ext, chemin: path.join(AUDIOS_SEANCES, d.data.fichier) };
      });
      return envoyerZip(res, nomZip, fichiers);
    }
    if (a === "espace" && req.method === "GET" && parts.length === 2) {
      if (!sess.admin) return json(res, 403, { code: "invalid_argument" });
      const [seancesT, tarisT] = await Promise.all([tailleDossier(AUDIOS_SEANCES), tailleDossier(AUDIOS)]);
      let disque = null;
      try { const st = await fsp.statfs(AUDIOS); disque = { total: st.blocks * st.bsize, libre: st.bavail * st.bsize }; } catch { /* inconnu */ }
      const lim = limiteConservation(30);
      const tous = await stock.lireCollection("audiosSeances");
      return json(res, 200, { seances: seancesT, taris: tarisT, disque, epingles: tous.filter((d) => d.data.epingle).length,
        bientot: tous.filter((d) => !d.data.epingle && d.data.date && d.data.date < lim).length, conservationJours: 365 });
    }
    /* Commentaires (demande de l'utilisateur) : sur un audio, ou sur l'ensemble des audios d'une séance (audio vide).
       Tous ceux qui écoutent les audios de la séance les lisent et en écrivent ; chacun retire les siens, le Conservatoire et l'admin aussi.
       POST audios-seances/commentaires { seance, audio, texte } · DELETE audios-seances/commentaires/<id> */
    if (a === "commentaires") {
      const nomMoi = ((await stock.lireDoc("membres", sess.membre)) || {}).nom || sess.membre;
      if (req.method === "POST" && parts.length === 2) {
        const c = await lireCorps(req), sid = String(c.seance || ""), texte = String(c.texte || "").trim().slice(0, 1000);
        const s = nomValide(sid) ? await stock.lireDoc("seances", sid) : null;
        if (!s) return json(res, 404, { code: "not_found", message: "Cette séance n’existe plus." });
        if (texte.length < 2) return json(res, 400, { code: "court", message: "Écrivez votre commentaire." });
        const audio = String(c.audio || "");
        if (audio) { const ad = ID_AUDIO_SEANCE.test(audio) ? await stock.lireDoc("audiosSeances", audio) : null; if (!ad || ad.seance !== sid) return json(res, 404, { code: "not_found", message: "Cet audio n’existe plus." }); }
        if (!(await audiosSeancesVisibles(sess, [{ id: "x", data: { seance: sid, type: s.type } }])).length) return json(res, 403, { code: "invalid_argument", message: "Réservé au kourel de la répétition." });
        if (tropDenvois(sess.membre)) return json(res, 429, { code: "trop", message: "Trop d’envois rapprochés : réessayez dans une heure." });
        const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
        await stock.ecrireDoc("commentairesAudios", id, { seance: sid, type: s.type, audio, membre: sess.membre, nom: nomMoi, texte, le: Date.now() });
        prevenir("commentairesAudios");
        return json(res, 200, { ok: true, id });
      }
      if (req.method === "DELETE" && parts.length === 3 && nomValide(b || "")) {
        const d = await stock.lireDoc("commentairesAudios", b);
        if (!d) return json(res, 404, { code: "not_found" });
        if (d.membre !== sess.membre && !peut(sess, "suivi")) return json(res, 403, { code: "invalid_argument", message: "Seul son auteur peut retirer ce commentaire." });
        await stock.supprimerDoc("commentairesAudios", b);
        prevenir("commentairesAudios");
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { code: "invalid_argument" });
    }
    if (!peut(sess, "suivi")) return json(res, 403, { code: "invalid_argument", message: "Seuls le Conservatoire et l’admin ajoutent les audios des répétitions." });
    const moiNom = ((await stock.lireDoc("membres", sess.membre)) || {}).nom || sess.membre;
    if (req.method === "POST" && parts.length === 2) {
      const s = nomValide(a || "") ? await stock.lireDoc("seances", a) : null;
      if (!s) return json(res, 404, { code: "not_found", message: "Cette séance n’existe plus." });
      // Le khassida (de la liste, ou son nom s'il n'y est pas encore) et son ère : obligatoires, vérifiés avant de recevoir le fichier.
      const khId = String(q.get("khassida") || ""), kh = khId && nomValide(khId) ? await stock.lireDoc("khassidas", khId) : null;
      const nomKh = kh ? kh.titre : String(q.get("nom") || "").trim().slice(0, 120), ere = String(q.get("ere") || "").trim().slice(0, 80) || (kh && kh.ere) || "";
      if (!nomKh) return json(res, 400, { code: "khassida", message: "Choisissez le khassida de l’audio (ou écrivez son nom)." });
      if (!ere) return json(res, 400, { code: "ere", message: "Indiquez l’ère du khassida." });
      if (tropDAudios(sess.membre)) return json(res, 429, { code: "rate_limited", message: "Beaucoup d’envois rapprochés : réessayez dans une heure." });
      const id = crypto.randomBytes(16).toString("hex");
      const au = await enregistrerAudioSeance(req, id);
      if (au.erreur) { if (au.coupe && (res.destroyed || req.destroyed)) return; return json(res, au.erreur, { code: au.code, message: au.message }); }
      const doc = { seance: a, date: s.date, type: s.type, khassida: kh ? khId : "", khTitre: nomKh, ere, titre: String(q.get("titre") || "").trim().slice(0, 120),
        duree: Math.min(DUREE_MAX_SEANCE, dureeDe(req)), taille: au.taille, fichier: au.fichier, par: sess.membre, parNom: moiNom, le: Date.now(), epingle: false };
      await stock.ecrireDoc("audiosSeances", id, doc);
      prevenir("audiosSeances");
      annoncerAudioSeance(a, id);
      return json(res, 200, { ok: true, id, audio: doc });
    }
    if (parts.length !== 2 || !ID_AUDIO_SEANCE.test(a || "")) return json(res, 400, { code: "invalid_argument" });
    const d = await stock.lireDoc("audiosSeances", a);
    if (!d) return json(res, 404, { code: "not_found", message: "Cet audio n’existe plus." });
    if (req.method === "PATCH") {
      const c = await lireCorps(req), maj = {};
      if (typeof c.khassida === "string" || typeof c.nom === "string") {
        const kh = c.khassida && nomValide(c.khassida) ? await stock.lireDoc("khassidas", c.khassida) : null;
        const nomKh = kh ? kh.titre : String(c.nom || "").trim().slice(0, 120);
        if (!nomKh) return json(res, 400, { code: "khassida", message: "Choisissez le khassida de l’audio (ou écrivez son nom)." });
        maj.khassida = kh ? c.khassida : ""; maj.khTitre = nomKh;
      }
      if (typeof c.ere === "string") {
        if (!c.ere.trim()) return json(res, 400, { code: "ere", message: "Indiquez l’ère du khassida." });
        maj.ere = c.ere.trim().slice(0, 80);
      }
      if (typeof c.titre === "string") maj.titre = c.titre.trim().slice(0, 120);
      if (typeof c.epingle === "boolean") { maj.epingle = c.epingle; maj.epinglePar = c.epingle ? moiNom : null; }
      await stock.fusionnerDoc("audiosSeances", a, maj);
      prevenir("audiosSeances");
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE") { await supprimerAudioSeance(a, d); prevenir("audiosSeances"); return json(res, 200, { ok: true }); }
    return json(res, 405, { code: "invalid_argument" });
  }

  /* --- Taris enregistrés (voir plus haut : taris/{séance~membre}) ---
     GET  taris/audio/<fichier>      écouter : le membre lui-même, le Conservatoire, l'admin
     POST taris/<séance>/envoi       le membre envoie son audio (corps = le fichier), ?duree=secondes
     POST taris/<dossier>/prise      le Conservatoire prend le Tari ({ liberer: true } pour le laisser)
     POST taris/<dossier>/vocal      le correcteur envoie sa réponse vocale (corps = le fichier), ?duree=secondes
     POST taris/<dossier>/verdict    { envoi, verdict: maitrise | retravailler, mot, vocal: { fichier, duree } } */
  if (parts[0] === "taris" && (parts.length > 2 || req.method !== "GET")) {
    const [, a, b] = parts;
    if (a === "audio" && req.method === "GET" && parts.length === 3) {
      const m = FICHIER_AUDIO.exec(b || "");
      if (!m || !nomValide(b)) return json(res, 404, { code: "not_found" });
      if (!peut(sess, "suivi") && m[1] !== sess.membre) return json(res, 403, { code: "invalid_argument", message: "Cet audio ne vous appartient pas." });
      return envoyerFichier(req, res, path.join(AUDIOS, b), TYPES_AUDIO[m[2]], "private, max-age=31536000, immutable");
    }
    if (parts.length !== 3 || req.method !== "POST" || !nomValide(a || "")) return json(res, 405, { code: "invalid_argument" });
    const moiNom = ((await stock.lireDoc("membres", sess.membre)) || {}).nom || sess.membre;

    if (b === "envoi") {
      const sid = a, moi = sess.membre, s = await stock.lireDoc("seances", sid);
      if (!s) return json(res, 404, { code: "not_found", message: "Cette séance n’existe plus." });
      if (!tariConcerneServeur(s, moi)) return json(res, 403, { code: "pas_concerne", message: "Ce Tari ne vous est pas demandé." });
      if (etatTariServeur(s, moi) === "maitrise") return json(res, 409, { code: "maitrise", message: "Ce Tari est déjà maîtrisé : rien à renvoyer." });
      if (tropDAudios(moi)) return json(res, 429, { code: "rate_limited", message: "Beaucoup d’envois rapprochés : réessayez dans une heure." });
      const au = await enregistrerAudio(req, moi);
      if (au.erreur) { if (au.coupe && (res.destroyed || req.destroyed)) return; return json(res, au.erreur, { code: au.code, message: au.message }); }
      const fichier = au.fichier, taille = au.taille, duree = dureeDe(req);
      const docId = sid + "~" + moi;
      const r = await sousVerrou(docId, async () => {
        const d = (await stock.lireDoc("taris", docId)) || {};
        const envois = d.envois || [], dernier = envois[envois.length - 1];
        let remplace = null;
        // Un envoi pas encore écouté est remplacé par le nouveau ; s'il est en cours d'écoute, on attend la réponse.
        if (dernier && !dernier.verdict) {
          if (priseActive(dernier)) return { erreur: 409, code: "en_ecoute", message: (dernier.prise.nom || "Un membre du Conservatoire") + " écoute votre envoi en ce moment : attendez sa réponse avant d’en renvoyer un." };
          remplace = envois.pop();
        }
        if (envois.length >= 40) return { erreur: 400, code: "trop", message: "Trop d’envois pour ce Tari : contactez le Conservatoire." };
        const td = s.tariDetail || {}, kh = td.khassida && nomValide(td.khassida) ? await stock.lireDoc("khassidas", td.khassida) : null;
        const envoi = { id: crypto.randomBytes(5).toString("hex"), fichier, mime: TYPES_AUDIO[fichier.split(".").pop()], taille, duree, le: Date.now(),
          khassida: td.khassida || "", titre: kh ? kh.titre : "", de: td.de || null, a: td.a || null, tout: !!td.tout, consigne: td.consigne || "", prise: null, verdict: null };
        envois.push(envoi);
        await stock.ecrireDoc("taris", docId, { seance: sid, membre: moi, date: s.date, type: s.type, envois, majLe: Date.now() });
        return { envoi, remplace };
      });
      if (r.erreur) { await fsp.rm(path.join(AUDIOS, fichier), { force: true }); return json(res, r.erreur, { code: r.code, message: r.message }); }
      if (r.remplace && FICHIER_AUDIO.test(r.remplace.fichier || "")) await fsp.rm(path.join(AUDIOS, r.remplace.fichier), { force: true });
      prevenir("taris");
      if (!r.remplace) lecteursTaris(moi).then((l) => notifs.notifier(l, { titre: "🎧 Tari à écouter", texte: moiNom + " a envoyé son Tari" + (r.envoi.titre ? " · " + r.envoi.titre : ""), url: "/#taris" })).catch((e) => console.error(e));
      return json(res, 200, { ok: true, envoi: r.envoi, remplace: !!r.remplace });
    }

    if (b === "vocal") {
      if (!peut(sess, "suivi")) return json(res, 403, { code: "invalid_argument", message: "Réservé au Conservatoire." });
      const d = await stock.lireDoc("taris", a);
      if (!d) return json(res, 404, { code: "not_found", message: "Ce Tari n’existe plus." });
      if (d.membre === sess.membre) return json(res, 403, { code: "soi", message: "Votre propre Tari est écouté par un autre membre du Conservatoire." });
      if (tropDAudios(sess.membre)) return json(res, 429, { code: "rate_limited", message: "Beaucoup d’envois rapprochés : réessayez dans une heure." });
      const au = await enregistrerAudio(req, d.membre);
      if (au.erreur) { if (au.coupe && (res.destroyed || req.destroyed)) return; return json(res, au.erreur, { code: au.code, message: au.message }); }
      return json(res, 200, { ok: true, fichier: au.fichier, duree: dureeDe(req) });
    }

    if (b === "prise" || b === "verdict") {
      if (!peut(sess, "suivi")) return json(res, 403, { code: "invalid_argument", message: "Réservé au Conservatoire." });
      const docId = a, c = await lireCorps(req);
      if (b === "verdict" && !["maitrise", "retravailler"].includes(c.verdict)) return json(res, 400, { code: "invalid_argument" });
      // Vocal joint à la réponse : un fichier déjà reçu (route « vocal ») au nom de ce membre.
      let vocal = null;
      if (b === "verdict" && c.vocal && c.vocal.fichier) {
        const mv = FICHIER_AUDIO.exec(String(c.vocal.fichier));
        const membreDoc = String(a).split("~")[1];
        if (!mv || mv[1] !== membreDoc || !(await fsp.stat(path.join(AUDIOS, c.vocal.fichier)).catch(() => null))) return json(res, 400, { code: "vocal", message: "Le vocal n’a pas été reçu : réenregistrez-le." });
        vocal = { fichier: String(c.vocal.fichier), duree: Math.max(0, Math.min(3600, Number(c.vocal.duree) || 0)) };
      }
      const r = await sousVerrou(docId, async () => {
        const d = await stock.lireDoc("taris", docId);
        const envois = (d && d.envois) || [], e = envois[envois.length - 1];
        if (!e) return { erreur: 404, code: "not_found", message: "Aucun envoi pour ce Tari." };
        if (d.membre === sess.membre) return { erreur: 403, code: "soi", message: "Votre propre Tari est écouté par un autre membre du Conservatoire." };
        const autre = priseActive(e) && e.prise.par !== sess.membre ? e.prise : null;
        if (b === "prise") {
          if (c.liberer) { if (e.prise && (e.prise.par === sess.membre || sess.admin)) e.prise = null; }
          else {
            if (e.verdict) return { erreur: 409, code: "corrige", message: "Ce Tari a déjà reçu une réponse." };
            if (autre) return { erreur: 409, code: "pris", message: autre.nom + " écoute déjà ce Tari.", prise: autre };
            e.prise = { par: sess.membre, nom: moiNom, le: Date.now() };
          }
        } else {
          if (c.envoi && c.envoi !== e.id) return { erreur: 409, code: "nouvel_envoi", message: "Le membre vient d’envoyer une nouvelle version : écoutez-la d’abord." };
          if (autre) return { erreur: 409, code: "pris", message: autre.nom + " écoute ce Tari : c’est à lui de répondre." };
          if (e.vocal && (!vocal || vocal.fichier !== e.vocal.fichier)) fsp.rm(path.join(AUDIOS, e.vocal.fichier), { force: true }).catch(() => {});
          Object.assign(e, { verdict: c.verdict, mot: String(c.mot || "").trim().slice(0, 1000), vocal, par: sess.membre, parNom: moiNom, corrigeLe: Date.now(), prise: null });
        }
        await stock.ecrireDoc("taris", docId, { ...d, envois, majLe: Date.now() });
        return { d, e };
      });
      if (r.erreur) return json(res, r.erreur, { code: r.code, message: r.message, prise: r.prise });
      // La réponse met à jour l'état du Tari sur la séance (les mêmes champs que les boutons de la séance).
      if (b === "verdict" && await stock.lireDoc("seances", r.d.seance)) {
        const ok = c.verdict === "maitrise";
        await stock.fusionnerDoc("seances", r.d.seance, { tariEtat: { [r.d.membre]: ok ? "maitrise" : "recu" }, tariRecu: { [r.d.membre]: ok } });
        prevenir("seances");
      }
      prevenir("taris");
      if (b === "verdict") {
        const ok = c.verdict === "maitrise", mot = String(c.mot || "").trim();
        notifs.notifier([r.d.membre], { titre: ok ? "✓ Tari maîtrisé" : "↻ Tari à retravailler",
          texte: moiNom + " a écouté votre Tari" + (mot ? " : « " + mot.slice(0, 120) + " »" : "") + (vocal ? (mot ? " (et un vocal)" : " et vous a laissé un vocal") : "") + ".",
          url: "/#tari/" + encodeURIComponent(r.d.seance) }).catch((e) => console.error(e));
      }
      return json(res, 200, { ok: true, prise: r.e.prise || null });
    }
    return json(res, 405, { code: "invalid_argument" });
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
    if (action === "discipline" && req.method === "POST") {
      const r = await comptes.definirDiscipline(membre, !!(await lireCorps(req)).oui);
      if (!r.erreur) prevenir("_comptes");
      return r.erreur ? json(res, 400, { code: r.erreur, message: "Ce membre n’a pas encore d’accès." }) : json(res, 200, { ok: true });
    }
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
    // Taris : un membre voit aussi qui a envoyé le sien dans les séances où il était (son kourel).
    const mesSeances = col === "taris" && !peut(sess, "suivi")
      ? new Set((await stock.lireCollection("seances")).filter((x) => (x.data.participants || []).includes(sess.membre)).map((x) => x.id)) : null;
    docs = filtrerPour(sess, col, docs, mesSeances);
    if (col === "khassidas") { const vis = await khassidasVisibles(sess); if (vis) docs = docs.filter((d) => vis.has(d.id)); }
    if (col === "audiosSeances" || col === "commentairesAudios") docs = await audiosSeancesVisibles(sess, docs);
    if (id) return docs[0] ? json(res, 200, docs[0]) : json(res, 404, { code: "not_found" });
    return json(res, 200, { docs });
  }
  // Les Taris enregistrés ne s'écrivent que par leurs routes (envoi, prise, verdict).
  if (col === "taris") return json(res, 403, { code: "invalid_argument", message: "Les Taris s’envoient depuis Mon espace." });
  if (col === "audiosSeances" || col === "commentairesAudios") return json(res, 403, { code: "invalid_argument", message: "Les audios et leurs commentaires s’ajoutent depuis la séance." });
  const corps = req.method === "PUT" || req.method === "PATCH" ? await lireCorps(req) : null;
  // Conservatoire : il peut marquer un khassida « en répétition » (et seulement cela).
  const marqueRepetition = col === "khassidas" && req.method === "PATCH" && corps && Object.keys(corps).length > 0
    && Object.keys(corps).every((k) => ["enRepetition", "enRepetitionLe", "enRepetitionPar"].includes(k));
  let gesteDiscipline = false;
  if (col === "seances" && id && (req.method === "PATCH" || req.method === "PUT")) {
    const avantS = await stock.lireDoc("seances", id);
    const changeDisc = req.method === "PATCH" ? "discipline" in corps : JSON.stringify(corps.discipline || {}) !== JSON.stringify((avantS && avantS.discipline) || {});
    if (changeDisc && !(await peutSanctionner(sess, avantS || corps))) return json(res, 403, { code: "discipline", message: "Les sanctions sont notées par la commission de discipline, le dieuwrigne ou l’admin." });
    // Commission de discipline (même sans le rôle Conservatoire) : sanctions et retards prévenus seulement.
    gesteDiscipline = req.method === "PATCH" && Object.keys(corps).length > 0 && Object.keys(corps).every((k) => ["discipline", "retardsPrevenus"].includes(k))
      && (sess.discipline || ("discipline" in corps && await peutSanctionner(sess, avantS)));
  }
  if (!gesteDiscipline && !peut(sess, marqueRepetition ? "suivi" : PERMISSION_COLLECTION[col])) return json(res, 403, { code: "invalid_argument", message: "Vous n’avez pas le droit de modifier ceci." });
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
  const avantSeance = col === "seances" && req.method !== "DELETE" ? await stock.lireDoc("seances", id) : null;
  const avantMembre = col === "membres" && id && req.method !== "DELETE" ? await stock.lireDoc("membres", id) : null;
  const apresSeance = async () => { if (col !== "seances") return; planifierTari(id, avantSeance); planifierSanctions(id, avantSeance, await stock.lireDoc("seances", id)); };
  // Nouveau khassida ajouté depuis Réglages : daté, puis annoncé aux membres.
  const nouveauKh = col === "khassidas" && req.method === "PUT" && id && !(await stock.lireDoc("khassidas", id));
  if (nouveauKh) corps.ajouteLe = Date.now();
  if (req.method === "PUT") { await stock.ecrireDoc(col, id, corps); prevenir(col); await apresMembre(col, id, avantMembre); await apresSeance(); if (nouveauKh) annoncerKhassida(id, sess.membre); return json(res, 200, { ok: true }); }
  if (req.method === "PATCH") {
    if (!(await stock.fusionnerDoc(col, id, corps))) return json(res, 404, { code: "not_found" });
    prevenir(col); await apresMembre(col, id, avantMembre); await apresSeance(); return json(res, 200, { ok: true });
  }
  if (req.method === "DELETE") {
    await stock.supprimerDoc(col, id); prevenir(col);
    // Séance supprimée (admin) : ses audios partent avec elle.
    if (col === "seances") {
      let n = 0;
      for (const d of await stock.lireCollection("audiosSeances")) if (d.data.seance === id) { await supprimerAudioSeance(d.id, d.data); n++; }
      for (const c of await stock.lireCollection("commentairesAudios")) if (c.data.seance === id) { await stock.supprimerDoc("commentairesAudios", c.id); n++; }
      if (n) { prevenir("audiosSeances"); prevenir("commentairesAudios"); }
    }
    return json(res, 200, { ok: true });
  }
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
  return envoyerFichier(req, res, cible, type, rel.startsWith("/marque/") ? "public, max-age=604800" : "no-cache");
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
  console.log("Audios des Taris : " + AUDIOS + (ffmpegDispo ? " (convertis en m4a avec ffmpeg)" : " (sans ffmpeg : gardés tels quels)"));
  console.log("Audios des répétitions : " + AUDIOS_SEANCES + " (gardés 1 an, sauf les épinglés)");
  if (await comptes.aucunCompte()) {
    console.log("\nAucun compte pour l’instant. Créez le premier administrateur :");
    console.log('  npm run admin -- "Prénom Nom"\n');
  }
});
