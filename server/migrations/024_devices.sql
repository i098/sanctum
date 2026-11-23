CREATE TABLE devices (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  name VARCHAR(200) NOT NULL,
  capabilities JSON NOT NULL,
  device_code_hash BINARY(32) NOT NULL,
  user_code_hash BINARY(32) NOT NULL,
  client_address_hash BINARY(32) NOT NULL,
  status ENUM('pending', 'approved', 'denied', 'revoked') NOT NULL DEFAULT 'pending',
  pending_code_hash BINARY(32) GENERATED ALWAYS AS (IF(status = 'pending', user_code_hash, NULL)) STORED,
  approved_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  credential_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  token_delivered_at DATETIME(6) NULL,
  last_polled_at DATETIME(6) NULL,
  poll_interval_seconds INT UNSIGNED NOT NULL DEFAULT 5,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  approved_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY devices_device_code (device_code_hash),
  UNIQUE KEY devices_pending_code (pending_code_hash),
  KEY devices_expiry (status, expires_at),
  KEY devices_address (status, client_address_hash),
  KEY devices_owner (workspace_id, approved_by),
  CONSTRAINT devices_member FOREIGN KEY (workspace_id, approved_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT devices_credential FOREIGN KEY (workspace_id, credential_id) REFERENCES agent_credentials (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row serializes expiry cleanup, quota checks and inserts across API processes.
CREATE TABLE device_pair_capacity (
  id TINYINT UNSIGNED PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE device_pair_attempts (
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempts JSON NOT NULL,
  PRIMARY KEY (principal_id),
  CONSTRAINT device_pair_attempts_principal FOREIGN KEY (principal_id) REFERENCES principals (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
