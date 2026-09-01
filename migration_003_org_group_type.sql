-- Run this once in the Supabase SQL Editor, after migration_002. Adds a
-- lightweight "group" org_type for parent/holding companies that aren't
-- themselves investors (e.g. the corporation behind a CVC arm) - used with
-- the connections table to model subsidiary/CVC-arm/division relationships
-- without collapsing a distinct investing entity's own website, LinkedIn,
-- sectors and description down into a field on its parent.

alter table organizations drop constraint organizations_org_type_check;
alter table organizations add constraint organizations_org_type_check
  check (org_type = any (array['vc', 'cvc', 'angel', 'family_office', 'group']));
