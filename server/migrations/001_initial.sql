-- Identity, membership, sessions, agent credentials and matching profiles (kernel slice).
-- Conventions for every migration (docs/ARCHITECTURE.md):
--   IDs: CHAR(36) ascii_bin UUIDs; wall-clock: DATETIME(6) UTC; samples: BIGINT UNSIGNED;
--   hashes: BINARY(32); every owned table has workspace_id and references owned rows through
--   (workspace_id, id) composite foreign keys so a row can never point into another workspace.
--   Each statement is one CREATE TABLE or CREATE INDEX so interrupted runs can be inspected.

CREATE TABLE workspaces (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(200) NOT NULL,
  timezone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  context_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
  permission_revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  -- NULL means the policy is unselected; production capture refuses to activate.
  capture_policy JSON NULL,
  retention_policy JSON NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE principals (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('human', 'agent', 'device') NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  disabled_at DATETIME(6) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Verified issuer/subject pairs; membership never follows from an email domain.
CREATE TABLE principal_identities (
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  subject VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(320) NULL,
  verified_at DATETIME(6) NOT NULL,
  PRIMARY KEY (issuer, subject),
  KEY principal_identities_principal_idx (principal_id),
  CONSTRAINT principal_identities_principal FOREIGN KEY (principal_id) REFERENCES principals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE workspace_members (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role ENUM('owner', 'admin', 'member', 'agent', 'device') NOT NULL,
  created_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (workspace_id, principal_id),
  KEY workspace_members_principal_idx (principal_id),
  CONSTRAINT workspace_members_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT workspace_members_principal FOREIGN KEY (principal_id) REFERENCES principals (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- HttpOnly browser sessions bound to one workspace membership; only hashes of the cookie and
-- CSRF token are stored. Human sessions follow a verified login; device sessions follow enrollment.
CREATE TABLE browser_sessions (
  id_hash BINARY(32) NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  csrf_hash BINARY(32) NOT NULL,
  created_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  last_seen_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (id_hash),
  KEY browser_sessions_member_idx (workspace_id, principal_id),
  CONSTRAINT browser_sessions_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Plain tokens are returned once and never stored or logged.
CREATE TABLE agent_credentials (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash BINARY(32) NOT NULL,
  scopes JSON NOT NULL,
  -- NULL: every meeting the agent principal may access; otherwise a JSON array of meeting IDs.
  meeting_allowlist JSON NULL,
  expires_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  last_used_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY agent_credentials_token (token_hash),
  UNIQUE KEY agent_credentials_owned (workspace_id, id),
  CONSTRAINT agent_credentials_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT agent_credentials_owner FOREIGN KEY (workspace_id, owner_principal_id) REFERENCES workspace_members (workspace_id, principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- People and organizations for matching and confirmed speaker mapping.
CREATE TABLE profiles (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  kind ENUM('person', 'organization') NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  details JSON NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY profiles_owned (workspace_id, id),
  CONSTRAINT profiles_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT profiles_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
