-- Roles added by hand via "Add role" (POST /people/:id/memberships), as
-- opposed to synced from a LinkedIn profile. The LinkedIn current-role sync
-- never closes a manual role (LinkedIn wouldn't list it by definition), and
-- the UI flags it "not on LinkedIn" with a remove button.
alter table memberships add column if not exists is_manual boolean not null default false;
