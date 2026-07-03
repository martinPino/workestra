# Imagen ÚNICA del monorepo (api, worker, web). Cada servicio de Railway usa esta misma imagen y
# sobrescribe su "Start Command" (ver DEPLOY.md). Multi-stage: build con turbo, runtime ligero.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Prisma necesita openssl en Debian slim; ca-certificates para las llamadas HTTPS salientes.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---- build: instala deps y compila todo el monorepo ----
FROM base AS build
# VITE_API_URL se hornea en el bundle web en tiempo de build (solo importa en el servicio `web`).
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
COPY . .
RUN pnpm install --frozen-lockfile
# `turbo run build`: compila packages (incl. prisma generate en @core/infra) + apps (api/worker/web).
RUN pnpm build

# ---- runtime: la misma app compilada; el CMD lo fija cada servicio en Railway ----
FROM base AS runtime
COPY --from=build /app /app
# Por defecto arranca la API (migra + escucha). Worker/web sobrescriben el Start Command.
CMD ["sh", "scripts/start-api.sh"]
