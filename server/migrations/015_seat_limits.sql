-- Per-workspace seat limit (owner, admin and member memberships); NULL means the configured
-- default applies (SANCTUM_DEFAULT_SEAT_LIMIT, docs/operations.md). Existing members stay.
ALTER TABLE workspaces ADD COLUMN seat_limit INT UNSIGNED NULL;
