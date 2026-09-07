-- Run this once in the Supabase SQL Editor, after migration_009. Adds the
-- organization-side equivalent of people's li_* columns (see
-- migration_005_linkedin_profile_data.sql), sourced from the
-- unseenuser/LinkedIn-Company-Scraper Apify actor's "get_company" mode
-- (https://console.apify.com/actors/FEoKDOO9YzPRRz8Pf) instead of the
-- profile-scraper actor used for people.

alter table organizations add column if not exists li_tagline text;
alter table organizations add column if not exists li_logo_url text;
alter table organizations add column if not exists li_universal_name text;
alter table organizations add column if not exists li_employee_count integer;
alter table organizations add column if not exists li_employee_count_range text;
alter table organizations add column if not exists li_follower_count integer;
alter table organizations add column if not exists li_founded_year integer;
alter table organizations add column if not exists li_specialities text[];
alter table organizations add column if not exists li_industries jsonb;
alter table organizations add column if not exists li_locations jsonb;
alter table organizations add column if not exists li_headquarter jsonb;
alter table organizations add column if not exists li_funding_rounds_count integer;
alter table organizations add column if not exists li_last_funding_round jsonb;
alter table organizations add column if not exists li_active boolean;
alter table organizations add column if not exists li_page_verified boolean;
alter table organizations add column if not exists li_profile_fetched_at timestamptz;
