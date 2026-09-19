-- Run this once in the Supabase SQL Editor, after migration_019. Makes the
-- people search box accent-insensitive - "kart" now also matches "Kärt",
-- "romeo" matches "Roméo" - using Postgres's own unaccent() rather than
-- reimplementing accent folding in the app. search_people_by_name is a
-- STABLE, table-returning function, so PostgREST treats it like a normal
-- resource for GET/select=/order=/limit= and the people(*)/memberships
-- embedding the backend already relies on - see searchPeopleGlobal in
-- supabase/functions/graph-api/index.ts.
create extension if not exists unaccent;

create or replace function search_people_by_name(search_query text)
returns setof people
language sql
stable
as $$
  select * from people
  where unaccent(full_name) ilike unaccent('%' || search_query || '%');
$$;
