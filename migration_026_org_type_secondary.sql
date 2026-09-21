-- Run this once in the Supabase SQL Editor, after migration_025. Adds
-- "secondary" (a firm that buys/sells existing stakes in private funds or
-- companies) to the org_type taxonomy - see ORG_TYPES/ALL_ORG_TYPE_SLUGS in
-- the Edge Function and ORG_TYPE_LABEL in index.html, which must stay in
-- sync with this, same as every other org_type addition (migration_012).
alter table organizations drop constraint organizations_org_type_check;
alter table organizations add constraint organizations_org_type_check
  check (org_type = any (array[
    'vc', 'cvc', 'angel', 'angel_network', 'family_office', 'investment_syndicate',
    'pe', 'asset_manager', 'investment_bank', 'bank', 'insurer',
    'startup', 'enterprise', 'incubator_accelerator', 'university', 'association',
    'legal', 'consulting', 'audit_accounting', 'media_agency', 'exec_search', 'interim_agency',
    'group', 'employer', 'secondary'
  ]));
