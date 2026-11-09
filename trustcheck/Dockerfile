# Node 22 is required: the report server uses the built-in node:sqlite (no npm dependencies).
FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 DATABASE_FILE=/data/data.db BACKUP_DIR=/data/backups
WORKDIR /app
COPY server/*.js ./server/
COPY package.json ./
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 8787
# Liveness only: the orchestrator should use /readyz for traffic routing (it fails while the database is unusable or draining).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
