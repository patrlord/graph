-- Run this once in the Supabase SQL Editor, after migration_008. Lets a
-- person be flagged as an "app user" (i.e. you, or anyone else whose own
-- network this tool is tracking) - the people and organizations lists then
-- show whether each row is connected to any such flagged person, via the
-- connections table (e.g. every LinkedIn connection import ties back to
-- one of these).

alter table people add column if not exists is_user boolean not null default false;
