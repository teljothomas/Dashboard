-- Dev DB bootstrap (runs once on an empty data volume, as the postgres superuser).
-- Roles:  tradex_owner = owns databases and runs migrations (DDL)
--         tradex_app   = runtime role, DML only (no DDL, no superuser)
-- Passwords come from the container environment (psql \getenv, PostgreSQL 15+); none are stored in git.
\set ON_ERROR_STOP on

\getenv owner_pw TRADEX_OWNER_PASSWORD
\getenv app_pw TRADEX_APP_PASSWORD

CREATE ROLE tradex_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE tradex_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;

-- tradex_dev is created by the image (POSTGRES_DB); hand it to the owner role.
ALTER DATABASE tradex_dev OWNER TO tradex_owner;
CREATE DATABASE tradex_test OWNER tradex_owner;

REVOKE ALL ON DATABASE tradex_dev FROM PUBLIC;
REVOKE ALL ON DATABASE tradex_test FROM PUBLIC;
GRANT CONNECT ON DATABASE tradex_dev TO tradex_app;
GRANT CONNECT ON DATABASE tradex_test TO tradex_app;

-- Per-database schema grants. Objects created later by tradex_owner (migrations) get DML-only
-- access for tradex_app automatically through default privileges.
\connect tradex_dev
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO tradex_owner;
GRANT USAGE ON SCHEMA public TO tradex_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tradex_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tradex_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tradex_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tradex_app;

\connect tradex_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO tradex_owner;
GRANT USAGE ON SCHEMA public TO tradex_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tradex_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tradex_app;
ALTER DEFAULT PRIVILEGES FOR ROLE tradex_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tradex_app;
