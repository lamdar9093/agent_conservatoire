// Stockage des documents de la plateforme : PostgreSQL (Neon) si DATABASE_URL est défini, sinon fichiers JSON.
// Même modèle que la base de claude.ai : des collections de documents JSON.
// Les collections dont le nom commence par « _ » (comptes, sessions) sont réservées au serveur.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICI = path.dirname(fileURLToPath(import.meta.url));
export const DONNEES = path.resolve(process.env.DONNEES_DIR || path.resolve(ICI, "..", "..", "donnees"));
const NOM_VALIDE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

export function nomValide(n) { return typeof n === "string" && NOM_VALIDE.test(n) && n !== "." && n !== ".."; }
function estObjet(v) { return v && typeof v === "object" && !Array.isArray(v); }
// Les objets imbriqués fusionnent, le reste remplace (comme la base de claude.ai).
export function fusion(base, ajout) {
  const r = estObjet(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(ajout)) r[k] = estObjet(v) && estObjet(r[k]) ? fusion(r[k], v) : v;
  return r;
}

function stockageFichiers() {
  const chemin = (col, id) => path.join(DONNEES, col, id + ".json");
  return {
    nom: "fichiers JSON (" + DONNEES + ")",
    async lireDoc(col, id) {
      try { return JSON.parse(await fsp.readFile(chemin(col, id), "utf8")); } catch { return null; }
    },
    async ecrireDoc(col, id, data) {
      await fsp.mkdir(path.join(DONNEES, col), { recursive: true });
      const cible = chemin(col, id), tmp = cible + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
      await fsp.rename(tmp, cible);
    },
    async fusionnerDoc(col, id, ajout) {
      const d = await this.lireDoc(col, id);
      if (!d) return false;
      await this.ecrireDoc(col, id, fusion(d, ajout));
      return true;
    },
    async supprimerDoc(col, id) { await fsp.rm(chemin(col, id), { force: true }); },
    async lireCollection(col) {
      let noms = [];
      try { noms = await fsp.readdir(path.join(DONNEES, col)); } catch { return []; }
      const docs = [];
      for (const f of noms.filter((n) => n.endsWith(".json")).sort()) {
        const id = f.slice(0, -5), data = await this.lireDoc(col, id);
        if (data) docs.push({ id, data });
      }
      return docs;
    }
  };
}

async function stockagePostgres(url) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await pool.query(`create table if not exists documents (
    collection text not null,
    id text not null,
    data jsonb not null,
    cree_le timestamptz not null default now(),
    modifie_le timestamptz not null default now(),
    primary key (collection, id)
  )`);
  return {
    nom: "PostgreSQL (" + new URL(url).hostname + ")",
    async lireDoc(col, id) {
      const r = await pool.query("select data from documents where collection = $1 and id = $2", [col, id]);
      return r.rows[0] ? r.rows[0].data : null;
    },
    async ecrireDoc(col, id, data) {
      await pool.query(`insert into documents (collection, id, data) values ($1, $2, $3)
        on conflict (collection, id) do update set data = excluded.data, modifie_le = now()`, [col, id, JSON.stringify(data)]);
    },
    async fusionnerDoc(col, id, ajout) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        const r = await c.query("select data from documents where collection = $1 and id = $2 for update", [col, id]);
        if (!r.rows[0]) { await c.query("rollback"); return false; }
        await c.query("update documents set data = $3, modifie_le = now() where collection = $1 and id = $2", [col, id, JSON.stringify(fusion(r.rows[0].data, ajout))]);
        await c.query("commit");
        return true;
      } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
    },
    async supprimerDoc(col, id) { await pool.query("delete from documents where collection = $1 and id = $2", [col, id]); },
    async lireCollection(col) {
      const r = await pool.query("select id, data from documents where collection = $1 order by id", [col]);
      return r.rows.map((x) => ({ id: x.id, data: x.data }));
    },
    async fermer() { await pool.end(); }
  };
}

export async function ouvrirStockage() {
  return process.env.DATABASE_URL ? await stockagePostgres(process.env.DATABASE_URL) : stockageFichiers();
}
