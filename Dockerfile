# --- Build/runtime image for the VoteBox voting site ---
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Data lives in a Turso database (set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).
# If those are unset it falls back to a local SQLite file in DATA_DIR (dev only).
ENV DATA_DIR=/data

EXPOSE 3000

# Basic container health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
