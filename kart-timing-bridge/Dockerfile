# Multi-stage build → ~50MB runtime image. Mirrors vt3-bridge.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist/ ./dist/
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
