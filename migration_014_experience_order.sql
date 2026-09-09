-- Run this once in the Supabase SQL Editor, after migration_013.
-- employment_type alone isn't always enough to rank someone's current
-- roles - LinkedIn often leaves it blank for a side/owner-operated venture
-- (not just for a genuine second job), which left ties unresolved (e.g.
-- Frederic Caron: neither "HomeKuant" nor "TradeSide Technology" had an
-- employmentType, so both tied with his real main role, "Accurafy
-- Advisory", and the tiebreak fell back to an arbitrary order). Adds the
-- position each entry held in LinkedIn's own profile.experience array -
-- "shown at the top of the profile" is itself a signal worth capturing,
-- not just a description of where employment_type happens to agree with it.

alter table memberships add column if not exists experience_order integer;
