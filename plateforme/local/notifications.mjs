// Notifications sur le téléphone (Web Push), sans service payant ni bibliothèque externe.
// - Clés VAPID générées une seule fois et gardées dans la base (_config/vapid).
// - Abonnements (un par appareil) dans _abonnements ; dernier message de chaque membre dans _notifs.
// - Le « push » est envoyé sans contenu (donc sans chiffrement) : le service worker du téléphone
//   demande ensuite le message et le chiffre de la pastille à /api/notifs/resume.
// Sur iPhone : seulement pour la plateforme ajoutée à l'écran d'accueil (iOS 16.4 et plus).
import crypto from "node:crypto";

// Services de notification des navigateurs (Apple, Google, Mozilla, Microsoft) : on n'envoie nulle part ailleurs.
const HOTES = [".push.apple.com", ".googleapis.com", ".mozilla.com", ".notify.windows.com"];
export function hotePermis(url) {
  try {
    const u = new URL(url), test = (process.env.PUSH_HOTES_TEST || "").split(",").filter(Boolean);
    if (test.includes(u.hostname)) return true;
    return u.protocol === "https:" && HOTES.some((h) => u.hostname.endsWith(h));
  } catch { return false; }
}
const idAbonnement = (endpoint) => crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 40);

export async function creerNotifications(stock, { sujet }) {
  let v = await stock.lireDoc("_config", "vapid");
  if (!v || !v.publique || !v.privee) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const brute = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    v = { publique: brute.toString("base64url"), privee: privateKey.export({ format: "pem", type: "pkcs8" }), creeLe: Date.now() };
    await stock.ecrireDoc("_config", "vapid", v);
  }
  const cle = crypto.createPrivateKey(v.privee);
  const jetons = new Map();
  // Jeton VAPID (JWT signé ES256) pour un service de notification, réutilisé quelques heures.
  function jeton(aud) {
    const c = jetons.get(aud);
    if (c && c.exp - Date.now() > 3600000) return c.jwt;
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const donnees = b64({ typ: "JWT", alg: "ES256" }) + "." + b64({ aud, exp, sub: sujet });
    const sig = crypto.sign("sha256", Buffer.from(donnees), { key: cle, dsaEncoding: "ieee-p1363" }).toString("base64url");
    const jwt = donnees + "." + sig;
    jetons.set(aud, { jwt, exp: exp * 1000 });
    return jwt;
  }
  async function pousser(id, ab) {
    try {
      const r = await fetch(ab.endpoint, {
        method: "POST",
        headers: { Authorization: "vapid t=" + jeton(new URL(ab.endpoint).origin) + ", k=" + v.publique, TTL: "86400", Urgency: "high", "Content-Length": "0" },
        signal: AbortSignal.timeout(10000)
      });
      // Abonnement expiré ou retiré par le téléphone : on l'oublie.
      if (r.status === 404 || r.status === 410) await stock.supprimerDoc("_abonnements", id);
      return r.status;
    } catch { return 0; }
  }
  return {
    clePublique: v.publique,
    async abonner(membre, ab) {
      if (!ab || typeof ab.endpoint !== "string" || !hotePermis(ab.endpoint)) return false;
      await stock.ecrireDoc("_abonnements", idAbonnement(ab.endpoint), { membre, endpoint: ab.endpoint, le: Date.now() });
      return true;
    },
    async desabonner(membre, endpoint) {
      const id = idAbonnement(String(endpoint || "")), d = await stock.lireDoc("_abonnements", id);
      if (d && d.membre === membre) await stock.supprimerDoc("_abonnements", id);
    },
    async abonnes() { return new Set((await stock.lireCollection("_abonnements")).map((d) => d.data.membre)); },
    async dernier(membre) { return stock.lireDoc("_notifs", membre); },
    /* Prévient des membres : leur message est gardé, puis chacun de leurs appareils reçoit un « push ». */
    async notifier(membres, message) {
      const liste = [...new Set(membres)].filter(Boolean);
      if (!liste.length) return 0;
      for (const m of liste) await stock.ecrireDoc("_notifs", m, { ...message, le: Date.now() });
      const abs = (await stock.lireCollection("_abonnements")).filter((d) => liste.includes(d.data.membre));
      const r = await Promise.allSettled(abs.map((d) => pousser(d.id, d.data)));
      return r.filter((x) => x.value >= 200 && x.value < 300).length;
    }
  };
}
