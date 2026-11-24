-- SQLite (Cloudflare D1) baseline: the final state of server/migrations/001..024, without the auth_* tables of the embedded issuer.
-- Standby only: scripts/d1-sync.ts fills it from TiDB; no application writes to it before switch-over (docs/d1-switchover.md).
-- Dialect map: ids, hashes and DATETIME(6) become TEXT/BLOB (UTC 'YYYY-MM-DD HH:MM:SS.ffffff'); UNSIGNED becomes CHECK (col >= 0);
-- ENUM and JSON become CHECKs; provider_label compares case-insensitively like the MySQL default collation.

CREATE TABLE workspaces (
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  context_seq INTEGER NOT NULL DEFAULT 0 CHECK (context_seq >= 0),
  permission_revision INTEGER NOT NULL DEFAULT 1 CHECK (permission_revision >= 0),
  capture_policy TEXT CHECK (json_valid(capture_policy)),
  retention_policy TEXT CHECK (json_valid(retention_policy)),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  purge_after TEXT,
  seat_limit INTEGER CHECK (seat_limit >= 0),
  PRIMARY KEY (id)
);

CREATE TABLE principals (
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'device')),
  display_name TEXT,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  email TEXT,
  onboarded_at TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE principal_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  email TEXT,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject),
  CONSTRAINT principal_identities_principal FOREIGN KEY (principal_id) REFERENCES principals (id)
);
CREATE INDEX principal_identities_principal_idx ON principal_identities (principal_id);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'agent', 'device')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  org_issuer TEXT,
  PRIMARY KEY (workspace_id, principal_id),
  CONSTRAINT workspace_members_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT workspace_members_principal FOREIGN KEY (principal_id) REFERENCES principals (id)
);
CREATE INDEX workspace_members_principal_idx ON workspace_members (principal_id);

CREATE TABLE browser_sessions (
  id_hash BLOB NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  csrf_hash BLOB NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (id_hash),
  CONSTRAINT browser_sessions_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id)
);
CREATE INDEX browser_sessions_member_idx ON browser_sessions (workspace_id, principal_id);

CREATE TABLE agent_credentials (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  token_hash BLOB NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  meeting_allowlist TEXT CHECK (json_valid(meeting_allowlist)),
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT agent_credentials_token UNIQUE (token_hash),
  CONSTRAINT agent_credentials_owned UNIQUE (workspace_id, id),
  CONSTRAINT agent_credentials_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT agent_credentials_owner FOREIGN KEY (workspace_id, owner_principal_id) REFERENCES workspace_members (workspace_id, principal_id)
);

CREATE TABLE profiles (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'organization')),
  display_name TEXT NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT profiles_owned UNIQUE (workspace_id, id),
  CONSTRAINT profiles_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT profiles_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id)
);

CREATE TABLE capture_groups (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  preferred_listener_id TEXT,
  lease_listener_id TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT capture_groups_owned UNIQUE (workspace_id, id),
  CONSTRAINT capture_groups_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE listeners (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  capture_group_id TEXT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('room', 'laptop')),
  state TEXT NOT NULL DEFAULT 'stopped' CHECK (state IN ('stopped', 'starting', 'listening', 'reconnecting', 'paused', 'degraded')),
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at TEXT,
  current_epoch_id TEXT,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  health TEXT CHECK (json_valid(health)),
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  device_id TEXT,
  PRIMARY KEY (id),
  CONSTRAINT listeners_owned UNIQUE (workspace_id, id),
  CONSTRAINT listeners_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT listeners_group FOREIGN KEY (workspace_id, capture_group_id) REFERENCES capture_groups (workspace_id, id)
);

CREATE TABLE listener_lease_claims (
  workspace_id TEXT NOT NULL,
  listener_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (listener_id, lease_generation),
  CONSTRAINT listener_lease_claims_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id)
);

