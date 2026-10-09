-- Issuer whose organization sync (WorkOS, Better Auth) granted the membership; NULL means Sanctum
-- granted it (owner bootstrap, a member from before the workspace was linked). Org sync revokes only
-- memberships its issuer granted, so linking an existing workspace leaves its members in place.
ALTER TABLE workspace_members ADD COLUMN org_issuer VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL;
-- Workspaces already linked were fully managed by sync before this column existed, so their active members stay revocable by it.
UPDATE workspace_members m JOIN workspace_orgs o ON o.workspace_id = m.workspace_id SET m.org_issuer = o.issuer WHERE m.org_issuer IS NULL AND m.revoked_at IS NULL;
