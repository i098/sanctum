-- Versioned profile embeddings for exact cosine needs/offers matching (models slice, T04).
-- Normalized little-endian float32 bytes; zero, invalid and dimension-mismatched vectors are rejected.
CREATE TABLE profile_embeddings (
  workspace_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  kind ENUM('profile', 'needs', 'offers') NOT NULL,
  model VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  dimension SMALLINT UNSIGNED NOT NULL,
  embedding VARBINARY(16384) NOT NULL,
  source_revision INT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (profile_id, kind, model),
  KEY profile_embeddings_scope_idx (workspace_id, kind, model),
  CONSTRAINT profile_embeddings_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id),
  CONSTRAINT profile_embeddings_bytes CHECK (dimension > 0 AND LENGTH(embedding) = dimension * 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
