FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.mjs index.html manifest.webmanifest icon.svg apple-touch-icon.png sw.js ./
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/setup-status').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]