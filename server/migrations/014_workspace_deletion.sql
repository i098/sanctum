-- Workspace deletion (plan 10.1 option A): a soft delete refuses all access at once; the
-- `workspace.purge` job deletes recordings and rows after `purge_after`, until which the owner can undo.
ALTER TABLE workspaces ADD COLUMN deleted_at DATETIME(6) NULL;

ALTER TABLE workspaces ADD COLUMN purge_after DATETIME(6) NULL;
