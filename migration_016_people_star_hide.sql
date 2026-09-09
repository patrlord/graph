-- Run this once in the Supabase SQL Editor, after migration_015. Same idea
-- as organizations.is_starred/is_hidden (migration_015) - purely manual
-- "keep an eye on this" / "stop showing me this" flags, now for people too.

alter table people add column if not exists is_starred boolean not null default false;
alter table people add column if not exists is_hidden boolean not null default false;
