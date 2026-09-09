-- Run this once in the Supabase SQL Editor, after migration_016. A plain
-- manual "is this person a business angel" checkbox on the people list -
-- nothing sets it automatically.

alter table people add column if not exists is_ba boolean not null default false;
