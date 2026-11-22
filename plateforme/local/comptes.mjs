// Comptes des membres : mot de passe temporaire envoyé sur WhatsApp, puis mot de passe personnel.
// - Mots de passe chiffrés avec scrypt (sel aléatoire), jamais stockés en clair.
// - Sessions : jeton aléatoire dans un cookie HttpOnly ; seule son empreinte (SHA-256) est stockée.
// - Collections réservées au serveur : _comptes (une fiche par membre) et _sessions.
import crypto from "node:crypto";

const JOUR = 24 * 3600 * 1000;
export const DUREE_SESSION = 90 * JOUR;
export const DUREE_TEMPORAIRE = 7 * JOUR;
export const COOKIE = "conservatoire_session";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans 0/O, 1/I/L

function scrypt(mdp, sel) {
  return new Promise((ok, ko) => crypto.scrypt(mdp, sel, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? ko(e) : ok(k))));
}
export async function chiffrer(mdp) {
  const sel = crypto.randomBytes(16);
  return "scrypt$" + sel.toString("base64") + "$" + (await scrypt(mdp, sel)).toString("base64");
}
export async function verifier(mdp, stocke) {
  const [algo, sel, hash] = String(stocke || "").split("$");
  if (algo !== "scrypt" || !sel || !hash) return false;
  const attendu = Buffer.from(hash, "base64"), calcule = await scrypt(String(mdp), Buffer.from(sel, "base64"));
  return attendu.length === calcule.length && crypto.timingSafeEqual(attendu, calcule);
}
export function motDePasseTemporaire() {
  const octets = crypto.randomBytes(10);
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[octets[i] % ALPHABET.length];
  return s.slice(0, 5) + "-" + s.slice(5);
}
const empreinte = (jeton) => crypto.createHash("sha256").update(jeton).digest("hex");

