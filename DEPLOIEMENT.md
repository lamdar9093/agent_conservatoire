# Déploiement : https://conservatoire.mthbichri.ca

Même principe que gobering :
- Docker derrière Traefik (réseau `traefik-net`, certificat Let's Encrypt) ;
- un seul environnement, la production ;
- chaque `push` sur `main` déploie automatiquement par GitHub Actions.

| Fichier | Rôle |
|---|---|
| `Dockerfile` | Image Node 22 (alpine) : `plateforme/` et la dépendance `pg`, avec un utilisateur sans privilèges et un contrôle de santé sur `/api/sante`. |
| `docker-compose.yml` | Service `app` (conteneur `conservatoire-app`), avec les étiquettes Traefik pour `conservatoire.mthbichri.ca`. |
| `.github/workflows/deploy.yml` | En SSH sur le VPS : `git pull`, construction, redémarrage, puis vérification que la nouvelle version répond. |
| `env.example` | Modèle du `.env` du VPS. |

Les données sont dans Neon : le conteneur ne garde rien. Il refuse de démarrer sans `DATABASE_URL`.

**Exception : les audios des Taris** enregistrés par les membres (fichiers trop lourds pour la base). Ils sont sur le disque du VPS, dans le volume Docker `conservatoire-audios` (monté sur `/app/audios`), créé tout seul au premier déploiement et gardé à chaque mise à jour. ffmpeg, inclus dans l'image, convertit chaque envoi en m4a (lisible sur tous les téléphones). Ne lancez jamais `docker compose down -v` : l'option `-v` effacerait ce volume.

## Première mise en place (une seule fois)

### 1. DNS
Chez le fournisseur du domaine `mthbichri.ca`, créez un enregistrement **A** : `conservatoire` vers l'adresse IP du VPS (la même que gobering). Traefik obtient le certificat HTTPS tout seul une fois le DNS propagé.

### 2. Le code sur le VPS
```bash
sudo mkdir -p /var/www/agent_conservatoire && sudo chown $USER /var/www/agent_conservatoire
git clone https://github.com/lamdar9093/agent_conservatoire.git /var/www/agent_conservatoire
cd /var/www/agent_conservatoire
```
Si le dépôt est privé, il faut que le VPS puisse le lire. Ajoutez une *deploy key* : générez une clé avec `ssh-keygen -t ed25519` sur le VPS, collez la clé publique dans GitHub → Settings → Deploy keys, puis clonez avec `git@github.com:lamdar9093/agent_conservatoire.git`.

### 3. Le fichier `.env`
```bash
cp env.example .env
nano .env          # DATABASE_URL (Neon) et PUBLIC_URL=https://conservatoire.mthbichri.ca
chmod 600 .env
```

### 4. Premier lancement
```bash
docker compose up -d --build
docker compose ps              # l'état doit passer à « healthy »
docker compose logs -f app     # Ctrl + C pour quitter
```
Ouvrez ensuite https://conservatoire.mthbichri.ca.

### 5. Secrets GitHub (déploiement automatique)
Dans le dépôt, allez dans Settings → Secrets and variables → Actions, et ajoutez les mêmes valeurs que pour gobering :

| Secret | Valeur |
|---|---|
| `VPS_HOST_PROD` | Adresse IP du VPS |
| `VPS_USER` | Utilisateur SSH |
| `SSH_PRIVATE_KEY_PROD` | Clé SSH privée |
| `SSH_PORT_PROD` | Port SSH |

À partir de là, chaque `git push` sur `main` met la plateforme à jour. Le suivi se fait dans l'onglet **Actions** du dépôt. L'ancienne version reste en ligne pendant la construction de la nouvelle.

## Au quotidien

- **Créer ou recréer un accès administrateur :**
  `docker compose exec app node plateforme/local/admin.mjs "Prénom Nom"`
- **Voir les journaux :** `docker compose logs --tail=100 app`
- **Place prise par les audios des Taris :** `docker system df -v | grep conservatoire-audios`
- **Copie de sauvegarde des audios :** `docker run --rm -v conservatoire-audios:/a -v "$PWD":/b alpine tar czf /b/audios-taris.tgz -C /a .`
- **Redémarrer :** `docker compose restart app`
- **Changer le mot de passe Neon :** Neon → Roles → Reset password, puis mettez à jour `.env` sur le VPS et sur le Mac. Lancez ensuite `docker compose up -d` sur le VPS.
