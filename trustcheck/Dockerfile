FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 DATABASE_FILE=/data/reports.sqlite TRUST_PROXY=true
WORKDIR /app
COPY server/ ./server/
COPY lib/ ./lib/
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server/server.js"]
