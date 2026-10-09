-- End meeting fence: the first sample of the epoch that the page had not captured when the user pressed End. An unowned
-- final of the epoch that starts before it never opens a meeting; it joins the meeting owning the nearest earlier range.
-- NULL for every epoch no End fenced; existing epochs stay as they are.
ALTER TABLE capture_epochs ADD COLUMN end_fence_sample BIGINT UNSIGNED NULL;
