# Plateforme du Conservatoire

Code de la plateforme du Conservatoire du Dahira Mafatihul Bichri Touba Estrie.
La même page `index.html` est aussi publiée sur claude.ai (sans les comptes) :
https://claude.ai/artifact/U3abVV1E2K7hWyoKr2to6T

## Contenu

| Chemin | Rôle |
|---|---|
| `index.html` | La plateforme : Khassidas, Répétitions, Dahira, Bilan, Mon espace, Réglages, Chartes. Tout tient dans ce fichier (HTML, CSS, JavaScript). |
| `connexion.html` | Page de connexion et de choix du mot de passe. |
| `khassidas/wadieuhtou/` | Page d'étude « Wadieuhtou lilahi hamdane » : texte, audio, pages du manuscrit et calage validé (`data/calage.json`). |
| `dev/donnees-test.js` | Fausses données pour tester les écrans sans base. |
| `../donnees/` | Les données exportées de claude.ai le 21 novembre 2026, un fichier JSON par document. |

## Démarrer en local

Il faut Node.js 22 ou plus récent.

```bash
cd ~/Documents/git/agent_conservatoire
npm install                       # la première fois seulement
npm run admin -- "Prénom Nom"     # la première fois seulement : crée votre accès administrateur
npm start
```

Puis ouvrir http://localhost:8080 : connectez-vous avec l'identifiant et le mot de passe temporaire affichés par `npm run admin`, puis choisissez votre mot de passe. Pour arrêter : Ctrl + C.

- Autre port : `PORT=3000 npm start`.
- Depuis un téléphone sur le même Wi-Fi : http://<adresse-IP-du-Mac>:8080.
- Mot de passe administrateur perdu : relancez `npm run admin -- "Prénom Nom"`.

## Comptes des membres

**Inscription par le lien du groupe (méthode normale)**

1. **Réglages → Accès des membres → « 📲 Partager dans le groupe »** : le message avec le lien d'inscription s'ouvre dans WhatsApp, choisissez le groupe du Kourel.
2. Chaque membre ouvre le lien, choisit **son nom** dans la liste, tape **son numéro WhatsApp** et **choisit son mot de passe**.
3. Une pastille rouge apparaît sur Réglages. Pour chaque demande : **✓ Valider** ou **Refuser**. La plateforme indique si le numéro correspond à celui de sa fiche, et signale plusieurs demandes pour un même nom.
4. Après validation, « Le prévenir sur WhatsApp » lui envoie le message de confirmation. Il se connecte avec son nom (ou son numéro) et son mot de passe. Le numéro saisi est enregistré sur sa fiche.
5. Mot de passe oublié : le membre refait une demande avec le même lien ; après votre validation, le nouveau mot de passe remplace l'ancien.
6. « Nouveau lien » rend l'ancien lien inutilisable (par exemple s'il a circulé hors du groupe).

**En secours** : sur la ligne d'un membre, « Créer l'accès » ou « Nouveau mot de passe » crée un mot de passe temporaire (valable 7 jours) à lui envoyer sur WhatsApp. Le bouton « ⋯ » permet de donner les droits d'administrateur ou de supprimer l'accès.

Ce qu'un membre voit : Khassidas, Dahira, Mon espace (ses Taris, son suivi, ses présences) et les Chartes. Il ne voit ni les numéros de téléphone, ni les évaluations, sanctions ou motifs d'absence des autres, et ne peut rien modifier.

Sécurité : mots de passe chiffrés (scrypt), jamais stockés en clair ; session dans un cookie HttpOnly valable 90 jours ; après 8 échecs de connexion, l'adresse est bloquée un quart d'heure ; 10 demandes d'inscription par heure au plus par adresse ; changer de mot de passe déconnecte les autres appareils.

**Mise en ligne** : voir `../DEPLOIEMENT.md` (Docker, Traefik, GitHub Actions). **Avant la mise en ligne sur le VPS** : définir `PUBLIC_URL=https://…` dans `.env` (le lien d'inscription et les liens envoyés aux membres en dépendent) et servir la plateforme en HTTPS (le cookie devient alors `Secure`).

## Base de données

- **Avec `.env`** contenant `DATABASE_URL=postgresql://…` : PostgreSQL (Neon), table `documents` (collection, id, data en JSON, dates), créée automatiquement.
- **Sans `.env`** : fichiers `../donnees/<collection>/<document>.json`.
- Les collections `_comptes` et `_sessions` sont réservées au serveur : jamais lisibles par la page.
- `npm run importer` : copie `../donnees/` dans la base Neon (remplace les documents de même nom, ne supprime rien).

## Fichiers du serveur

| Fichier | Rôle |
|---|---|
| `local/serveur.mjs` | Serveur Node.js : pages, audio, API, connexion obligatoire, droits (membre ou administrateur). |
| `local/comptes.mjs` | Comptes : mots de passe temporaires, chiffrement, sessions. |
| `local/stockage.mjs` | Stockage des documents (PostgreSQL ou fichiers JSON). |
| `local/admin.mjs` | `npm run admin` : crée ou recrée un accès administrateur. |
| `local/importer.mjs` | `npm run importer` : copie `../donnees/` dans PostgreSQL. |
| `local/claude-local.js` | Adaptateur ajouté à la page : remplace `window.claude` (la base de claude.ai) par ce serveur. `index.html` reste identique à celui de claude.ai. |
