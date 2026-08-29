-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query),
-- after schema.sql. Adds sectors-of-interest tags to organizations, and a
-- news_items table for the "search for latest news" feature (org or person).

alter table organizations add column if not exists sectors text[] not null default '{}';

create table news_items (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('organization', 'person')),
  entity_id uuid not null,
  title text not null,
  url text not null,
  source text,
  published_at text,  -- free text: exact dates aren't always available from search
  summary text,
  found_at timestamptz not null default now(),
  unique (entity_type, entity_id, url)
);
create index news_items_entity_idx on news_items (entity_type, entity_id);

alter table news_items enable row level security;