CREATE TABLE capture_epochs (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  listener_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 0),
  sample_rate INTEGER NOT NULL CHECK (sample_rate >= 0),
  channels INTEGER NOT NULL CHECK (channels >= 0),
  encoding TEXT NOT NULL,
  sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
  captured_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  start_reason TEXT NOT NULL CHECK (start_reason IN ('start', 'resume', 'reload', 'device_change', 'stream_restart')),
  started_at TEXT NOT NULL,
  live_sample_end INTEGER NOT NULL CHECK (live_sample_end >= 0),
  ended_at TEXT,
  end_reason TEXT CHECK (end_reason IN ('pause', 'close', 'interrupted', 'device_change', 'lease_lost')),
  archive_sample_end INTEGER CHECK (archive_sample_end >= 0),
  end_fence_from_sample INTEGER CHECK (end_fence_from_sample >= 0),
  end_fence_sample INTEGER CHECK (end_fence_sample >= 0),
  PRIMARY KEY (id),
  CONSTRAINT capture_epochs_owned UNIQUE (workspace_id, id),
  CONSTRAINT capture_epochs_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id),
  CONSTRAINT capture_epochs_live CHECK (live_sample_end >= sample_start)
);
CREATE INDEX capture_epochs_listener_idx ON capture_epochs (listener_id, started_at);

CREATE TABLE recording_chunks (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  listener_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  track INTEGER NOT NULL CHECK (track >= 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  sample_rate INTEGER NOT NULL CHECK (sample_rate >= 0),
  captured_at TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256 BLOB NOT NULL,
  object_key TEXT NOT NULL,
  upload_state TEXT NOT NULL CHECK (upload_state IN ('pending', 'committed')),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY (id),
  CONSTRAINT recording_chunks_owned UNIQUE (workspace_id, id),
  CONSTRAINT recording_chunks_sequence UNIQUE (epoch_id, track, sequence),
  CONSTRAINT recording_chunks_source UNIQUE (epoch_id, track, sample_start),
  CONSTRAINT recording_chunks_object UNIQUE (object_key),
  CONSTRAINT recording_chunks_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT recording_chunks_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id),
  CONSTRAINT recording_chunks_wav CHECK (sample_count > 0 AND byte_length = 44 + sample_count * 2),
  CONSTRAINT recording_chunks_committed CHECK ((upload_state = 'committed') = (committed_at IS NOT NULL))
);

CREATE TABLE provider_connections (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  track INTEGER NOT NULL CHECK (track >= 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('asr', 'diarization', 'batch_asr', 'batch_diarization')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  anchor_sample INTEGER NOT NULL CHECK (anchor_sample >= 0),
  sample_rate INTEGER NOT NULL CHECK (sample_rate >= 0),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  PRIMARY KEY (id),
  CONSTRAINT provider_connections_owned UNIQUE (workspace_id, id),
  CONSTRAINT provider_connections_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id)
);

