# Multi-stage, mirroring kart-timing-bridge — but the runtime image is NOT the
# ~50MB those get, because this one carries the tools that are the entire reason
# the service exists.
#
#   ffmpeg    seeks the source over HTTP and cuts the lap
#   tesseract reads the camera's burned-in wall clock, which is what anchors a
#             lap time to an offset in the file
#
# That is ~120MB of apk packages. Isolating them here is the point: bundling the
# same tooling into the Next app would put it on the deploy path of the booking
# flow, the kiosk and every TV feed to serve one job a day.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
# tesseract-ocr-data-eng is separate from the binary on alpine; without it every
# OCR silently returns empty and every clip falls back to the centring estimate.
RUN apk add --no-cache ffmpeg tesseract-ocr tesseract-ocr-data-eng
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=builder /app/dist/ ./dist/
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
