-- A new database only. Never run this against the old electricity-bill-api database.
-- No credentials or IP addresses are stored in this throttle table.
CREATE TABLE auth_budget (
  id TEXT PRIMARY KEY CHECK (id = 'family'),
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0)
);
CREATE TABLE app_state (
  id TEXT PRIMARY KEY CHECK (id = 'main'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  seed_source TEXT NOT NULL,
  seed_sha256 TEXT NOT NULL,
  seed_source_revision INTEGER
);
CREATE TABLE state_versions (
  revision INTEGER PRIMARY KEY,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  mutation_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL
);
-- Both the original seed and each accepted write are snapshotted in the same
-- SQLite statement/transaction as the canonical row. A snapshot failure rolls
-- back the write. No best-effort write followed by a separate history call.
CREATE TRIGGER snapshot_initial AFTER INSERT ON app_state BEGIN
  INSERT INTO state_versions SELECT revision,payload,updated_at,actor,mutation_id,request_hash
  FROM app_state WHERE id = NEW.id;
  INSERT INTO baseline_receipt (id,source,source_sha256,source_revision,imported_at)
  VALUES ('main',NEW.seed_source,NEW.seed_sha256,NEW.seed_source_revision,NEW.updated_at);
END;
CREATE TRIGGER snapshot_update AFTER UPDATE ON app_state BEGIN
  INSERT INTO state_versions SELECT revision,payload,updated_at,actor,mutation_id,request_hash
  FROM app_state WHERE id = NEW.id;
END;
CREATE TRIGGER versions_no_update BEFORE UPDATE ON state_versions BEGIN
  SELECT RAISE(ABORT, 'version_history_is_immutable');
END;
CREATE TRIGGER versions_no_delete BEFORE DELETE ON state_versions BEGIN
  SELECT RAISE(ABORT, 'version_history_is_immutable');
END;
CREATE TABLE baseline_receipt (
  id TEXT PRIMARY KEY CHECK (id = 'main'),
  source TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_revision INTEGER,
  imported_at TEXT NOT NULL
);
