-- Durable job ledger (kernel slice). Claim: SELECT ... FOR UPDATE SKIP LOCKED on (status, available_at).
-- At most one active (pending/running/paused) job per (workspace, kind, work_key): coalesced work
-- re-arms the active row; finished rows keep history because active_work_key becomes NULL.
CREATE TABLE jobs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  work_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Principal on whose behalf the job runs; the worker re-resolves its access before acting.
  requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_revision BIGINT UNSIGNED NULL,
  status ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled', 'paused') NOT NULL,
  active_work_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (IF(status IN ('pending', 'running', 'paused'), work_key, NULL)) STORED,
  payload JSON NOT NULL,
  available_at DATETIME(6) NOT NULL,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_until DATETIME(6) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL,
  -- Coalesced work arrived while running: completion returns the row to pending instead of finishing.
  rearmed TINYINT(1) NOT NULL DEFAULT 0,
  result JSON NULL,
  last_error JSON NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY jobs_owned (workspace_id, id),
  UNIQUE KEY jobs_active (workspace_id, kind, active_work_key),
  KEY jobs_claim_idx (status, available_at),
  KEY jobs_expired_lease_idx (status, lease_until),
  CONSTRAINT jobs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT jobs_requester FOREIGN KEY (workspace_id, requested_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT jobs_attempts CHECK (max_attempts > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
