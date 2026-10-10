-- The research.run job that requested an action, written with the action, so a retried job reports what an earlier
-- attempt requested instead of planning again. NULL for actions requested any other way and for existing rows.
ALTER TABLE actions ADD COLUMN research_job_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
CREATE INDEX actions_research_job_idx ON actions (workspace_id, research_job_id);
