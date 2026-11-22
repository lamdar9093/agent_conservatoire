# Image de production de la plateforme du Conservatoire
# (Dahira Mafatihul Bichri Touba Estrie) — servie derrière Traefik sur le VPS.

# Étape 1 : dépendances de production (uniquement « pg », en JavaScript pur)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Étape 2 : image finale
FROM node:22-alpine AS runner
WORKDIR /app

# Utilisateur sans privilèges
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 conservatoire

COPY --from=deps --chown=conservatoire:nodejs /app/node_modules ./node_modules
COPY --chown=conservatoire:nodejs package.json ./
COPY --chown=conservatoire:nodejs plateforme ./plateforme

# Valeurs fournies au lancement par docker-compose (.env du VPS)
ENV NODE_ENV=production
ENV PORT=8080

USER conservatoire
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/api/sante', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "plateforme/local/serveur.mjs"]