CREATE TABLE transcript_segments (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  track INTEGER NOT NULL CHECK (track >= 0),
  sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
  sample_end INTEGER NOT NULL CHECK (sample_end >= 0),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('partial', 'final')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  origin TEXT NOT NULL CHECK (origin IN ('live', 'batch', 'correction')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_connection_id TEXT,
  speaker_label TEXT,
  speaker_track_id TEXT,
  confidence REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT transcript_segments_owned UNIQUE (workspace_id, id),
  CONSTRAINT transcript_segments_source UNIQUE (epoch_id, track, sample_start, sample_end, revision),
  CONSTRAINT transcript_segments_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT transcript_segments_connection FOREIGN KEY (workspace_id, provider_connection_id) REFERENCES provider_connections (workspace_id, id),
  CONSTRAINT transcript_segments_range CHECK (sample_end > sample_start),
  CONSTRAINT transcript_segments_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE TABLE transcript_coverage (
  workspace_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  track INTEGER NOT NULL CHECK (track >= 0),
  sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
  sample_end INTEGER NOT NULL CHECK (sample_end >= 0),
  origin TEXT NOT NULL CHECK (origin IN ('live', 'batch')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (epoch_id, track, sample_start),
  CONSTRAINT transcript_coverage_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT transcript_coverage_range CHECK (sample_end > sample_start)
);

CREATE TABLE jobs (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  work_key TEXT NOT NULL,
  requested_by TEXT,
  source_revision INTEGER CHECK (source_revision >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'paused')),
  active_work_key TEXT GENERATED ALWAYS AS (iif(status IN ('pending', 'running', 'paused'), work_key, NULL)) STORED,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 0),
  rearmed INTEGER NOT NULL DEFAULT 0,
  result TEXT CHECK (json_valid(result)),
  last_error TEXT CHECK (json_valid(last_error)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT jobs_owned UNIQUE (workspace_id, id),
  CONSTRAINT jobs_active UNIQUE (workspace_id, kind, active_work_key),
  CONSTRAINT jobs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT jobs_requester FOREIGN KEY (workspace_id, requested_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT jobs_attempts CHECK (max_attempts > 0)
);
CREATE INDEX jobs_claim_idx ON jobs (status, available_at);
CREATE INDEX jobs_expired_lease_idx ON jobs (status, lease_until);

CREATE TABLE meetings (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  capture_group_id TEXT,
  listener_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('provisional', 'active', 'closing', 'closed', 'interrupted')),
  title TEXT,
  timezone TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  boundary_revision INTEGER NOT NULL DEFAULT 1 CHECK (boundary_revision >= 0),
  visibility TEXT NOT NULL DEFAULT 'restricted' CHECK (visibility IN ('restricted', 'workspace')),
  processing TEXT NOT NULL CHECK (json_valid(processing)),
  notes TEXT CHECK (json_valid(notes)),
  notes_revision INTEGER NOT NULL DEFAULT 0 CHECK (notes_revision >= 0),
  context_revision INTEGER NOT NULL DEFAULT 0 CHECK (context_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT meetings_owned UNIQUE (workspace_id, id),
  CONSTRAINT meetings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT meetings_listener FOREIGN KEY (workspace_id, listener_id) REFERENCES listeners (workspace_id, id),
  CONSTRAINT meetings_group FOREIGN KEY (workspace_id, capture_group_id) REFERENCES capture_groups (workspace_id, id)
);
CREATE INDEX meetings_started_idx ON meetings (workspace_id, started_at);

CREATE TABLE meeting_access (
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write', 'owner')),
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (meeting_id, principal_id),
  CONSTRAINT meeting_access_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT meeting_access_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id)
);
CREATE INDEX meeting_access_principal_idx ON meeting_access (workspace_id, principal_id);

CREATE TABLE meeting_ranges (
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  boundary_revision INTEGER NOT NULL CHECK (boundary_revision >= 0),
  epoch_id TEXT NOT NULL,
  track INTEGER NOT NULL CHECK (track >= 0),
  sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
  sample_end INTEGER NOT NULL CHECK (sample_end >= 0),
  PRIMARY KEY (meeting_id, boundary_revision, epoch_id, track, sample_start),
  CONSTRAINT meeting_ranges_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT meeting_ranges_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT meeting_ranges_range CHECK (sample_end > sample_start)
);
CREATE INDEX meeting_ranges_source_idx ON meeting_ranges (epoch_id, track, sample_start);

CREATE TABLE boundary_events (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  boundary_revision INTEGER NOT NULL CHECK (boundary_revision >= 0),
  operation TEXT NOT NULL CHECK (operation IN ('start', 'promote', 'close', 'split', 'merge', 'interrupt')),
  decision TEXT NOT NULL CHECK (json_valid(decision)),
  actor_principal_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT boundary_events_revision UNIQUE (meeting_id, boundary_revision, operation),
  CONSTRAINT boundary_events_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id)
);

CREATE TABLE meeting_recordings (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  boundary_revision INTEGER NOT NULL CHECK (boundary_revision >= 0),
  object_key TEXT NOT NULL,
  sha256 BLOB NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  sample_rate INTEGER NOT NULL CHECK (sample_rate >= 0),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  pieces TEXT NOT NULL CHECK (json_valid(pieces)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT meeting_recordings_revision UNIQUE (meeting_id, boundary_revision),
  CONSTRAINT meeting_recordings_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id)
);

CREATE TABLE speaker_tracks (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  track INTEGER NOT NULL CHECK (track >= 0),
  provider_connection_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_label TEXT NOT NULL COLLATE NOCASE,
  sample_start INTEGER NOT NULL CHECK (sample_start >= 0),
  sample_end INTEGER NOT NULL CHECK (sample_end >= 0),
  profile_id TEXT,
  mapping_source TEXT CHECK (mapping_source IN ('enrollment', 'user_confirmed')),
  attribution_revision INTEGER NOT NULL CHECK (attribution_revision >= 0),
  confidence REAL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT speaker_tracks_owned UNIQUE (workspace_id, id),
  CONSTRAINT speaker_tracks_turn UNIQUE (provider_connection_id, provider_label, sample_start),
  CONSTRAINT speaker_tracks_epoch FOREIGN KEY (workspace_id, epoch_id) REFERENCES capture_epochs (workspace_id, id),
  CONSTRAINT speaker_tracks_connection FOREIGN KEY (workspace_id, provider_connection_id) REFERENCES provider_connections (workspace_id, id),
  CONSTRAINT speaker_tracks_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id),
  CONSTRAINT speaker_tracks_range CHECK (sample_end > sample_start),
  CONSTRAINT speaker_tracks_mapping CHECK ((profile_id IS NULL) = (mapping_source IS NULL))
);
CREATE INDEX speaker_tracks_source_idx ON speaker_tracks (epoch_id, track, sample_start);

