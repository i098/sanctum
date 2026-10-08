-- Readable title an agent or the planner gave its action request; the agent-work feed shows it.
-- Older rows stay NULL and show a label made from their action key.
ALTER TABLE actions ADD COLUMN title VARCHAR(300) NULL;
