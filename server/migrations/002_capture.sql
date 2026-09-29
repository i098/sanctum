-- Listeners, capture groups, capture epochs and recording chunk manifests (capture and media slices).

-- Room and laptop listeners that intentionally represent the same meeting share one group lease.
CREATE TABLE capture_groups (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(200) NOT NULL,
  preferred_listener_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_listener_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_expires_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY capture_groups_owned (workspace_id, id),
  CONSTRAINT capture_groups_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE listeners (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Device principal holding the narrow capture:ingest credential.
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  capture_group_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  name VARCHAR(200) NOT NULL,
  mode ENUM('room', 'laptop') NOT NULL,
  state ENUM('stopped', 'starting', 'listening', 'reconnecting', 'paused', 'degraded') NOT NULL DEFAULT 'stopped',
  lease_generation BIGINT UNSIGNED NOT NULL DEFAULT 0,
  lease_expires_at DATETIME(6) NULL,
  current_epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  capabilities JSON NOT NULL,
  health JSON NULL,
  last_heartbeat_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY listeners_owned (workspace_id, id),
  CONSTRAINT listeners_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT listeners_group FOREIGN KEY (workspace_id, capture_group_id) REFERENCES capture_groups (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- When each lease generation was claimed: audio a device captured under generation g after
-- generation g + 1 was claimed was recorded without the lease and is refused.
CREATE TABLE listener_lease_claims (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  listener_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lease_generation BIGINT UNSIGNED NOT NULL,
  claimed_at DATETIME(6) NOT NULL,
  PRIMARY KEY (listener_id, lease_generation),
  CONSTRAINT listener_lease_claims_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One continuous sample clock. Reconnect keeps the epoch; reload/device change/restart creates one.
CREATE TABLE capture_epochs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  listener_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  lease_generation BIGINT UNSIGNED NOT NULL,
  sample_rate INT UNSIGNED NOT NULL,
  channels TINYINT UNSIGNED NOT NULL,
  encoding VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sample_start BIGINT UNSIGNED NOT NULL,
  captured_at DATETIME(6) NOT NULL,
  timezone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  start_reason ENUM('start', 'resume', 'reload', 'device_change', 'stream_restart') NOT NULL,
  started_at DATETIME(6) NOT NULL,
  -- End of the contiguous range accepted for live processing (not archive durability).
  live_sample_end BIGINT UNSIGNED NOT NULL,
  ended_at DATETIME(6) NULL,
  end_reason ENUM('pause', 'close', 'interrupted', 'device_change', 'lease_lost') NULL,
  PRIMARY KEY (id),
  UNIQUE KEY capture_epochs_owned (workspace_id, id),
  KEY capture_epochs_listener_idx (listener_id, started_at),
  CONSTRAINT capture_epochs_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id),
  CONSTRAINT capture_epochs_live CHECK (live_sample_end >= sample_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Independent mono PCM16 WAV chunks. A receipt exists only once upload_state = 'committed'.
CREATE TABLE recording_chunks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  listener_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  track SMALLINT UNSIGNED NOT NULL,
  sequence INT UNSIGNED NOT NULL,
  sample_start BIGINT UNSIGNED NOT NULL,
  sample_count INT UNSIGNED NOT NULL,
  sample_rate INT UNSIGNED NOT NULL,
  captured_at DATETIME(6) NOT NULL,
  byte_length INT UNSIGNED NOT NULL,
  sha256 BINARY(32) NOT NULL,
  object_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  upload_state ENUM('pending', 'committed') NOT NULL,
  created_at DATETIME(6) NOT NULL,
  committed_at DATETIME(6) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY recording_chunks_owned (workspace_id, id),
  UNIQUE KEY recording_chunks_sequence (epoch_id, track, sequence),
  UNIQUE KEY recording_chunks_source (epoch_id, track, sample_start),
  UNIQUE KEY recording_chunks_object (object_key),
  CONSTRAINT recording_chunks_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT recording_chunks_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id),
  CONSTRAINT recording_chunks_wav CHECK (sample_count > 0 AND byte_length = 44 + sample_count * 2),
  CONSTRAINT recording_chunks_committed CHECK ((upload_state = 'committed') = (committed_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
