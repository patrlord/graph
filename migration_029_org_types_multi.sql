-- Run once after migration_028. Organizations can now have several types
-- (a firm that runs VC and PE funds, a bank with an asset-management arm...),
-- stored in org_types text[] the same way sectors is.
--
-- org_type (single) is kept as the PRIMARY type = org_types[1], and the two
-- are kept in sync by a trigger, so everything that still reads or writes
-- org_type - the research save, the Apify past-employer stubs ("employer"),
-- the "Include past employers" filter, the Type column's sort, bulk SQL
-- imports - keeps working unchanged. Writing org_types wins when both
-- change in one statement.
alter table organizations add column if not exists org_types text[] not null default '{}';

update organizations set org_types = array[org_type] where org_type is not null and org_types = '{}';

alter table organizations drop constraint if exists organizations_org_types_check;
alter table organizations add constraint organizations_org_types_check
  check (org_types <@ array[
    'vc', 'cvc', 'angel', 'angel_network', 'family_office', 'investment_syndicate',
    'pe', 'asset_manager', 'investment_bank', 'bank', 'insurer',
    'startup', 'enterprise', 'incubator_accelerator', 'university', 'association',
    'legal', 'consulting', 'audit_accounting', 'media_agency', 'exec_search', 'interim_agency',
    'group', 'employer', 'secondary'
  ]::text[]);

create index if not exists organizations_org_types_idx on organizations using gin (org_types);

create or replace function sync_org_types() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if cardinality(new.org_types) > 0 then
      new.org_type := new.org_types[1];
    elsif new.org_type is not null then
      new.org_types := array[new.org_type];
    end if;
  else
    if new.org_types is distinct from old.org_types then
      new.org_type := case when cardinality(new.org_types) > 0 then new.org_types[1] else null end;
    elsif new.org_type is distinct from old.org_type then
      new.org_types := case when new.org_type is null then '{}'::text[] else array[new.org_type] end;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists organizations_sync_org_types on organizations;
create trigger organizations_sync_org_types before insert or update on organizations
  for each row execute function sync_org_types();
