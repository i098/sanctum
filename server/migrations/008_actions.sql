-- Pipedream account mappings, stored grants and action receipts (pipedream and actions slices).

CREATE TABLE integration_accounts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  external_user_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_account_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_slug VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('active', 'disconnected', 'revoked') NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY integration_accounts_owned (workspace_id, id),
  UNIQUE KEY integration_accounts_provider (workspace_id, provider_account_id),
  CONSTRAINT integration_accounts_owner FOREIGN KEY (workspace_id, owner_principal_id) REFERENCES workspace_members (workspace_id, principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Created only by an authorized human; a prompt can never create a grant.
CREATE TABLE action_grants (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  grantee_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  app_slug VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  restrictions JSON NOT NULL,
  expires_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY action_grants_owned (workspace_id, id),
  KEY action_grants_lookup_idx (workspace_id, grantee_principal_id, action_key),
  CONSTRAINT action_grants_owner FOREIGN KEY (workspace_id, owner_principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT action_grants_grantee FOREIGN KEY (workspace_id, grantee_principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT action_grants_account FOREIGN KEY (workspace_id, account_id) REFERENCES integration_accounts (workspace_id, id),
  CONSTRAINT action_grants_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Canonical action requests. 'unknown' blocks automatic replay until reconciled.
CREATE TABLE actions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  requested_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  idempotency_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  args JSON NOT NULL,
  args_sha256 BINARY(32) NOT NULL,
  configuration_ref VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  -- Component version the request was validated against; execution revalidates it.
  version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  grant_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  grant_version INT UNSIGNED NULL,
  state ENUM('proposed', 'awaiting_authorization', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled') NOT NULL,
  provider_idempotency_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  provider_receipt JSON NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  -- 'reconciled': the provider's late answer settled it; 'resolved_by_human': a person did (resolved_by, resolved_at).
  reconciliation ENUM('none', 'pending', 'reconciled', 'resolved_by_human') NOT NULL DEFAULT 'none',
  resolved_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  resolved_at DATETIME(6) NULL,
  last_error JSON NULL,
  -- First submission to the provider; the per-workspace rate budget counts these.
  started_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY actions_owned (workspace_id, id),
  UNIQUE KEY actions_idempotency (workspace_id, requested_by, idempotency_key),
  KEY actions_meeting_idx (workspace_id, meeting_id),
  KEY actions_started_idx (workspace_id, started_at),
  CONSTRAINT actions_requester FOREIGN KEY (workspace_id, requested_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT actions_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT actions_account FOREIGN KEY (workspace_id, account_id) REFERENCES integration_accounts (workspace_id, id),
  CONSTRAINT actions_grant FOREIGN KEY (workspace_id, grant_id) REFERENCES action_grants (workspace_id, id),
  CONSTRAINT actions_resolver FOREIGN KEY (workspace_id, resolved_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT actions_grant_version CHECK ((grant_id IS NULL) = (grant_version IS NULL)),
  CONSTRAINT actions_resolution CHECK ((resolved_by IS NULL) = (resolved_at IS NULL) AND (resolved_by IS NULL) = (reconciliation <> 'resolved_by_human'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
