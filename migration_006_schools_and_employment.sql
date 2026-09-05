-- Run this once in the Supabase SQL Editor, after migration_005. Adds:
--
-- 1. A "schools" table + "education" join table, so schools can be looked
--    up independently ("who went to X") without polluting organizations.
--
-- 2. An "employer" org_type for past employers pulled from a person's
--    LinkedIn experience history - these are full organizations rows (so
--    the existing org detail/people/connections machinery all still works
--    for them), but a distinct type from vc/cvc/angel/family_office/group
--    so the app can hide them from the default organizations list/search.
--
-- 3. start_date/end_date on memberships, populated for employer-derived
--    memberships (LinkedIn gives a date range for each past role).

alter table organizations drop constraint organizations_org_type_check;
alter table organizations add constraint organizations_org_type_check
  check (org_type = any (array['vc', 'cvc', 'angel', 'family_office', 'group', 'employer']));

alter table memberships add column if not exists start_date text;
alter table memberships add column if not exists end_date text;

create table schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  linkedin_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index schools_name_key on schools (lower(name));

create table education (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  school_id uuid not null references schools(id) on delete cascade,
  degree text,
  period text,
  start_date text,
  end_date text,
  created_at timestamptz not null default now()
);
create index education_person_idx on education (person_id);
create index education_school_idx on education (school_id);

alter table schools enable row level security;
alter table education enable row level security;
