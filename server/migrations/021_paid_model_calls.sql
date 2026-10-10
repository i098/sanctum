-- Paid model calls (web research), reserved before each request is sent so a workspace's daily allowance holds
-- across workers and retries. Usage is the provider's own report; NULL tokens mean no answer was recorded.
CREATE TABLE paid_model_calls (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  model VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at DATETIME(6) NOT NULL,
  finished_at DATETIME(6) NULL,
  input_tokens INT UNSIGNED NULL,
  output_tokens INT UNSIGNED NULL,
  web_searches INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY paid_model_calls_day_idx (workspace_id, started_at),
  CONSTRAINT paid_model_calls_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
