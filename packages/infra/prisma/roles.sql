-- Rol de APLICACIÓN restringido para que RLS (rls.sql) tenga efecto.
--
-- RLS NO aplica a superusuarios ni a roles con BYPASSRLS: el rol de migraciones/seed (owner,
-- superusuario) los salta a propósito (operaciones de sistema). La app en runtime debe conectar
-- con un rol SIN esos privilegios para que las políticas de `rls.sql` lo obliguen.
--
-- La contraseña aquí es solo para DESARROLLO local. En producción usa un secreto gestionado y
-- pásalo por `DATABASE_URL_RLS` (ver apps/*/.env). Idempotente: re-ejecutable sin error.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agentflow_app') THEN
    CREATE ROLE agentflow_app LOGIN PASSWORD 'agentflow_app_dev_pw'
      NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE agentflow_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- Puede usar el esquema y operar sobre las tablas existentes (NO es owner ⇒ RLS aplica).
GRANT USAGE ON SCHEMA public TO agentflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agentflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agentflow_app;

-- Tablas/secuencias futuras (nuevas migraciones) heredan los mismos permisos.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentflow_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agentflow_app;

-- El rol de aplicación NO debe tocar el historial de migraciones de Prisma.
REVOKE ALL ON TABLE "_prisma_migrations" FROM agentflow_app;
