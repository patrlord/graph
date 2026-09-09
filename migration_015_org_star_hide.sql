-- Run this once in the Supabase SQL Editor, after migration_014. Lets an
-- organization be starred (personal "keep an eye on this" flag) or hidden
-- (personal "stop showing me this" flag) from the organizations list -
-- both purely manual, nothing sets them automatically.

alter table organizations add column if not exists is_starred boolean not null default false;
alter table organizations add column if not exists is_hidden boolean not null default false;