CREATE TABLE speaker_attributions (
  workspace_id TEXT NOT NULL,
  provider_connection_id TEXT NOT NULL,
  provider_label TEXT NOT NULL COLLATE NOCASE,
  attribution_revision INTEGER NOT NULL CHECK (attribution_revision >= 0),
  profile_id TEXT,
  mapping_source TEXT CHECK (mapping_source IN ('enrollment', 'user_confirmed')),
  confidence REAL,
  actor_principal_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider_connection_id, provider_label, attribution_revision),
  CONSTRAINT speaker_attributions_connection FOREIGN KEY (workspace_id, provider_connection_id) REFERENCES provider_connections (workspace_id, id),
  CONSTRAINT speaker_attributions_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id)
);

CREATE TABLE voice_enrollments (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  voiceprint TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT voice_enrollments_member FOREIGN KEY (workspace_id, principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT voice_enrollments_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id)
);
CREATE INDEX voice_enrollments_profile_idx ON voice_enrollments (workspace_id, profile_id);

CREATE TABLE artifacts (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('research', 'document', 'export', 'action_output')),
  title TEXT NOT NULL,
  content_type TEXT NOT NULL,
  content TEXT,
  object_key TEXT,
  sha256 BLOB NOT NULL,
  provenance TEXT NOT NULL CHECK (json_valid(provenance)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT artifacts_owned UNIQUE (workspace_id, id),
  CONSTRAINT artifacts_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT artifacts_body CHECK (content IS NOT NULL OR object_key IS NOT NULL)
);

CREATE TABLE context_items (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  workspace_id TEXT NOT NULL,
  meeting_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'commitment', 'constraint', 'project_fact', 'preference', 'open_question', 'research_observation')),
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisional', 'committed', 'superseded')),
  derivation TEXT NOT NULL CHECK (derivation IN ('spoken', 'inferred', 'human_correction', 'external')),
  event_at TEXT,
  valid_from TEXT,
  valid_until TEXT,
  time_expression TEXT CHECK (json_valid(time_expression)),
  sources TEXT NOT NULL CHECK (json_valid(sources)),
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
  author_principal_id TEXT NOT NULL,
  supersedes_id TEXT,
  supersedes_revision INTEGER CHECK (supersedes_revision >= 0),
  idempotency_key TEXT,
  payload_sha256 BLOB,
  created_at TEXT NOT NULL,
  text_joined TEXT GENERATED ALWAYS AS (REPLACE(text, '-', '')) STORED,
  PRIMARY KEY (id, revision),
  CONSTRAINT context_items_idempotency UNIQUE (workspace_id, author_principal_id, idempotency_key),
  CONSTRAINT context_items_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT context_items_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT context_items_supersedes FOREIGN KEY (supersedes_id, supersedes_revision) REFERENCES context_items (id, revision),
  CONSTRAINT context_items_idempotent CHECK ((idempotency_key IS NULL) = (payload_sha256 IS NULL))
);
CREATE INDEX context_items_meeting_idx ON context_items (workspace_id, meeting_id, state);
CREATE INDEX context_items_event_idx ON context_items (workspace_id, event_at);

CREATE TABLE context_events (
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  meeting_id TEXT,
  item_id TEXT,
  item_revision INTEGER CHECK (item_revision >= 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('item_added', 'item_revised', 'item_superseded', 'meeting_boundary_changed', 'access_changed')),
  actor_principal_id TEXT NOT NULL,
  source_revision INTEGER CHECK (source_revision >= 0),
  permission_revision INTEGER NOT NULL CHECK (permission_revision >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, seq),
  CONSTRAINT context_events_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  CONSTRAINT context_events_item FOREIGN KEY (item_id, item_revision) REFERENCES context_items (id, revision)
);
CREATE INDEX context_events_meeting_idx ON context_events (workspace_id, meeting_id, seq);

