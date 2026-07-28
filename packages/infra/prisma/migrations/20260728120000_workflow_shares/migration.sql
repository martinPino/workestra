-- M85: compartir un workflow por enlace. El snapshot es la copia sanitizada e inmutable.
CREATE TABLE "WorkflowShare" (
    "id"              TEXT         NOT NULL,
    "workspaceId"     TEXT         NOT NULL,
    "workflowId"      TEXT,
    "sourceName"      TEXT         NOT NULL,
    "tokenHash"       TEXT         NOT NULL,
    "snapshot"        JSONB        NOT NULL,
    "report"          JSONB        NOT NULL,
    "redactionCount"  INTEGER      NOT NULL DEFAULT 0,
    "createdByUserId" TEXT         NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"       TIMESTAMP(3),
    "revokedAt"       TIMESTAMP(3),
    "importCount"     INTEGER      NOT NULL DEFAULT 0,
    "lastImportedAt"  TIMESTAMP(3),
    "importerWorkspaceIds" TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "WorkflowShare_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkflowShare_tokenHash_key" ON "WorkflowShare"("tokenHash");
CREATE INDEX "WorkflowShare_workspaceId_idx" ON "WorkflowShare"("workspaceId");
