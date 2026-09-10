-- Run this once in the Supabase SQL Editor, after migration_017. A short
-- country code (e.g. "FR", "UK") for the list views - compact, unlike the
-- existing free-text hq_country/country fields, which stay as they are
-- (fuller text like "Paris, France", used in the detail pane and in
-- research/enrichment prompts). Manually entered, and best-effort backfilled
-- once from the existing free-text field where it could be confidently
-- resolved to exactly one country.

alter table organizations add column if not exists country_code text;
alter table people add column if not exists country_code text;
