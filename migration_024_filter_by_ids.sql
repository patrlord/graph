-- Run this once in the Supabase SQL Editor, after migration_023. Backs the
-- "JPL only" toggle's server-side filtering (organizations and people both)
-- now that the lists are paginated. The connected-id set (everyone/every
-- org reachable from the flagged user) commonly runs into the thousands -
-- passing it as a `?id=in.(...)` query string blew past both PostgREST's
-- and Cloudflare's URL length limits (confirmed directly: a 414 for
-- organizations, a 400 for people), which is why the toggle was silently
-- coming back empty. These take the id list as a uuid[] function argument
-- instead, sent in a POST body rather than the URL, and fold the existing
-- q search in too (accent-insensitive, same as search_organizations_by_text
-- / search_people_by_name) so id-restriction and search can combine in one
-- call - see listOrganizations/searchPeopleGlobal in
-- supabase/functions/graph-api/index.ts.
create or replace function organizations_by_ids(target_ids uuid[], search_query text default null)
returns setof organizations
language sql
stable
as $$
  select * from organizations
  where id = any(target_ids)
    and (
      search_query is null
      or unaccent(name) ilike unaccent('%' || search_query || '%')
      or unaccent(coalesce(hq_country, '')) ilike unaccent('%' || search_query || '%')
    );
$$;

create or replace function people_by_ids(target_ids uuid[], search_query text default null)
returns setof people
language sql
stable
as $$
  select * from people
  where id = any(target_ids)
    and (search_query is null or unaccent(full_name) ilike unaccent('%' || search_query || '%'));
$$;
