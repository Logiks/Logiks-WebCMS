# One image, two roles: ROLE=web (HTTP) or ROLE=worker (jobs). Same code, different process.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY admin ./admin
# The site that ships with the code: built-in themes (site/themes) and the starter pages, components and locales (site/defaults).
COPY site ./site
# Uploads. In a cluster mount ONE shared volume here on every web and worker container (EFS, NFS): a file uploaded through one server must be readable by all of them.
# public/ is this container's own mirror of the site tree (derived from the database; safe to lose).
RUN mkdir -p /app/data/media /app/public && chown -R node:node /app/data /app/public
USER node
EXPOSE 3000
# Liveness only. Point the ALB target group at /readyz. A worker serves no HTTP, so it is healthy while its process runs.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "if(process.env.ROLE==='worker')process.exit(0);fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Run migrations as a separate deploy step:  docker run --rm <image> node src/cli/index.js migrate
CMD ["node", "src/server.js"]
