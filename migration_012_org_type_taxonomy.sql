-- Run this once in the Supabase SQL Editor, after migration_011. Expands
-- org_type well past "which kind of investor" - research (and the org
-- detail pane's "Enrich" button) now classifies any organization it looks
-- up, not just investment firms, using this richer taxonomy. Keep this in
-- sync with ORG_TYPES/ALL_ORG_TYPE_SLUGS in the Edge Function and
-- ORG_TYPE_LABEL in index.html - there's no shared module between them.

alter table organizations drop constraint organizations_org_type_check;
alter table organizations add constraint organizations_org_type_check
  check (org_type = any (array[
    'vc', 'cvc', 'angel', 'angel_network', 'family_office', 'investment_syndicate',
    'pe', 'asset_manager', 'investment_bank', 'bank', 'insurer',
    'startup', 'enterprise', 'incubator_accelerator', 'university', 'association',
    'legal', 'consulting', 'audit_accounting', 'media_agency', 'exec_search', 'interim_agency',
    'group', 'employer'
  ]));
