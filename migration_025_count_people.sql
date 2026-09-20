-- Run this once in the Supabase SQL Editor, after migration_024. Backs the
-- people list's count/tooltip (index.html) now that the list is paginated -
-- needs the count of everyone matching the current search/filters, not just
-- how many rows happen to be loaded client-side so far.
--
-- A plain `Prefer: count=exact` count query (see countMatching in
-- supabase/functions/graph-api/index.ts, used for the org list's count the
-- same way) isn't enough here: when "Include ex-employees" is off, a person
-- only actually shows up in the list if they have at least one CURRENT
-- membership (see searchPeopleGlobal's flattening step) - someone whose
-- only membership(s) are past doesn't produce a row at all. Expressing
-- "has a current membership" as a PostgREST embed filter
-- (?select=id,memberships!inner(is_current)&memberships.is_current=eq.true)
-- works against the plain `people` table but fails (confirmed directly:
-- "column pgrst_call.is_current does not exist") on top of the
-- search_people_by_name/people_by_ids RPCs the list already routes through
-- for search/jpl_only - so this does the whole thing (id-restriction,
-- search, every toggle, and the current-membership check) in one SQL
-- function instead, callable the same way regardless of which combination
-- of filters is active.
--
-- enriched_since is optional and reused for the "enriched in the last
-- month" tooltip count (a second call with that cutoff set) - same
-- filters, plus a li_profile_fetched_at floor.
create or replace function count_people(
  target_ids uuid[] default null,
  search_query text default null,
  include_past boolean default false,
  starred_only boolean default false,
  ba_only boolean default false,
  show_hidden boolean default false,
  enriched_since timestamptz default null
)
returns bigint
language sql
stable
as $$
  select count(*) from people p
  where (target_ids is null or p.id = any(target_ids))
    and (search_query is null or unaccent(p.full_name) ilike unaccent('%' || search_query || '%'))
    and (not starred_only or p.is_starred)
    and (not ba_only or p.is_ba)
    and (show_hidden or not p.is_hidden)
    and (enriched_since is null or p.li_profile_fetched_at >= enriched_since)
    and (include_past or exists (
      select 1 from memberships m where m.person_id = p.id and m.is_current
    ));
$$;
