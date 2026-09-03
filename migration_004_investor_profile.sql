-- Run this once in the Supabase SQL Editor, after migration_003. Adds
-- investor-profile fields sourced from list-style investor directories
-- (ticket size, stage(s), geographic focus, and the raw fund-type label as
-- given by the source, which is richer than the org_type enum) alongside
-- the existing sectors column.

alter table organizations add column if not exists ticket_size text;
alter table organizations add column if not exists investment_stages text[] not null default '{}';
alter table organizations add column if not exists investment_regions text[] not null default '{}';
alter table organizations add column if not exists fund_type_raw text;
