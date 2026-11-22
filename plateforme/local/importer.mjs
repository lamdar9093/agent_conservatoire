// Importe les fichiers de donnees/<collection>/<document>.json dans la base PostgreSQL (DATABASE_URL du fichier .env).
// Lancement : npm run importer
// Un document qui existe déjà dans la base est remplacé par le fichier ; rien n'est supprimé.
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ICI = path.dirname(fileURLToPath(import.meta.url));
const DONNEES = path.resolve(ICI, "..", "..", "donnees");
const NOM_VALIDE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant : ajoutez-le dans le fichier .env.");
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(`create table if not exists documents (
  collection text not null,
  id text not null,
  data jsonb not null,
  cree_le timestamptz not null default now(),
  modifie_le timestamptz not null default now(),
  primary key (collection, id)
)`);

const bilan = {};
await client.query("begin");
try {
  for (const col of (await fsp.readdir(DONNEES, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    if (!NOM_VALIDE.test(col)) continue;
    for (const f of (await fsp.readdir(path.join(DONNEES, col))).filter((n) => n.endsWith(".json")).sort()) {
      const id = f.slice(0, -5);
      if (!NOM_VALIDE.test(id)) continue;
      const data = JSON.parse(await fsp.readFile(path.join(DONNEES, col, f), "utf8"));
      await client.query(`insert into documents (collection, id, data) values ($1, $2, $3)
        on conflict (collection, id) do update set data = excluded.data, modifie_le = now()`, [col, id, JSON.stringify(data)]);
      bilan[col] = (bilan[col] || 0) + 1;
    }
  }
  await client.query("commit");
} catch (e) {
  await client.query("rollback");
  console.error("Import annulé, rien n'a été écrit :", e.message);
  process.exit(1);
}
const total = await client.query("select collection, count(*)::int as n from documents group by collection order by collection");
await client.end();
console.log("Importé depuis " + DONNEES + " :");
for (const [c, n] of Object.entries(bilan)) console.log("  " + c + " : " + n);
console.log("Contenu de la base maintenant :");
for (const r of total.rows) console.log("  " + r.collection + " : " + r.n);
