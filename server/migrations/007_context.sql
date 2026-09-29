-- Attributed, revisioned context items, committed-order change events and external artifacts (context slice).

-- Research reports, documents and action outputs that context items can cite.
CREATE TABLE artifacts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  kind ENUM('research', 'document', 'export', 'action_output') NOT NULL,
  title VARCHAR(300) NOT NULL,
  content_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content MEDIUMTEXT NULL,
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NULL,
  sha256 BINARY(32) NOT NULL,
  provenance JSON NOT NULL,
  created_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY artifacts_owned (workspace_id, id),
  CONSTRAINT artifacts_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT artifacts_body CHECK (content IS NOT NULL OR object_key IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Immutable (id, revision) rows; a revision supersedes an earlier one instead of overwriting it.
CREATE TABLE context_items (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT UNSIGNED NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  kind ENUM('decision', 'commitment', 'constraint', 'project_fact', 'preference', 'open_question', 'research_observation') NOT NULL,
  text TEXT NOT NULL,
  state ENUM('provisional', 'committed', 'superseded') NOT NULL,
  derivation ENUM('spoken', 'inferred', 'human_correction', 'external') NOT NULL,
  event_at DATETIME(6) NULL,
  valid_from DATETIME(6) NULL,
  valid_until DATETIME(6) NULL,
  time_expression JSON NULL,
  sources JSON NOT NULL,
  author_type ENUM('human', 'agent', 'system') NOT NULL,
  author_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  supersedes_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  supersedes_revision INT UNSIGNED NULL,
  idempotency_key VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NULL,
  payload_sha256 BINARY(32) NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id, revision),
  UNIQUE KEY context_items_idempotency (workspace_id, author_principal_id, idempotency_key),
  KEY context_items_meeting_idx (workspace_id, meeting_id, state),
  KEY context_items_event_idx (workspace_id, event_at),
  FULLTEXT KEY context_items_text (text),
  CONSTRAINT context_items_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT context_items_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT context_items_supersedes FOREIGN KEY (supersedes_id, supersedes_revision) REFERENCES context_items (id, revision),
  CONSTRAINT context_items_idempotent CHECK ((idempotency_key IS NULL) = (payload_sha256 IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- seq comes from workspaces.context_seq under a row lock in the same transaction as the change.
CREATE TABLE context_events (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seq BIGINT UNSIGNED NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  item_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  item_revision INT UNSIGNED NULL,
  change_kind ENUM('item_added', 'item_revised', 'item_superseded', 'meeting_boundary_changed', 'access_changed') NOT NULL,
  actor_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_revision BIGINT UNSIGNED NULL,
  permission_revision BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (workspace_id, seq),
  KEY context_events_meeting_idx (workspace_id, meeting_id, seq),
  CONSTRAINT context_events_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT context_events_item FOREIGN KEY (item_id, item_revision) REFERENCES context_items (id, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Final transcript segments a meeting's context job has read: the source watermark and retry idempotency.
CREATE TABLE context_processed_segments (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  segment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  processed_at DATETIME(6) NOT NULL,
  PRIMARY KEY (workspace_id, meeting_id, segment_id),
  CONSTRAINT context_processed_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT context_processed_segment FOREIGN KEY (workspace_id, segment_id) REFERENCES transcript_segments (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