CREATE TABLE context_processed_segments (
  workspace_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, meeting_id, segment_id),
  CONSTRAINT context_processed_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT context_processed_segment FOREIGN KEY (workspace_id, segment_id) REFERENCES transcript_segments (workspace_id, id)
);

CREATE TABLE integration_accounts (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  app_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disconnected', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT integration_accounts_owned UNIQUE (workspace_id, id),
  CONSTRAINT integration_accounts_provider UNIQUE (workspace_id, provider_account_id),
  CONSTRAINT integration_accounts_owner FOREIGN KEY (workspace_id, owner_principal_id) REFERENCES workspace_members (workspace_id, principal_id)
);

CREATE TABLE action_grants (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  grantee_principal_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  app_slug TEXT NOT NULL,
  account_id TEXT NOT NULL,
  meeting_id TEXT,
  restrictions TEXT NOT NULL CHECK (json_valid(restrictions)),
  expires_at TEXT,
  revoked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT action_grants_owned UNIQUE (workspace_id, id),
  CONSTRAINT action_grants_owner FOREIGN KEY (workspace_id, owner_principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT action_grants_grantee FOREIGN KEY (workspace_id, grantee_principal_id) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT action_grants_account FOREIGN KEY (workspace_id, account_id) REFERENCES integration_accounts (workspace_id, id),
  CONSTRAINT action_grants_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id)
);
CREATE INDEX action_grants_lookup_idx ON action_grants (workspace_id, grantee_principal_id, action_key);

CREATE TABLE actions (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  meeting_id TEXT,
  requested_by TEXT NOT NULL,
  action_key TEXT NOT NULL,
  account_id TEXT,
  idempotency_key TEXT NOT NULL,
  args TEXT NOT NULL CHECK (json_valid(args)),
  args_sha256 BLOB NOT NULL,
  configuration_ref TEXT,
  version TEXT NOT NULL,
  grant_id TEXT,
  grant_version INTEGER CHECK (grant_version >= 0),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'awaiting_authorization', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled')),
  provider_idempotency_key TEXT,
  provider_receipt TEXT CHECK (json_valid(provider_receipt)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  reconciliation TEXT NOT NULL DEFAULT 'none' CHECK (reconciliation IN ('none', 'pending', 'reconciled', 'resolved_by_human')),
  resolved_by TEXT,
  resolved_at TEXT,
  last_error TEXT CHECK (json_valid(last_error)),
  started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT,
  research_job_id TEXT,
  PRIMARY KEY (id),
  CONSTRAINT actions_owned UNIQUE (workspace_id, id),
  CONSTRAINT actions_idempotency UNIQUE (workspace_id, requested_by, idempotency_key),
  CONSTRAINT actions_requester FOREIGN KEY (workspace_id, requested_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT actions_meeting FOREIGN KEY (workspace_id, meeting_id) REFERENCES meetings (workspace_id, id),
  CONSTRAINT actions_account FOREIGN KEY (workspace_id, account_id) REFERENCES integration_accounts (workspace_id, id),
  CONSTRAINT actions_grant FOREIGN KEY (workspace_id, grant_id) REFERENCES action_grants (workspace_id, id),
  CONSTRAINT actions_resolver FOREIGN KEY (workspace_id, resolved_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT actions_grant_version CHECK ((grant_id IS NULL) = (grant_version IS NULL)),
  CONSTRAINT actions_resolution CHECK ((resolved_by IS NULL) = (resolved_at IS NULL) AND (resolved_by IS NULL) = (reconciliation <> 'resolved_by_human'))
);
CREATE INDEX actions_meeting_idx ON actions (workspace_id, meeting_id);
CREATE INDEX actions_started_idx ON actions (workspace_id, started_at);
CREATE INDEX actions_research_job_idx ON actions (workspace_id, research_job_id);

CREATE TABLE profile_embeddings (
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'needs', 'offers')),
  model TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK (dimension >= 0),
  embedding BLOB NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, kind, model),
  CONSTRAINT profile_embeddings_profile FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id),
  CONSTRAINT profile_embeddings_bytes CHECK (dimension > 0 AND LENGTH(embedding) = dimension * 4)
);
CREATE INDEX profile_embeddings_scope_idx ON profile_embeddings (workspace_id, kind, model);

