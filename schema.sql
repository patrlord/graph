-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query).
create extension if not exists pgcrypto;

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  org_type text not null check (org_type in ('vc', 'cvc', 'angel', 'family_office')),
  website_url text,
  linkedin_url text,
  hq_country text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index organizations_name_key on organizations (lower(name));

create table people (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  linkedin_url text,
  country text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index people_name_idx on people (lower(full_name));

create table memberships (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  title text,
  focus text,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (person_id, organization_id, title)
);
create index memberships_org_idx on memberships (organization_id);
create index memberships_person_idx on memberships (person_id);

-- Generic edges between any two entities (org<->org, person<->person, person<->org
-- beyond employment, e.g. "co-invested with", "board seat at", "alumni of").
create table connections (
  id uuid primary key default gen_random_uuid(),
  entity_a_type text not null check (entity_a_type in ('organization', 'person')),
  entity_a_id uuid not null,
  entity_b_type text not null check (entity_b_type in ('organization', 'person')),
  entity_b_id uuid not null,
  relationship_type text not null,
  notes text,
  created_at timestamptz not null default now()
);
create index connections_a_idx on connections (entity_a_type, entity_a_id);
create index connections_b_idx on connections (entity_b_type, entity_b_id);

-- RLS on with no policies: locks out the anon/public key entirely.
-- The backend uses the service_role key, which bypasses RLS.
alter table organizations enable row level security;
alter table people enable row level security;
alter table memberships enable row level security;
alter table connections enable row level security;
