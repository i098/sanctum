-- Provider-local speaker tracks and optional explicit voice enrollment (meetings slice, T14).

CREATE TABLE speaker_tracks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  track SMALLINT UNSIGNED NOT NULL,
  provider_connection_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Label is only meaningful within its provider connection; never an identity across streams.
  provider_label VARCHAR(64) NOT NULL,
  sample_start BIGINT UNSIGNED NOT NULL,
  sample_end BIGINT UNSIGNED NOT NULL,
  profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  mapping_source ENUM('enrollment', 'user_confirmed') NULL,
  attribution_revision INT UNSIGNED NOT NULL,
  confidence DOUBLE NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY speaker_tracks_owned (workspace_id, id),
  UNIQUE KEY speaker_tracks_turn (provider_connection_id, provider_label, sample_start),
  KEY speaker_tracks_source_idx (epoch_id, track, sample_start),
  CONSTRAINT speaker_tracks_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT speaker_tracks_connection FOREIGN KEY (workspace_id, provider_connection_id) REFERENCES provider_connections (workspace_id, id),
  CONSTRAINT speaker_tracks_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id),
  CONSTRAINT speaker_tracks_range CHECK (sample_end > sample_start),
  CONSTRAINT speaker_tracks_mapping CHECK ((profile_id IS NULL) = (mapping_source IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every mapping change of one provider-local label, so notes/memory can be recomputed from the history.
CREATE TABLE speaker_attributions (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_connection_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider_label VARCHAR(64) NOT NULL,
  attribution_revision INT UNSIGNED NOT NULL,
  profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  mapping_source ENUM('enrollment', 'user_confirmed') NULL,
  confidence DOUBLE NULL,
  actor_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (provider_connection_id, provider_label, attribution_revision),
  CONSTRAINT speaker_attributions_connection FOREIGN KEY (workspace_id, provider_connection_id) REFERENCES provider_connections (workspace_id, id),
  CONSTRAINT speaker_attributions_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Never exposed through ordinary context reads; voice matches are attribution evidence, never authentication.
CREATE TABLE voice_enrollments (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  provider VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  -- Provider voiceprint (pyannote returns a base64 blob that callers must store themselves).
  voiceprint TEXT CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  consent_version VARCHAR(32) NOT NULL,
  consented_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  KEY voice_enrollments_profile_idx (workspace_id, profile_id),
  CONSTRAINT voice_enrollments_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT voice_enrollments_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
