-- Run this once in the Supabase SQL Editor, after migration_004. Adds
-- columns to `people` for the richer profile data returned by the
-- "LinkedIn Profile Scraper + Email" Apify actor
-- (https://console.apify.com/actors/LpVuK3Zozwuipa5bp), fetched on demand
-- from the person detail pane once a LinkedIn URL is known for that person.
-- All prefixed li_ to keep them visually grouped and distinct from the
-- app's own fields (linkedin_url, country, title, focus), which this data
-- supplements rather than replaces.

alter table people add column if not exists li_headline text;
alter table people add column if not exists li_about text;
alter table people add column if not exists li_photo_url text;
alter table people add column if not exists li_location_text text;
alter table people add column if not exists li_top_skills text;
alter table people add column if not exists li_connections_count integer;
alter table people add column if not exists li_follower_count integer;
alter table people add column if not exists li_open_to_work boolean;
alter table people add column if not exists li_hiring boolean;
alter table people add column if not exists li_verified boolean;
alter table people add column if not exists li_registered_at timestamptz;
alter table people add column if not exists li_current_position text;
-- Raw nested sections from the actor's output, kept as JSON rather than
-- normalized into their own tables - there's no query/filter need for them
-- yet, just storage and display.
alter table people add column if not exists li_experience jsonb not null default '[]';
alter table people add column if not exists li_education jsonb not null default '[]';
alter table people add column if not exists li_certifications jsonb not null default '[]';
alter table people add column if not exists li_skills jsonb not null default '[]';
alter table people add column if not exists li_languages jsonb not null default '[]';
alter table people add column if not exists li_projects jsonb not null default '[]';
alter table people add column if not exists li_publications jsonb not null default '[]';
alter table people add column if not exists li_recommendations jsonb not null default '[]';
alter table people add column if not exists li_profile_fetched_at timestamptz;
