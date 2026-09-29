-- Meetings, access, revisioned source ownership ranges, boundary audit and assembled recordings (meetings slice).

CREATE TABLE meetings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capture_group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  listener_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  state ENUM('provisional', 'active', 'closing', 'closed', 'interrupted') NOT NULL,
  title VARCHAR(300) NULL,
  timezone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at DATETIME(6) NOT NULL,
  ended_at DATETIME(6) NULL,
  boundary_revision INT UNSIGNED NOT NULL DEFAULT 1,
  visibility ENUM('restricted', 'workspace') NOT NULL DEFAULT 'restricted',
  processing JSON NOT NULL,
  notes JSON NULL,
  notes_revision INT UNSIGNED NOT NULL DEFAULT 0,
  context_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY meetings_owned (workspace_id, id),
  KEY meetings_started_idx (workspace_id, started_at),
  CONSTRAINT meetings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT meetings_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id),
  CONSTRAINT meetings_group FOREIGN KEY (workspace_id, capture_group_id) REFERENCES capture_groups (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Restrictive default: a restricted meeting is visible only to principals listed here.
CREATE TABLE meeting_access (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  access ENUM('read', 'write', 'owner') NOT NULL,
  granted_by CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (meeting_id, principal_id),
  KEY meeting_access_principal_idx (workspace_id, principal_id),
  CONSTRAINT meeting_access_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT meeting_access_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Half-open [sample_start, sample_end) ownership per boundary revision; one owner per sample per revision.
CREATE TABLE meeting_ranges (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  boundary_revision INT UNSIGNED NOT NULL,
  epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  track SMALLINT UNSIGNED NOT NULL,
  sample_start BIGINT UNSIGNED NOT NULL,
  sample_end BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (meeting_id, boundary_revision, epoch_id, track, sample_start),
  KEY meeting_ranges_source_idx (epoch_id, track, sample_start),
  CONSTRAINT meeting_ranges_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT meeting_ranges_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT meeting_ranges_range CHECK (sample_end > sample_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Audit of automatic and manual boundary changes (start/close/split/merge/interrupt).
CREATE TABLE boundary_events (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  boundary_revision INT UNSIGNED NOT NULL,
  operation ENUM('start', 'promote', 'close', 'split', 'merge', 'interrupt') NOT NULL,
  decision JSON NOT NULL,
  actor_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY boundary_events_revision (meeting_id, boundary_revision, operation),
  CONSTRAINT boundary_events_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Revisioned assembled audio; playback URLs reference the current boundary revision's cut.
CREATE TABLE meeting_recordings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  meeting_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  boundary_revision INT UNSIGNED NOT NULL,
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sha256 BINARY(32) NOT NULL,
  byte_length BIGINT UNSIGNED NOT NULL,
  sample_rate INT UNSIGNED NOT NULL,
  sample_count BIGINT UNSIGNED NOT NULL,
  -- Source ranges actually present in the file, in playback order; meeting ranges minus these are gaps.
  pieces JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY meeting_recordings_revision (meeting_id, boundary_revision),
  CONSTRAINT meeting_recordings_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
