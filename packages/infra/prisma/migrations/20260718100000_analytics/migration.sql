-- M84: product analytics.
--
-- `AnalyticsEvent` es la única tabla caliente. NO se particiona hoy (Prisma 5 no emite PARTITION BY y
-- editar la migración a mano dejaría a `prisma migrate dev` reportando drift para siempre), pero la clave
-- ya empieza por tiempo: si algún día hace falta particionar, la parte cara está hecha.

CREATE TABLE "AnalyticsEvent" (
    "at"          TIMESTAMPTZ  NOT NULL,
    "id"          UUID         NOT NULL,
    "receivedAt"  TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspaceId" TEXT         NOT NULL,
    "userId"      TEXT         NOT NULL,
    "sessionId"   UUID         NOT NULL,
    "seq"         INTEGER      NOT NULL,
    "name"        TEXT         NOT NULL,
    "surface"     TEXT         NOT NULL,
    "tab"         TEXT         NOT NULL DEFAULT '',
    "entityType"  TEXT         NOT NULL DEFAULT '',
    "entityId"    TEXT         NOT NULL DEFAULT '',
    "durationMs"  INTEGER,
    "props"       JSONB        NOT NULL DEFAULT '{}',
    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("at","id")
);
CREATE INDEX "AnalyticsEvent_workspaceId_at_idx"      ON "AnalyticsEvent"("workspaceId", "at" DESC);
CREATE INDEX "AnalyticsEvent_workspaceId_name_at_idx" ON "AnalyticsEvent"("workspaceId", "name", "at" DESC);
CREATE INDEX "AnalyticsEvent_at_idx"                  ON "AnalyticsEvent"("at");

CREATE TABLE "AnalyticsHourlyView" (
    "workspaceId"  TEXT        NOT NULL,
    "hour"         TIMESTAMPTZ NOT NULL,
    "surface"      TEXT        NOT NULL,
    "tab"          TEXT        NOT NULL DEFAULT '',
    "views"        INTEGER     NOT NULL DEFAULT 0,
    "sessions"     INTEGER     NOT NULL DEFAULT 0,
    "dwellMs"      BIGINT      NOT NULL DEFAULT 0,
    "dwellSamples" INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT "AnalyticsHourlyView_pkey" PRIMARY KEY ("workspaceId","hour","surface","tab")
);
CREATE INDEX "AnalyticsHourlyView_hour_idx" ON "AnalyticsHourlyView"("hour");

CREATE TABLE "AnalyticsHourlyEvent" (
    "workspaceId" TEXT        NOT NULL,
    "hour"        TIMESTAMPTZ NOT NULL,
    "name"        TEXT        NOT NULL,
    "entityType"  TEXT        NOT NULL DEFAULT '',
    "entityId"    TEXT        NOT NULL DEFAULT '',
    "count"       INTEGER     NOT NULL DEFAULT 0,
    "users"       INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT "AnalyticsHourlyEvent_pkey" PRIMARY KEY ("workspaceId","hour","name","entityType","entityId")
);
CREATE INDEX "AnalyticsHourlyEvent_hour_idx" ON "AnalyticsHourlyEvent"("hour");

-- Conjunto persona×día: los únicos no se suman entre horas. Se conserva siempre.
CREATE TABLE "AnalyticsUserDay" (
    "workspaceId"  TEXT   NOT NULL,
    "day"          DATE   NOT NULL,
    "userId"       TEXT   NOT NULL,
    "firstSeenDay" DATE   NOT NULL,
    "sessions"     INTEGER NOT NULL DEFAULT 0,
    "activeMs"     BIGINT  NOT NULL DEFAULT 0,
    CONSTRAINT "AnalyticsUserDay_pkey" PRIMARY KEY ("workspaceId","day","userId")
);
CREATE INDEX "AnalyticsUserDay_day_idx" ON "AnalyticsUserDay"("day");
CREATE INDEX "AnalyticsUserDay_workspaceId_firstSeenDay_idx" ON "AnalyticsUserDay"("workspaceId","firstSeenDay");

CREATE TABLE "AnalyticsSession" (
    "id"           UUID        NOT NULL,
    "workspaceId"  TEXT        NOT NULL,
    "userId"       TEXT        NOT NULL,
    "startedAt"    TIMESTAMPTZ NOT NULL,
    "lastSeenAt"   TIMESTAMPTZ NOT NULL,
    "activeMs"     BIGINT      NOT NULL DEFAULT 0,
    "eventCount"   INTEGER     NOT NULL DEFAULT 0,
    "device"       TEXT,
    "browser"      TEXT,
    "os"           TEXT,
    "timezone"     TEXT,
    "country"      TEXT,
    "entrySurface" TEXT,
    "exitSurface"  TEXT,
    CONSTRAINT "AnalyticsSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AnalyticsSession_workspaceId_startedAt_idx" ON "AnalyticsSession"("workspaceId","startedAt" DESC);
CREATE INDEX "AnalyticsSession_startedAt_idx" ON "AnalyticsSession"("startedAt");

-- Inventario: sin esto, una función que no se usa NUNCA es invisible (no deja filas contra las que cruzar).
CREATE TABLE "AnalyticsFeature" (
    "kind"              TEXT NOT NULL,
    "key"               TEXT NOT NULL,
    "label"             TEXT NOT NULL,
    "instrumentedSince" DATE NOT NULL,
    "retiredAt"         DATE,
    CONSTRAINT "AnalyticsFeature_pkey" PRIMARY KEY ("kind","key")
);

CREATE TABLE "AnalyticsRollupWatermark" (
    "bucket"        TEXT        NOT NULL,
    "sealedThrough" TIMESTAMPTZ NOT NULL,
    "lastRunAt"     TIMESTAMPTZ NOT NULL,
    "metrics"       JSONB       NOT NULL DEFAULT '{}',
    CONSTRAINT "AnalyticsRollupWatermark_pkey" PRIMARY KEY ("bucket")
);

-- Texto de búsqueda en claro SOLO cuando lo han tecleado 5+ personas distintas (ver el rollup).
CREATE TABLE "AnalyticsSearchTerm" (
    "workspaceId" TEXT    NOT NULL,
    "day"         DATE    NOT NULL,
    "queryHash"   TEXT    NOT NULL,
    "scope"       TEXT    NOT NULL,
    "text"        TEXT    NOT NULL,
    "users"       INTEGER NOT NULL DEFAULT 0,
    "searches"    INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AnalyticsSearchTerm_pkey" PRIMARY KEY ("workspaceId","day","queryHash")
);
CREATE INDEX "AnalyticsSearchTerm_workspaceId_day_idx" ON "AnalyticsSearchTerm"("workspaceId","day");
