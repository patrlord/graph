-- Run this once in the Supabase SQL Editor, after migration_018. Events
-- (conferences, summits, etc.) and who attended - event_attendees is a
-- simple many-to-many between events and people, with a free-text role
-- (Speaker, Delegate, Staff, ...) per attendance, same idea as memberships
-- linking people to organizations. Not surfaced in the app UI yet - data
-- only, queried directly for now.

create table events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_date date,
  location text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index events_name_date_key on events (lower(name), event_date);

create table event_attendees (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  role text,
  created_at timestamptz not null default now(),
  unique (event_id, person_id)
);
create index event_attendees_event_idx on event_attendees (event_id);
create index event_attendees_person_idx on event_attendees (person_id);

-- Same RLS posture as every other table here: on, no policies - locks out
-- the anon/public key entirely. The backend uses the service_role key,
-- which bypasses RLS.
alter table events enable row level security;
alter table event_attendees enable row level security;
