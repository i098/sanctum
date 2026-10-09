-- End meeting fence: the capture epoch and the first sample not captured when the user pressed End. A final of that
-- epoch that starts before the sample belongs to the closed meeting or to nothing, and never opens a meeting.
-- NULL for every meeting an API or automatic close ended; existing meetings stay as they are.
ALTER TABLE meetings ADD COLUMN end_fence_epoch_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;

ALTER TABLE meetings ADD COLUMN end_fence_sample BIGINT UNSIGNED NULL;

CREATE INDEX meetings_end_fence_idx ON meetings (workspace_id, end_fence_epoch_id);
