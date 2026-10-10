-- Run once after migration_029. Set on a person created from organization
-- research (POST /research/refine) when a LinkedIn name search at that
-- organization couldn't confirm them - the list and person pane show a small
-- "not verified" marker. Cleared automatically when a LinkedIn URL is found
-- or saved for them (Find, Enrich, hand-entered URL), or by the user.
alter table people add column if not exists li_unverified boolean not null default false;
