-- Links a workspace to the organization that its sign-in issuer (WorkOS, Better Auth) keeps for it.
-- An MCP token `org_id` claim selects the linked workspace under the token issuer.
-- One organization per issuer and workspace; the issuer stays the source of org membership.
CREATE TABLE workspace_orgs (
  issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  org_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (issuer, org_id),
  UNIQUE KEY workspace_orgs_workspace_issuer (workspace_id, issuer),
  CONSTRAINT workspace_orgs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Resume point of each provider event feed (for example the WorkOS Events API), keyed by feed name.
CREATE TABLE sync_cursors (
  name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `cursor` VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
