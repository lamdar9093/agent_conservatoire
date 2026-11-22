// Crée (ou recrée) l'accès administrateur d'un membre et affiche son mot de passe temporaire.
// Usage : npm run admin -- "Prénom Nom"      (ou l'identifiant, ex. lamine-dieng)
import { ouvrirStockage } from "./stockage.mjs";
import { creerComptes } from "./comptes.mjs";

const recherche = process.argv.slice(2).join(" ").trim();
const stock = await ouvrirStockage();
const membres = await stock.lireCollection("membres");
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

if (!recherche) {
  console.log('Usage : npm run admin -- "Prénom Nom"\n\nMembres :');
  for (const m of membres) console.log("  " + m.id.padEnd(26) + m.data.nom);
  process.exit(1);
}
const trouves = membres.filter((m) => m.id === recherche || norm(m.data.nom) === norm(recherche));
const proches = trouves.length ? trouves : membres.filter((m) => norm(m.data.nom).includes(norm(recherche)));
if (proches.length !== 1) {
  console.log(proches.length ? "Plusieurs membres correspondent :" : "Aucun membre ne correspond à « " + recherche + " ».");
  for (const m of proches.length ? proches : membres) console.log("  " + m.id.padEnd(26) + m.data.nom);
  process.exit(1);
}
const m = proches[0];
const r = await creerComptes(stock).genererTemporaire(m.id, true);
console.log("\nAccès administrateur créé pour " + m.data.nom + " (" + stock.nom + ")\n");
console.log("  Identifiant              : " + m.id);
console.log("  Mot de passe temporaire  : " + r.motDePasse);
console.log("  Valable jusqu’au         : " + new Date(r.expire).toLocaleString("fr-FR"));
console.log("\nOuvrez la plateforme (npm start, puis http://localhost:8080) : elle vous demandera de choisir votre mot de passe.\n");
if (stock.fermer) await stock.fermer();
