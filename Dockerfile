# One image: builds the site, then serves it together with the API.
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
COPY config/ /src/config/
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production CONFIG_DIR=/app/config DATA_DIR=/app/data WEB_DIR=/app/web/dist PORT=8787
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY api/src ./src
COPY --from=web /src/web/dist /app/web/dist
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "src/server.js"]
