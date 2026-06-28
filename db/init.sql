-- ============================================================
--  ApiForge — Platform Meta Schema
--  Run this file once to initialize the platform database.
--  psql -U postgres -d apiforge -f db/init.sql
-- ============================================================

-- ─────────────────────────────────────────
--  TABLES
-- ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id                    SERIAL PRIMARY KEY,
  user_id               INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  schema_name           TEXT UNIQUE NOT NULL,
  auth_enabled          BOOLEAN DEFAULT FALSE,
  auth_table            TEXT,
  auth_email_column     TEXT,
  auth_password_column  TEXT,
  api_key               TEXT UNIQUE NOT NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS project_tables (
  id          SERIAL PRIMARY KEY,
  project_id  INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  table_name  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, table_name)
);

CREATE TABLE IF NOT EXISTS table_columns (
  id           SERIAL PRIMARY KEY,
  table_id     INT NOT NULL REFERENCES project_tables(id) ON DELETE CASCADE,
  column_name  TEXT NOT NULL,
  data_type    TEXT NOT NULL CHECK (data_type IN ('text','integer','boolean','timestamptz')),
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(table_id, column_name)
);

CREATE TABLE IF NOT EXISTS api_definitions (
  id               SERIAL PRIMARY KEY,
  project_id       INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  api_name         TEXT NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('GET','POST','PUT','DELETE')),
  target_table     TEXT NOT NULL,
  where_column     TEXT,
  where_source     TEXT CHECK (where_source IN ('query','body')),
  insert_columns   TEXT[],
  update_columns   TEXT[],
  requires_auth    BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, api_name, method)
);

CREATE TABLE IF NOT EXISTS api_logs (
  id                  SERIAL PRIMARY KEY,
  api_definition_id   INT REFERENCES api_definitions(id) ON DELETE SET NULL,
  called_at           TIMESTAMPTZ DEFAULT NOW(),
  status_code         INT,
  ip_address          TEXT,
  method              TEXT,
  project_id          INT REFERENCES projects(id) ON DELETE SET NULL
);


-- ─────────────────────────────────────────
--  FUNCTION: generate_api_key
--  Generates a random hex API key.
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION generate_api_key()
RETURNS TEXT AS $$
BEGIN
  RETURN 'af_' || encode(gen_random_bytes(24), 'hex');
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────
--  FUNCTION: validate_identifier
--  Ensures table/column names are safe.
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION validate_identifier(name TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN name ~ '^[a-zA-Z_][a-zA-Z0-9_]*$';
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────
--  PROCEDURE: create_project_schema
--  Creates an isolated PostgreSQL schema for a project.
--  Called inside a transaction when a project is created.
-- ─────────────────────────────────────────
CREATE OR REPLACE PROCEDURE create_project_schema(p_schema_name TEXT)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', p_schema_name);
END;
$$;


-- ─────────────────────────────────────────
--  PROCEDURE: drop_project_schema
--  Drops the entire schema when a project is deleted.
-- ─────────────────────────────────────────
CREATE OR REPLACE PROCEDURE drop_project_schema(p_schema_name TEXT)
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', p_schema_name);
END;
$$;


-- ─────────────────────────────────────────
--  TRIGGER FUNCTION: log_api_call
--  Automatically logs every insert into api_logs.
--  (The Node.js layer inserts into api_logs;
--   this trigger stamps the called_at timestamp.)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION stamp_api_log_time()
RETURNS TRIGGER AS $$
BEGIN
  NEW.called_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stamp_api_log ON api_logs;
CREATE TRIGGER trg_stamp_api_log
  BEFORE INSERT ON api_logs
  FOR EACH ROW
  EXECUTE FUNCTION stamp_api_log_time();


-- ─────────────────────────────────────────
--  TRIGGER FUNCTION: prevent_reserved_api_names
--  Blocks users from naming their APIs
--  'register' or 'login' (reserved by platform).
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_reserved_api_names()
RETURNS TRIGGER AS $$
BEGIN
  IF LOWER(NEW.api_name) IN ('register', 'login') THEN
    RAISE EXCEPTION 'API name "%" is reserved by the platform.', NEW.api_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reserved_api_names ON api_definitions;
CREATE TRIGGER trg_reserved_api_names
  BEFORE INSERT OR UPDATE ON api_definitions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_reserved_api_names();


-- ─────────────────────────────────────────
--  VIEW: project_api_stats
--  Complex query: call counts + last called per API.
--  Used in the dashboard.
-- ─────────────────────────────────────────
CREATE OR REPLACE VIEW project_api_stats AS
SELECT
  ad.id              AS api_id,
  ad.project_id,
  ad.api_name,
  ad.method,
  COUNT(al.id)       AS total_calls,
  MAX(al.called_at)  AS last_called,
  SUM(CASE WHEN al.status_code >= 400 THEN 1 ELSE 0 END) AS error_count
FROM api_definitions ad
LEFT JOIN api_logs al ON al.api_definition_id = ad.id
GROUP BY ad.id, ad.project_id, ad.api_name, ad.method;
