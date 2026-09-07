-- Run this once in the Supabase SQL Editor, after migration_010. Switches
-- the org LinkedIn-company enrichment (enrich-from-apify) from the
-- unseenuser/LinkedIn-Company-Scraper actor to harvestapi/linkedin-company
-- (https://console.apify.com/actors/UwSdACBp7ymaGUJjS) - the same vendor
-- family as the person profile-scraper actor, and a richer response. Adds
-- the two genuinely new fields it carries that the old actor didn't:
-- companyType (e.g. "Public Company", "Privately Held") and a contact phone.

alter table organizations add column if not exists li_company_type text;
alter table organizations add column if not exists li_phone text;
