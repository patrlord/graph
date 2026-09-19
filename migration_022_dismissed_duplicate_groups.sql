-- Run this once in the Supabase SQL Editor, after migration_021. Remembers
-- "Not duplicates" decisions from the merge-candidates pop-up (people and
-- organizations both), so a dismissed pair/group doesn't keep resurfacing
-- on every future check. Keyed on the exact set of member ids (sorted,
-- comma-joined) rather than the name fingerprint that grouped them - if a
-- third record with the same fingerprint shows up later, that's a genuinely
-- new combination the user hasn't judged yet, so it surfaces again even
-- though the original pair stays dismissed.
create table dismissed_duplicate_groups (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('person', 'organization')),
  member_ids text not null,
  created_at timestamptz not null default now()
);
create unique index dismissed_duplicate_groups_key on dismissed_duplicate_groups (entity_type, member_ids);

alter table dismissed_duplicate_groups enable row level security;
