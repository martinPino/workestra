# Container «runtime»: los tres nodos que NO caben en un isolate de Workers.
#
#  - `code`    — sandbox de JS de usuario. En Workers no hay `vm` ni `eval`.
#  - `browser` — Playwright con Chromium local.
#  - `extract` — OCR (tesseract.js + ~8,5 MB de traineddata) y PDF. Ni cabe en los 10 MB de bundle ni
#                termina cómodo dentro de los 5 min de CPU.
#
# Corre como Cloudflare Container (GA desde abril de 2026, plan Workers Paid). El Worker le habla por
# HTTP a través de su binding; el contenedor NO se expone a internet.
FROM node:22-slim

# Chromium necesita estas librerías del sistema; tesseract.js es WASM puro y no necesita nada.
RUN apt-get update -y && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --filter @core/sdk-plugins... \
  && pnpm --filter @core/sdk-plugins... build \
  && npx playwright install --with-deps chromium

# El servidor HTTP que expone los tres ejecutores. Escucha en el puerto que Cloudflare inyecta.
ENV PORT=8080
EXPOSE 8080
CMD ["node", "containers/runtime/server.mjs"]
