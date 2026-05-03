# Multi-stage build keeps the runtime image tiny (~50MB).
# Stage 1: install all deps + compile TypeScript.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
# No lockfile committed (zero runtime deps). If you add deps,
# also commit package-lock.json and switch this to `npm ci`.
RUN npm install
COPY src/ ./src/
RUN npx tsc

# Stage 2: production runtime — built JS + production deps only.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# Install ONLY production dependencies (skip tsx/typescript/types).
# Worker has zero runtime deps today, so this is a no-op now, but
# keeping the step here means future deps "just work" without
# debugging another ERR_MODULE_NOT_FOUND in production.
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist/ ./dist/
ENV NODE_ENV=production
# Bridge is a long-lived process — the worker reconnects on stream
# errors, so a process exit only happens on fatal error or SIGTERM.
# Fly / Railway restart-on-failure will bring it back up.
CMD ["node", "dist/index.js"]
