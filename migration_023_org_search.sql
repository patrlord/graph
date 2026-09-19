-- Run this once in the Supabase SQL Editor, after migration_022. Backs the
-- org list's search box now that it's server-side (paginated lists can't be
-- filtered client-side against only-partially-loaded data) - matches name
-- OR hq_country, accent-insensitive via unaccent() same as
-- search_people_by_name (migration_020) and find_organization_by_name
-- (migration_021).
create or replace function search_organizations_by_text(search_query text)
returns setof organizations
language sql
stable
as $$
  select * from organizations
  where unaccent(name) ilike unaccent('%' || search_query || '%')
     or unaccent(coalesce(hq_country, '')) ilike unaccent('%' || search_query || '%');
$$;
