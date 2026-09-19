-- Run this once in the Supabase SQL Editor, after migration_020. Same idea
-- as search_people_by_name (migration_020), for organizations: an exact
-- (not substring) accent-insensitive name match, used wherever the backend
-- finds-or-creates an org by name (findExistingOrganization) - typing an
-- accented name into a dropdown that suggests the plain-ASCII version on
-- file (or vice versa) now resolves to the same organization instead of
-- silently creating a duplicate.
create or replace function find_organization_by_name(search_name text)
returns setof organizations
language sql
stable
as $$
  select * from organizations
  where unaccent(name) ilike unaccent(search_name);
$$;
