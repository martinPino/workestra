-- Row-Level Security (RLS): SEGUNDA barrera de aislamiento entre tenants (defensa en profundidad
-- sobre el scoping de la aplicación, M8). Se aplica tras `prisma migrate` con:
--   pnpm --filter @core/infra rls:apply     (o psql -f prisma/rls.sql)
--
-- Política SEGURA por diseño: si el tenant NO está fijado (operaciones de SISTEMA), la fila es
-- visible (modo sistema). Cuando la API fija el tenant por transacción, RLS FILTRA a ese workspace
-- aunque el chequeo de aplicación fallara:
--   SELECT set_config('app.current_workspace', '<workspaceId>', TRUE);
--
-- IMPORTANTE (gotcha de Postgres): `app.current_workspace` es un GUC "placeholder" (con punto y no
-- declarado). Tras un SET LOCAL, al terminar la transacción el valor NO revierte a NULL sino a ''
-- (cadena vacía) en esa conexión del pool. Por eso NO comparamos con `IS NULL` directo: usamos la
-- función `app_current_workspace()` que normaliza '' → NULL, de modo que "sin tenant" (NULL o '')
-- signifique siempre modo sistema de forma consistente sea cual sea el historial de la conexión.
--
-- Por qué existe el modo sistema (fail-open): el rol OWNER (migraciones, seed, worker) es
-- superusuario/BYPASSRLS y NUNCA evalúa estas políticas, así que esa rama solo la ve el rol
-- RESTRINGIDO agentflow_app. La necesita para la única consulta legítimamente PRE-tenant: resolver
-- el webhook por token en `/hooks/:token` (aún no se conoce el tenant). El servicio de webhooks fija
-- el workspace justo tras resolver el token, así TODO lo demás corre tenant-scoped.
--
-- Idempotente: se puede re-aplicar sin error.

-- Tenant efectivo del contexto: '' (residuo de placeholder GUC) se normaliza a NULL = modo sistema.
CREATE OR REPLACE FUNCTION app_current_workspace() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.current_workspace', true), '') $$;

-- ---- Tablas con workspaceId DIRECTO ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Workflow','Agent','Execution','Webhook','ScheduledTrigger','Secret','Tool','Connector','Memory','Prompt','Plugin'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (app_current_workspace() IS NULL OR "workspaceId" = app_current_workspace())
        WITH CHECK (app_current_workspace() IS NULL OR "workspaceId" = app_current_workspace());
    $f$, t);
  END LOOP;
END $$;

-- ---- Tablas HIJAS por executionId (heredan el tenant de la Execution padre) ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ExecutionEventRecord','ExecutionLog','NodeRun','PendingReview'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (app_current_workspace() IS NULL
               OR EXISTS (SELECT 1 FROM "Execution" e
                          WHERE e.id = "executionId" AND e."workspaceId" = app_current_workspace()))
        WITH CHECK (app_current_workspace() IS NULL
               OR EXISTS (SELECT 1 FROM "Execution" e
                          WHERE e.id = "executionId" AND e."workspaceId" = app_current_workspace()));
    $f$, t);
  END LOOP;
END $$;

-- ---- WorkflowVersion (hereda el tenant del Workflow padre) ----
ALTER TABLE "WorkflowVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkflowVersion" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "WorkflowVersion";
CREATE POLICY tenant_isolation ON "WorkflowVersion"
  USING (app_current_workspace() IS NULL
         OR EXISTS (SELECT 1 FROM "Workflow" w
                    WHERE w.id = "workflowId" AND w."workspaceId" = app_current_workspace()))
  WITH CHECK (app_current_workspace() IS NULL
         OR EXISTS (SELECT 1 FROM "Workflow" w
                    WHERE w.id = "workflowId" AND w."workspaceId" = app_current_workspace()));

-- ---- Node y Edge (heredan el tenant vía WorkflowVersion → Workflow, dos saltos) ----
-- Contienen la definición del grafo (config de nodo, agentId/toolId, condiciones): datos de tenant.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Node','Edge'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (app_current_workspace() IS NULL
               OR EXISTS (SELECT 1 FROM "WorkflowVersion" v JOIN "Workflow" w ON w.id = v."workflowId"
                          WHERE v.id = "workflowVersionId" AND w."workspaceId" = app_current_workspace()))
        WITH CHECK (app_current_workspace() IS NULL
               OR EXISTS (SELECT 1 FROM "WorkflowVersion" v JOIN "Workflow" w ON w.id = v."workflowId"
                          WHERE v.id = "workflowVersionId" AND w."workspaceId" = app_current_workspace()));
    $f$, t);
  END LOOP;
END $$;

-- El rol restringido debe poder EJECUTAR la función (STABLE, sin efectos).
GRANT EXECUTE ON FUNCTION app_current_workspace() TO PUBLIC;