export function creerComptes(stock) {
  const cache = new Map(); // empreinte -> { session, lu }

  async function fiche(membre) { return stock.lireDoc("_comptes", membre); }
  async function nombreAdmins() { return (await stock.lireCollection("_comptes")).filter((d) => d.data.admin).length; }

  async function nouvelleSession(membre) {
    const jeton = crypto.randomBytes(32).toString("base64url");
    const session = { membre, cree: Date.now(), expire: Date.now() + DUREE_SESSION };
    await stock.ecrireDoc("_sessions", empreinte(jeton), session);
    return jeton;
  }
  async function supprimerSessions(membre, sauf) {
    for (const d of await stock.lireCollection("_sessions")) {
      if (d.data.membre === membre && d.id !== sauf) { await stock.supprimerDoc("_sessions", d.id); cache.delete(d.id); }
    }
  }

  return {
    nombreAdmins,
    async aucunCompte() { return (await stock.lireCollection("_comptes")).length === 0; },

    /* Retrouve la session d'un jeton (avec la fiche du compte), ou null. */
    async session(jeton) {
      if (!jeton) return null;
      const id = empreinte(jeton), c = cache.get(id);
      let s = c && Date.now() - c.lu < 30000 ? c.session : await stock.lireDoc("_sessions", id);
      if (!s || s.expire < Date.now()) { cache.delete(id); return null; }
      const compte = await fiche(s.membre);
      if (!compte) return null;
      cache.set(id, { session: s, lu: Date.now() });
      return { id, membre: s.membre, admin: !!compte.admin, temporaire: !!compte.temporaire };
    },

    /* Connexion : identifiant (lamine-dieng), nom (Lamine Dieng) ou numéro de téléphone. */
    async connecter(identifiant, mdp, membres) {
      const simple = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const brut = simple(identifiant);
      const chiffres = String(identifiant || "").replace(/\D/g, "");
      let membre = membres.find((m) => m.id === brut) || membres.find((m) => simple(m.data.nom) === brut);
      if (!membre && chiffres.length >= 7) membre = membres.find((m) => m.data.telephone && String(m.data.telephone).replace(/\D/g, "").endsWith(chiffres.slice(-10)));
      const compte = membre ? await fiche(membre.id) : null;
      if (!compte) {
        // Demande d'inscription pas encore validée : on le dit, si le mot de passe est le bon.
        const demande = membre ? await stock.lireDoc("_demandes", membre.id) : null;
        if (demande && (await verifier(mdp, demande.hash))) return { erreur: "attente" };
        return { erreur: demande ? "identifiants" : "inconnu" };
      }
      let ok = await verifier(mdp, compte.hash);
      // Mot de passe temporaire : majuscules ou minuscules, avec ou sans tiret ni espaces.
      if (!ok && compte.temporaire) {
        const t = String(mdp || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (t.length === 10) ok = await verifier(t.slice(0, 5) + "-" + t.slice(5), compte.hash);
      }
      if (!ok) return { erreur: "identifiants" };
      if (compte.temporaire && compte.expireTemp && compte.expireTemp < Date.now()) return { erreur: "expire" };
      await stock.fusionnerDoc("_comptes", membre.id, { derniereConnexion: Date.now() });
      return { jeton: await nouvelleSession(membre.id), membre: membre.id, temporaire: !!compte.temporaire };
    },

    async deconnecter(idSession) { if (idSession) { await stock.supprimerDoc("_sessions", idSession); cache.delete(idSession); } },

    /* Changement de mot de passe : l'ancien est demandé, sauf juste après une connexion avec le mot de passe temporaire. */
    async changer(membre, idSession, actuel, nouveau) {
      const compte = await fiche(membre);
      if (!compte) return { erreur: "compte" };
      if (!compte.temporaire && !(await verifier(actuel, compte.hash))) return { erreur: "actuel" };
      if (typeof nouveau !== "string" || nouveau.length < 8) return { erreur: "court" };
      if (await verifier(nouveau, compte.hash)) return { erreur: "identique" };
      await stock.fusionnerDoc("_comptes", membre, { hash: await chiffrer(nouveau), temporaire: false, expireTemp: null, modifieLe: Date.now() });
      await supprimerSessions(membre, idSession);
      cache.delete(idSession);
      return { ok: true };
    },

    /* --- Inscription libre (lien partagé dans le groupe WhatsApp), validée par un administrateur --- */
    async invitation() {
      let inv = await stock.lireDoc("_config", "inscription");
      if (!inv || !inv.code) { inv = { code: crypto.randomBytes(9).toString("base64url"), creeLe: Date.now() }; await stock.ecrireDoc("_config", "inscription", inv); }
      return inv;
    },
    async nouvelleInvitation() {
      const inv = { code: crypto.randomBytes(9).toString("base64url"), creeLe: Date.now() };
      await stock.ecrireDoc("_config", "inscription", inv);
      return inv;
    },
    async codeValide(code) {
      const inv = await stock.lireDoc("_config", "inscription");
      if (!inv || !inv.code || typeof code !== "string" || code.length !== inv.code.length) return false;
      return crypto.timingSafeEqual(Buffer.from(code), Buffer.from(inv.code));
    },
    /* Une demande par membre ; une nouvelle demande remplace la précédente (le compteur le signale). */
    async demander(membre, telephone, mdp) {
      const avant = await stock.lireDoc("_demandes", membre), compte = await fiche(membre);
      await stock.ecrireDoc("_demandes", membre, {
        hash: await chiffrer(mdp), telephone, creeLe: Date.now(), nb: ((avant && avant.nb) || 0) + 1, reinitialisation: !!compte
      });
    },
    async demandes() {
      const r = {};
      for (const d of await stock.lireCollection("_demandes")) r[d.id] = { telephone: d.data.telephone, creeLe: d.data.creeLe, nb: d.data.nb || 1, reinitialisation: !!d.data.reinitialisation };
      return r;
    },
    async etatDemandes() {
      const r = {};
      for (const d of await stock.lireCollection("_demandes")) r[d.id] = "demande";
      for (const d of await stock.lireCollection("_comptes")) r[d.id] = r[d.id] ? "demande" : "compte";
      return r;
    },
    async valider(membre) {
      const d = await stock.lireDoc("_demandes", membre);
      if (!d) return { erreur: "demande" };
      const avant = await fiche(membre);
      await stock.ecrireDoc("_comptes", membre, {
        hash: d.hash, temporaire: false, expireTemp: null, admin: !!(avant && avant.admin),
        creeLe: (avant && avant.creeLe) || Date.now(), modifieLe: Date.now(), envoyeLe: null, inscrit: true,
        derniereConnexion: (avant && avant.derniereConnexion) || null
      });
      await stock.supprimerDoc("_demandes", membre);
      if (avant) await supprimerSessions(membre); // nouveau mot de passe : les autres appareils sont déconnectés
      return { ok: true, telephone: d.telephone };
    },
    async refuser(membre) { await stock.supprimerDoc("_demandes", membre); return { ok: true }; },

    /* Administration */
    async liste() {
      const r = {};
      for (const d of await stock.lireCollection("_comptes")) {
        r[d.id] = { admin: !!d.data.admin, temporaire: !!d.data.temporaire, expireTemp: d.data.expireTemp || null,
          derniereConnexion: d.data.derniereConnexion || null, envoyeLe: d.data.envoyeLe || null, creeLe: d.data.creeLe || null };
      }
      return r;
    },
    async genererTemporaire(membre, admin) {
      const mdp = motDePasseTemporaire(), avant = await fiche(membre);
      await stock.ecrireDoc("_comptes", membre, {
        hash: await chiffrer(mdp), temporaire: true, expireTemp: Date.now() + DUREE_TEMPORAIRE,
        admin: admin === undefined ? !!(avant && avant.admin) : !!admin,
        creeLe: (avant && avant.creeLe) || Date.now(), modifieLe: Date.now(), envoyeLe: null,
        derniereConnexion: (avant && avant.derniereConnexion) || null
      });
      await supprimerSessions(membre);
      return { motDePasse: mdp, expire: Date.now() + DUREE_TEMPORAIRE };
    },
    async marquerEnvoye(membre) { return stock.fusionnerDoc("_comptes", membre, { envoyeLe: Date.now() }); },
    async definirAdmin(membre, admin) {
      const f = await fiche(membre);
      if (!f) return { erreur: "compte" };
      if (!admin && f.admin && (await nombreAdmins()) <= 1) return { erreur: "dernier-admin" };
      await stock.fusionnerDoc("_comptes", membre, { admin: !!admin });
      cache.clear();
      return { ok: true };
    },
    async revoquer(membre) {
      const f = await fiche(membre);
      if (f && f.admin && (await nombreAdmins()) <= 1) return { erreur: "dernier-admin" };
      await stock.supprimerDoc("_comptes", membre);
      await supprimerSessions(membre);
      return { ok: true };
    }
  };
}
