-- Provider connection offsets, transcript segments and final-coverage ranges (media slice).

-- One provider socket attempt; returned offsets map to epoch samples through anchor_sample.
CREATE TABLE provider_connections (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  track SMALLINT UNSIGNED NOT NULL,
  purpose ENUM('asr', 'diarization', 'batch_asr', 'batch_diarization') NOT NULL,
  provider VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  anchor_sample BIGINT UNSIGNED NOT NULL,
  sample_rate INT UNSIGNED NOT NULL,
  opened_at DATETIME(6) NOT NULL,
  closed_at DATETIME(6) NULL,
  close_reason VARCHAR(64) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY provider_connections_owned (workspace_id, id),
  CONSTRAINT provider_connections_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Immutable evidence; corrections insert a higher revision instead of rewriting text.
-- speaker_track_id references speaker_tracks (006) and is validated by the speakers slice.
CREATE TABLE transcript_segments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  track SMALLINT UNSIGNED NOT NULL,
  sample_start BIGINT UNSIGNED NOT NULL,
  sample_end BIGINT UNSIGNED NOT NULL,
  text TEXT NOT NULL,
  status ENUM('partial', 'final') NOT NULL,
  revision INT UNSIGNED NOT NULL,
  origin ENUM('live', 'batch', 'correction') NOT NULL,
  provider VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_connection_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  speaker_label VARCHAR(64) NULL,
  speaker_track_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  confidence DOUBLE NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY transcript_segments_owned (workspace_id, id),
  UNIQUE KEY transcript_segments_source (epoch_id, track, sample_start, sample_end, revision),
  CONSTRAINT transcript_segments_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT transcript_segments_connection FOREIGN KEY (workspace_id, provider_connection_id) REFERENCES provider_connections (workspace_id, id),
  CONSTRAINT transcript_segments_range CHECK (sample_end > sample_start),
  CONSTRAINT transcript_segments_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Half-open ranges with final transcript coverage; gaps here are what reconciliation schedules.
CREATE TABLE transcript_coverage (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  track SMALLINT UNSIGNED NOT NULL,
  sample_start BIGINT UNSIGNED NOT NULL,
  sample_end BIGINT UNSIGNED NOT NULL,
  origin ENUM('live', 'batch') NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (epoch_id, track, sample_start),
  CONSTRAINT transcript_coverage_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT transcript_coverage_range CHECK (sample_end > sample_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
