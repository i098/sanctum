-- The item text with hyphens removed, so a search for "offsite" finds "off-site". Searches match it together with text.
ALTER TABLE context_items ADD COLUMN text_joined TEXT GENERATED ALWAYS AS (REPLACE(text, '-', '')) STORED;
CREATE FULLTEXT INDEX context_items_text_joined ON context_items (text, text_joined);
