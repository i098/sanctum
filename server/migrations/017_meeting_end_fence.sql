-- End meeting fence: the window of an epoch the ended meeting covered. `end_fence_from_sample` is the meeting's first sample
-- in the epoch; `end_fence_sample` is the first sample the page had not captured when the user pressed End. An unowned final
-- of the epoch that starts inside the window never opens a meeting; it joins the meeting owning the nearest earlier range.
-- NULL for every epoch no End fenced; existing epochs stay as they are.
ALTER TABLE capture_epochs ADD COLUMN end_fence_from_sample BIGINT UNSIGNED NULL;
ALTER TABLE capture_epochs ADD COLUMN end_fence_sample BIGINT UNSIGNED NULL;
