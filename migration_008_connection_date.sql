-- Run this once in the Supabase SQL Editor, after migration_007. Adds a
-- generic "when did this relationship start" date to connections - first
-- used for LinkedIn connections (their "Connected on" date), but not named
-- LinkedIn-specifically since the connections table itself is generic
-- (org<->org, person<->person, or mixed).

alter table connections add column if not exists occurred_on date;
