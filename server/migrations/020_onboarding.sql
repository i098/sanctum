-- First-run welcome on the website: when the person finished or skipped it, on any device. NULL shows it once at the next
-- signed-in visit, also for principals that existed before this column.
ALTER TABLE principals ADD COLUMN onboarded_at DATETIME(6) NULL;
