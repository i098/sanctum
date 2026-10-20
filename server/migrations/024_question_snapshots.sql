-- A question's ordered candidate ids, fixed by its first page; a search cursor names a snapshot, a position and the held picks,
-- so later pages ground the same candidates however items change in between. Rows expire after a day.
CREATE TABLE question_snapshots (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  permission_revision BIGINT UNSIGNED NOT NULL,
  query_key CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  item_ids JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  KEY question_snapshots_created_idx (created_at),
  CONSTRAINT question_snapshots_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