CREATE TABLE workspace_orgs (
  issuer TEXT NOT NULL,
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, org_id),
  CONSTRAINT workspace_orgs_workspace_issuer UNIQUE (workspace_id, issuer),
  CONSTRAINT workspace_orgs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);

CREATE TABLE sync_cursors (
  name TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name)
);

CREATE TABLE paid_model_calls (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_id TEXT,
  model TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  web_searches INTEGER CHECK (web_searches >= 0),
  PRIMARY KEY (id),
  CONSTRAINT paid_model_calls_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id)
);
CREATE INDEX paid_model_calls_day_idx ON paid_model_calls (workspace_id, started_at);
CREATE INDEX paid_model_calls_started_idx ON paid_model_calls (started_at);

CREATE TABLE devices (
  id TEXT NOT NULL,
  workspace_id TEXT,
  name TEXT NOT NULL,
  capabilities TEXT NOT NULL CHECK (json_valid(capabilities)),
  device_code_hash BLOB NOT NULL,
  user_code_hash BLOB NOT NULL,
  client_address_hash BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
  pending_code_hash BLOB GENERATED ALWAYS AS (iif(status = 'pending', user_code_hash, NULL)) STORED,
  approved_by TEXT,
  credential_id TEXT,
  token_delivered_at TEXT,
  last_polled_at TEXT,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval_seconds >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (id),
  CONSTRAINT devices_device_code UNIQUE (device_code_hash),
  CONSTRAINT devices_pending_code UNIQUE (pending_code_hash),
  CONSTRAINT devices_credential_unique UNIQUE (workspace_id, credential_id),
  CONSTRAINT devices_member FOREIGN KEY (workspace_id, approved_by) REFERENCES workspace_members (workspace_id, principal_id),
  CONSTRAINT devices_credential FOREIGN KEY (workspace_id, credential_id) REFERENCES agent_credentials (workspace_id, id)
);
CREATE INDEX devices_expiry ON devices (status, expires_at);
CREATE INDEX devices_address ON devices (status, client_address_hash);
CREATE INDEX devices_owner ON devices (workspace_id, approved_by);

CREATE TABLE device_pair_capacity (
  id INTEGER CHECK (id >= 0),
  PRIMARY KEY (id)
);

CREATE TABLE device_pair_attempts (
  principal_id TEXT NOT NULL,
  attempts TEXT NOT NULL CHECK (json_valid(attempts)),
  PRIMARY KEY (principal_id),
  CONSTRAINT device_pair_attempts_principal FOREIGN KEY (principal_id) REFERENCES principals (id) ON DELETE CASCADE
);

-- Optimistic-transaction clock and conflict guard for the D1 transaction layer (plan section 3.1). Local to D1; never synced.
CREATE TABLE tx_clock (
  id INTEGER NOT NULL CHECK (id = 1),
  v INTEGER NOT NULL,
  PRIMARY KEY (id)
);
INSERT INTO tx_clock (id, v) VALUES (1, 0);

CREATE TABLE tx_conflict (
  v INTEGER CHECK (v IS NULL)
);

-- Full-text search over context_items.text and text_joined (replaces the MySQL FULLTEXT index). The triggers pass
-- replace(text, '-', '') themselves so the index never depends on trigger-time values of generated columns.
CREATE VIRTUAL TABLE context_items_fts USING fts5(text, text_joined, content = 'context_items', content_rowid = 'rowid');

CREATE TRIGGER context_items_fts_ai AFTER INSERT ON context_items BEGIN
  INSERT INTO context_items_fts (rowid, text, text_joined) VALUES (new.rowid, new.text, replace(new.text, '-', ''));
END;

CREATE TRIGGER context_items_fts_ad AFTER DELETE ON context_items BEGIN
  INSERT INTO context_items_fts (context_items_fts, rowid, text, text_joined) VALUES ('delete', old.rowid, old.text, replace(old.text, '-', ''));
END;

CREATE TRIGGER context_items_fts_au AFTER UPDATE ON context_items BEGIN
  INSERT INTO context_items_fts (context_items_fts, rowid, text, text_joined) VALUES ('delete', old.rowid, old.text, replace(old.text, '-', ''));
  INSERT INTO context_items_fts (rowid, text, text_joined) VALUES (new.rowid, new.text, replace(new.text, '-', ''));
END;
