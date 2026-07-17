-- M81 (endurecimiento de la memoria del agente).
--
-- 1) `ownerId` pasa a NOT NULL. El runtime SIEMPRE escribe un owner (la ejecución, el agente o el workspace),
--    así que una fila sin owner es inalcanzable: se normaliza en vez de borrarse.
UPDATE "Memory" SET "ownerId" = '' WHERE "ownerId" IS NULL;
ALTER TABLE "Memory" ALTER COLUMN "ownerId" SET NOT NULL;

-- 2) Colapsa duplicados de (workspace, scope, owner, key) antes de imponer el UNIQUE. Sin él, dos escrituras
--    concurrentes creaban filas hermanas y la lectura (findFirst, sin orderBy) devolvía una arbitraria: la
--    memoria del agente era no determinista. Conservamos una por grupo.
DELETE FROM "Memory" a
USING "Memory" b
WHERE a."workspaceId" = b."workspaceId"
  AND a."scope" = b."scope"
  AND a."ownerId" = b."ownerId"
  AND a."key" = b."key"
  AND a."id" < b."id";

-- 3) El UNIQUE habilita el upsert atómico (fin de la carrera lectura-modificación-escritura).
CREATE UNIQUE INDEX "Memory_workspaceId_scope_ownerId_key_key" ON "Memory"("workspaceId", "scope", "ownerId", "key");

-- 4) La memoria «solo esta ejecución» caduca; el índice sostiene tanto el filtro de lectura como la purga.
CREATE INDEX "Memory_expiresAt_idx" ON "Memory"("expiresAt");
