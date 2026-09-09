-- Run this once in the Supabase SQL Editor, after migration_012. Captures
-- LinkedIn's employmentType (e.g. "Permanent", "Freelance", "Volunteer")
-- per membership, sourced the same way as everything else in li_experience
-- (see enrichPersonFromApify). Used to rank someone's current roles when
-- they have more than one - a full-time job should outrank a freelance
-- advisory/committee seat as their "primary" role, even if the side role
-- happens to be more recently added (see loadPersonCareerSections).

alter table memberships add column if not exists employment_type text;
