# Plateforme du Conservatoire

Code de la plateforme du Conservatoire du Dahira Mafatihul Bichri Touba Estrie.
Cette copie correspond à la version publiée sur claude.ai le 21 novembre 2026 :
https://claude.ai/artifact/U3abVV1E2K7hWyoKr2to6T

## Contenu

| Chemin | Rôle |
|---|---|
| `index.html` | La plateforme : Khassidas, Répétitions, Dahira, Bilan, Mon espace, Réglages. Tout tient dans ce fichier (HTML, CSS, JavaScript). |
| `khassidas/wadieuhtou/` | Page d'étude « Wadieuhtou lilahi hamdane » : texte, audio, pages du manuscrit et calage validé (`data/calage.json`). |
| `dev/donnees-test.js` | Fausses données pour tester les écrans sans base (membres, séances, Taris, évaluations). |
| `../donnees/` | Les vraies données exportées de claude.ai le 21 novembre 2026 : un fichier JSON par document, rangé par collection (`membres`, `seances`, `khassidas`, `dahiras`, `programmes`). La collection `evaluations` était vide. |

## Ce qu'il faut savoir avant de lancer en localhost

La plateforme lit et écrit ses données avec `window.claude` (la base `db` de claude.ai) et sait qui est l'administrateur avec `user.canEdit()`.
Ouverte en local sans rien d'autre, elle affiche « Hors ligne ».

Pour la lancer en localhost, il faut :

1. un petit serveur qui sert ce dossier et garde les données (par exemple Node.js avec une base SQLite, ou des fichiers JSON pour commencer) ;
2. un adaptateur qui remplace `window.claude` dans `index.html` : mêmes fonctions (`collection(...).onSnapshot`, `doc(...).set / update / delete`, `canEdit`), mais branchées sur ce serveur ;
3. l'import des fichiers de `../donnees/` dans la base locale.

Le format des collections est décrit dans `../CLAUDE.md` (section « Fichiers et documents du Conservatoire »).

Pour seulement regarder les écrans avec les fausses données, chargez `dev/donnees-test.js` avant le script de `index.html`.
