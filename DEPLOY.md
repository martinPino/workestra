# Despliegue en Railway (todo en un proyecto)

AgentFlow se despliega como **un proyecto de Railway con 5 componentes**: Postgres, Redis y tres
servicios (**api**, **worker**, **web**) construidos desde este mismo repo con el `Dockerfile` de la
raíz. Los tres servicios usan la **misma imagen** y solo cambian su **Start Command**.

```
Postgres (add-on) ─┐
Redis    (add-on) ─┼─▶ api    (NestJS + WebSockets + OAuth callback)  ← dominio público (redirect de Slack)
                   ├─▶ worker (BullMQ: ejecución durable + cron)      ← sin dominio
                   └─▶ web    (SPA estática)                          ← dominio público
```

## 1) Proyecto + bases de datos
1. Crea un proyecto en Railway → **New Project → Deploy from GitHub repo** → elige `martinPino/agentflow`.
2. En el proyecto: **+ New → Database → Add PostgreSQL**. Repite con **Add Redis**.

## 2) Los tres servicios (mismo repo, variable `SERVICE`)
Railway crea un primer servicio al conectar el repo. Renómbralo **api** y crea otros dos (**+ New →
GitHub Repo →** el mismo repo) para **worker** y **web**.

Los tres usan la **misma imagen** (el `Dockerfile` de la raíz, via `railway.json`) y el **mismo CMD**
(`scripts/start.sh`). Cada servicio elige qué arrancar con la variable de entorno **`SERVICE`** — NO
uses "Custom Start Command" (déjalo **vacío**; en monorepos a veces no se propaga).

| Servicio | Variable | Qué arranca | Dominio público |
|---|---|---|---|
| **api** | `SERVICE=api` | migra + siembra + API (NestJS + WS) | **Sí** (Settings → Networking → Generate Domain) |
| **worker** | `SERVICE=worker` | BullMQ (durable + cron) | No |
| **web** | `SERVICE=web` | SPA estática | **Sí** (Generate Domain) |

> Si algún servicio tiene un "Custom Start Command" puesto, **bórralo** (Settings → Deploy) para que
> corra el CMD del Dockerfile (`scripts/start.sh`), que lee `SERVICE`.

La **api** aplica migraciones + seed al arrancar; el **worker** se reconecta solo hasta que la BD esté lista.

## 3) Variables de entorno
Usa las **variables de referencia** de Railway (`${{Servicio.VAR}}`) para no copiar valores a mano.

### Servicio `api`
```
PERSISTENCE=postgres
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
API_SELF_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
WEB_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
KMS_MASTER_KEY=<genera uno estable — ver abajo>     # OBLIGATORIO: cifra los tokens de conectores
JWT_SECRET=<genera uno estable>                      # OBLIGATORIO: firma las sesiones
# Conectores (opcional, cuando registres las apps OAuth):
SLACK_CLIENT_ID=...     SLACK_CLIENT_SECRET=...
JIRA_CLIENT_ID=...      JIRA_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...    GITHUB_CLIENT_SECRET=...
```

### Servicio `worker`
```
PERSISTENCE=postgres
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
API_SELF_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
KMS_MASTER_KEY=<el MISMO que la api>                 # para descifrar los tokens
```

### Servicio `web` (build-time)
```
VITE_API_URL=https://${{api.RAILWAY_PUBLIC_DOMAIN}}
```
> `VITE_API_URL` se hornea en el bundle **al construir**; si cambias el dominio de la api, **redeploy**
> del servicio web. El `Dockerfile` lo recibe como build ARG automáticamente.

**Generar secretos** (localmente):
```bash
openssl rand -hex 32   # sirve para KMS_MASTER_KEY y para JWT_SECRET
```

## 4) Conectores OAuth (Slack/Jira/GitHub)
Ya con el dominio estable de la api, la Redirect URL deja de cambiar:
```
https://<api>.up.railway.app/connectors/callback
```
Pégala en tu app de Slack (**OAuth & Permissions → Redirect URLs**) / Jira (Callback URL), pon los
`*_CLIENT_ID/SECRET` en el servicio `api`, y **activa Public Distribution** en Slack para que
funcione en cualquier workspace. El proveedor `dev` no está disponible en producción.

## Notas importantes
- **Auth de desarrollo**: este despliegue usa el endpoint `/auth/token` (dev) para la sesión, porque
  aún no hay OIDC. Por eso **NO** pongas `NODE_ENV=production` (deshabilitaría ese login y la app
  quedaría sin acceso). Trátalo como **staging/demo**. Para un prod real: cablea OIDC y entonces sí
  `NODE_ENV=production`.
- **Migraciones**: automáticas en el arranque de la api (`prisma migrate deploy`, idempotente).
- **Escalado**: si pones varias réplicas de la api, mueve la migración a un *release command* para
  evitar carreras. Con una réplica no hace falta.
- **RLS (2ª barrera tenant)** es opt-in: para activarla, crea el rol restringido y aplica las
  políticas (`packages/infra/prisma/roles.sql` + `rls.sql`), fija `RLS_ENABLED=1` y `DATABASE_URL_RLS`.
