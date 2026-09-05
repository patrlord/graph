-- Run this once in the Supabase SQL Editor, after migration_006. Allows
-- org_type to be left blank ("unclassified") rather than forcing a guess.
--
-- Used for organizations discovered as a person's *current* LinkedIn
-- company (syncCurrentRolesForPerson) that aren't already a known org -
-- these are likely relevant to this tool (unlike "employer"-tagged past
-- jobs) but their actual type shouldn't be assumed, so they're left blank
-- for a human to classify via the org detail edit form.
--
-- A NULL org_type still passes the existing check constraint unaffected -
-- a CHECK only rejects rows where the expression evaluates to false, and
-- `null = any(array[...])` evaluates to null, not false.

alter table organizations alter column org_type drop not null;
