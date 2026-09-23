// Graph API - Supabase Edge Function
//
// Backend for the Graph app (GitHub Pages frontend). Holds OPENROUTER_API_KEY,
// APOLLO_API_KEY, and ALLOWED_EMAIL as Supabase function secrets (never
// shipped to the static frontend). SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are auto-provided by the Edge Functions runtime.
//
// Auth: every request must carry `Authorization: Bearer <supabase-user-jwt>`
// from a real signed-in Supabase Auth session (not just the anon key, which
// is itself a validly-signed JWT but isn't tied to any user - it's checked
// for explicitly). The authenticated user's email must also match
// ALLOWED_EMAIL, as a second layer independent of whether public sign-ups
// happen to be left enabled on the project.
//
// Research/news use OpenRouter (openai/gpt-5-nano) with its web-search
// plugin: exactly one grounded search per call, not an open-ended agentic
// search loop - bounded, predictable cost. Apollo's free organizations/
// enrich still runs afterward as a backfill for whatever OpenRouter didn't
// find (hq location/description/LinkedIn), same as before.
//
// Routes (path is whatever follows the function name, e.g. /graph-api/research):
//   POST   /research            { name?, linkedin_url? } -> { organization, people }  (org_type is identified by research, not supplied)
//     organization also carries ticket_size, investment_stages[], investment_regions[], fund_type_raw
//     when research finds them; investment_regions falls back to [hq_country] if research finds nothing
//   POST   /research-person     { name?, company_hint?, linkedin_url? } -> { organization, people: [one] }  (same organization fields as /research)
//   GET    /organizations?include_employers=true&q=term&limit=100&offset=0&starred_only=true&show_hidden=true&jpl_only=true&sort=name&dir=asc&with_counts=true&countries=France,Germany&org_types=vc,cvc&sectors=Fintech&investment_regions=Europe
//     -> [ {id, name, org_type, website_url, linkedin_url, hq_country, country_code, sectors, investment_regions, updated_at, connected_to_user, is_starred, is_hidden, li_profile_fetched_at}, ... ]
//     (is_starred/is_hidden filter server-side here now (starred_only/show_hidden), same for jpl_only (connected_to_user) - the main org list is
//     paginated (see limit/offset below) so it can no longer filter client-side against data it hasn't loaded. q searches name or hq_country,
//     accent-insensitive, via search_organizations_by_text (migration_023) instead of a plain filter; jpl_only instead routes through
//     organizations_by_ids (migration_024), a POST RPC, since the connected-id list is too long for a URL filter. sort is one of name/hq_country/
//     org_type/updated_at (default name), dir asc/desc (default asc) - sectors/investment_regions aren't sortable server-side (array columns, no
//     clean single-column SQL order) so the frontend sorts those client-side, on whatever's currently loaded, same documented limitation as the
//     people list's Role column. countries/org_types/sectors/investment_regions are each a comma-separated list from that column's filter-dropdown
//     checkboxes (index.html) - hq_country/org_type match via in.(...), sectors/investment_regions (array columns) via ov.{...} (overlap - the row
//     matches if it has ANY of the given values), see inList/arrayOverlap; the options for these dropdowns come from GET .../filter-options below.
//     limit/offset: when limit is given, returns exactly one page - the frontend's
//     infinite scroll (index.html) decides there's a next page only when a page comes back full. limit OMITTED (not limit=0): returns
//     everything, paginated internally (supabaseRequestAllPages) - the pre-pagination behavior, still used by callers that need the full list
//     in one shot regardless of what the main list is showing (the merge-target dropdown, the add-connection org picker). with_counts=true (only
//     meaningful alongside limit): also returns, as response headers (not in the body - see Access-Control-Expose-Headers), X-Total-Count (rows
//     matching every filter above, regardless of limit/offset - the count the org list's title shows) and X-Enriched-Last-Month-Count (the same,
//     further restricted to li_profile_fetched_at within the last calendar month - the count's hover tooltip). The frontend only asks for these on
//     a real reload (reloadOrgList), not on every infinite-scroll page (loadMoreOrgs) - see listOrganizations.
//     (country_code is a short manually-entered code, e.g. "FR"/"UK", for the list view - distinct from
//     hq_country, which stays free text (e.g. "Paris, France") for the detail pane and research prompts)
//     (org_type "employer" - past employers pulled from LinkedIn experience history, see enrich-from-apify - excluded unless include_employers=true.
//     connected_to_user: true if any person with a membership at this org - past or current - is themselves flagged
//     is_user, or is connected to one via a person<->person row in `connections`; see getUserConnectedPersonIds)
//   GET    /organizations/filter-options -> { countries: [string, ...], org_types: [string, ...], sectors: [string, ...], investment_regions: [string, ...] }
//     (checked ahead of GET /organizations/:id below, same reason as .../duplicate-candidates - backs the org list's column-header filter
//     dropdowns' checkbox options: every distinct non-null value currently on any organization for that field, alphabetical. Deliberately NOT
//     scoped to the current include_employers/show_hidden/other-filter state - see getOrgFilterOptions)
//   GET    /organizations/duplicate-candidates -> [ { orgs: [ {id, name, org_type, linkedin_url, hq_country}, ... ] }, ... ]
//     (checked ahead of GET /organizations/:id below - same idea as GET /people/duplicate-candidates, grouped by
//     orgNameFingerprint (like nameFingerprint, but also strips a trailing domain-like suffix - ".ai"/".io"/".com"/...
//     - so "Zaion" and "Zaion.ai" collide too - and a trailing legal-entity designator - "AG"/"GmbH"/"Ltd"/"Inc"/...
//     - so "Acme" and "Acme GmbH" collide too, see LEGAL_SUFFIX_WORDS) OR a shared normalized linkedin_url (groupByKeys) - two orgs pointing
//     at the identical LinkedIn company page surface as candidates even with unrelated-looking names; includes
//     org_type "employer" stubs regardless of include_employers, since those are exactly the kind of low-quality,
//     duplicate-prone record most worth merging away; excludes any group already dismissed, see POST .../dismiss below)
//   POST   /organizations/duplicate-candidates/dismiss { ids: [id, id, ...] } -> { ok: true }
//     (records that this exact set of orgs was judged NOT duplicates - dismissed_duplicate_groups, migration_022 -
//     so it stops showing up in future duplicate-candidates checks; idempotent, dismissing an already-dismissed
//     group is fine. A different combination sharing the same name fingerprint - e.g. a third org added later -
//     still surfaces, since that's a genuinely new set the user hasn't judged)
//   POST   /organizations       { organization, people } -> saved { organization, people }
//     organization fields: name, org_type, website_url, linkedin_url, hq_country, description,
//     sectors[]; plus investor-profile fields not touched by research (ticket_size, investment_stages[],
//     investment_regions[], fund_type_raw) - sourced only from list-style bulk imports, merge-only-blanks
//     like everything else here
//     people[] entries also accept two optional flags, set only by the "Add people" panel after GET /people/match-candidates:
//     person_id (reuse exactly that existing person - skips the name/linkedin_url search) and force_new (skip the name half
//     of that search so a same-name coincidence isn't silently merged into someone else; a matching linkedin_url still counts).
//     Without either, a person is matched by exact case-insensitive name OR linkedin_url, as always
//   GET    /organizations/:id   -> org with nested people
//   DELETE /organizations/:id   -> { ok: true }
//   PATCH  /organizations/:id   { any subset of organization fields above } -> updated org (direct set, not merge-only-blanks - a
//     field present in the body is written exactly as given, including null/"" to clear it; for hand-editing in the UI.
//     A name that collides case-insensitively with a different org is rejected with a clean 409 - "merge into it instead" -
//     rather than the raw unique-constraint error organizations_name_key would otherwise surface)
//   GET    /people?q=term&include_past=true&limit=100&offset=0&starred_only=true&ba_only=true&show_hidden=true&jpl_only=true&with_counts=true
//     -> [ {id, full_name, linkedin_url, country, country_code, title, focus, is_current, start_date, end_date, membership_id, organization, is_user, connected_to_user, is_starred, is_hidden, is_ba, li_profile_fetched_at}, ... ]
//     (q omitted/empty -> all people; include_past=true returns one row per membership - e.g. two past
//     roles at the same company both show - instead of the default one row per person, their best/current membership only.
//     q, when given, matches via the search_people_by_name RPC (migration_020) rather than a plain ilike filter, so it's
//     accent-insensitive - "kart" matches "Kärt", "romeo" matches "Roméo" - via Postgres's own unaccent().
//     starred_only/ba_only/show_hidden/jpl_only (connected_to_user) filter server-side here now - the main people list is paginated (see
//     limit/offset below) so it can no longer filter client-side against data it hasn't loaded; jpl_only routes through people_by_ids
//     (migration_024), a POST RPC, since the connected-id list is too long for a URL filter. limit given: returns exactly one page - but
//     unlike GET /organizations, a page's row count doesn't reliably equal `limit` (one person can expand into several rows, one per
//     membership - see searchPeopleGlobal), so whether there's a next page is NOT inferrable from the response body; it's on the
//     `X-Has-More` response header ("true"/"false") instead. limit OMITTED (not limit=0): returns everything, paginated internally
//     (supabaseRequestAllPages) - the pre-pagination behavior, still used by callers that need the full list in one shot regardless of what
//     the main list is showing (the merge-target dropdown, see ensurePeopleNamesCache). with_counts=true (only meaningful alongside limit):
//     also returns X-Total-Count/X-Enriched-Last-Month-Count response headers, same idea and same caller (reloadPeopleList, not
//     loadMorePeople) as GET /organizations' with_counts - but computed via the count_people RPC (migration_025), not the generic
//     Prefer:count=exact approach the org list uses, since "matching" here has to account for includePast the same way the row-flattening
//     below does (a person with zero current memberships doesn't count unless include_past is set) - see searchPeopleGlobal.
//     connected_to_user: true if this person is themselves flagged is_user, or has a person<->person row in `connections`
//     with someone who is - same flag `organizations` rows carry, computed the same way, see getUserConnectedPersonIds.
//     is_starred/is_hidden/is_ba are purely manual flags, set via PATCH /people/:id.
//     country_code is a short manually-entered code, e.g. "FR"/"UK", for the list view - distinct from country, which stays free text.
//     Deliberately lean - no li_* LinkedIn-profile fields (photo, headline, about, experience, ...) - see GET /people/:id for those)
//   GET    /people/duplicate-candidates -> [ { people: [ {id, full_name, linkedin_url, country, roles: [{title, organization}]}, ... ] }, ... ]
//     (checked ahead of GET /people/:id below - groups everyone by a case/accent/punctuation/spacing-insensitive fingerprint of their
//     name (nameFingerprint) OR a shared normalized linkedin_url (groupByKeys) and returns any resulting group with more than one
//     person - "Alexis Le Portz" and "Alexis Leportz" collide on name, reordered names or genuine misspellings don't, but two records
//     pointing at the identical LinkedIn profile collide regardless of how different their names look (a rename, a nickname); each
//     person's current roles are included so the frontend can show enough context to tell at a glance whether a group really is the
//     same person. Excludes any group already dismissed, see POST .../dismiss below. Runs client-side on every people-list load, see
//     the frontend's checkForDuplicatePeople)
//   POST   /people/duplicate-candidates/dismiss { ids: [id, id, ...] } -> { ok: true }
//     (same idea as the organizations version above - records that this exact set of people was judged NOT duplicates so it
//     stops resurfacing; idempotent; a different combination sharing the same fingerprint still surfaces)
//   GET    /people/match-candidates?name=...&linkedin_url=... -> [ {id, full_name, linkedin_url, country, linkedin_match, roles: [{title, organization}]}, ... ]
//     (checked ahead of GET /people/:id below - read-only preview of who saveOrganization would match a new person to: exact
//     case-insensitive name OR linkedin_url, with current roles for context. Called by the "Add people" panel before saving so the
//     user can confirm "same person" or "different person" instead of the match being applied silently. linkedin_url optional;
//     linkedin_match is true for a candidate whose linkedin_url equals the one supplied - a certain match, no need to ask)
//   GET    /people/:id          -> full person row (select=*, every li_* field included) - fetched once a person is actually opened
//     in the detail pane (see loadPersonLinkedinDetail in index.html), not carried by every row in a list of thousands
//   PATCH  /people/:id          { any subset of full_name, linkedin_url, country, country_code, is_user, is_starred, is_hidden, is_ba } -> updated person (direct set, same as organizations PATCH)
//   PATCH  /memberships/:id     { any subset of title, focus } -> updated membership (direct set, same as organizations PATCH)
//   POST   /people/:id/enrich-from-linkedin  { linkedin_url, name?, organization_id? } -> { country, title, observed_company }
//     (for a hand-entered LinkedIn URL, not one found via search - looks up what else that profile says and
//     fills in country/title, only where currently blank; organization_id needed to know which membership's title to fill)
//   POST   /people/:id/enrich-from-apify  {} -> updated person (full row, including the li_* fields below)
//     (requires the person to already have a linkedin_url; runs the harvestapi LinkedIn Profile Scraper Apify actor
//     against it and overwrites all li_* fields with the fresh result - country is filled only if currently blank,
//     full_name is always overwritten to match LinkedIn's own name (no uniqueness constraint to guard, unlike an org's name).
//     Also normalizes profile.education into schools/education, profile.experience's non-current entries into
//     organizations (org_type "employer" if not already a known org) + memberships (is_current: false), and
//     syncs the person's current membership(s) to match LinkedIn's current role(s) exactly (always, not merge-
//     only-blanks - closes out any other membership LinkedIn's current data no longer backs up; supports more
//     than one concurrent current role; a brand-new org found this way gets org_type left blank, not "employer",
//     for a human to classify - unlike past jobs, this is likely an org the tool actually cares about))
//   POST   /people/:id/merge-into  { target_id } -> updated target person (full row)
//     (moves :id's memberships across every org onto target_id - dropping any that would collide with a membership
//     target_id already has at that exact org+title - and its event_attendees rows the same way (dropping any for an
//     event target_id already attended) - and its person<->person/person<->org connections too - dropping any that
//     would become a self-loop once remapped; backfills every field target_id is currently blank on from :id, its own
//     full_name untouched; then deletes :id. Irreversible - the frontend confirms before calling this. Unlike org
//     merge, no uniqueness constraint on full_name to guard, so no name-clash case here)
//   DELETE /people/:id -> { ok: true }
//   GET    /people/:id/education          -> [ {id, degree, period, start_date, end_date, schools: {id, name, linkedin_url}}, ... ]
//   GET    /people/:id/employment-history -> [ {id, title, focus, is_current, start_date, end_date, employment_type, experience_order, organizations: {id, name, org_type}}, ... ]
//     (employment_type is LinkedIn's own label - "Permanent", "Freelance", "Volunteer", etc.; experience_order is this entry's position in LinkedIn's own
//     profile.experience array - both used by the person pane to rank which of several concurrent current roles is the "primary" one to headline;
//     see loadPersonCareerSections in index.html)
//   GET    /schools/:id/people            -> [ {id, full_name, linkedin_url, country, degree, period}, ... ]
//   POST   /people/find-linkedin  { person_id, name, title?, company?, organization_id? } -> { linkedin_url, title, observed_company, renamed_to, merged_into_person_id }
//     (saved if found; title only filled if the membership's was blank. If the name as given finds nothing, retries once with
//     the word order reversed (surname-first sources); a verified match there sets renamed_to. If that corrected name/URL
//     already belongs to a different existing person, merges into it instead (deletes person_id) and sets merged_into_person_id)
//   POST   /organizations/find-linkedin  { org_id, name, website_url?, country? } -> { linkedin_url, name, org_type, sectors, hq_country, duplicate_of, name_clash, candidates }
//     (when the org already has li_company_id - LinkedIn's own numeric id for it, see migration_027 - tries findOrgLinkedinByCompanyId FIRST: resolves it via the
//     Apify company actor fed https://www.linkedin.com/company/<id> instead of a name search, which has no name-collision risk at all and, on success, also fully
//     enriches the org in the same call (applyApifyCompanyData) since the actor's response is the full company profile either way. Falls back to the LLM name
//     search below only if that isn't available or doesn't resolve. Either path: saved if found; sectors/hq_country/org_type only filled if currently blank; name is
//     renamed to LinkedIn's own name when it differs, unless that name already belongs to a different org (rename skipped, name_clash set, everything else still
//     saves - same rule as enrich-from-apify, via renameOrgIfPossible). duplicate_of is {id, name} of another org that already has this exact linkedin_url, or null -
//     a likely-duplicate flag, not a block on saving. The LLM search additionally checks the candidate against whatever's already on file for this org - type,
//     sectors, ticket size, stage, description - not just its name, since names collide; when that leaves more than one plausible candidate it can't confidently
//     tell apart, linkedin_url is null, nothing is saved, and candidates carries up to 3 {linkedin_url, name, org_type, industry, hq} for a human to pick from
//     instead of guessing)
//   POST   /organizations/:id/merge-into  { target_id } -> updated target org (full row)
//     (moves :id's team members onto target_id - dropping any that would collide with a membership target_id
//     already has for that exact person+title - and its org<->org connections too - dropping any that would
//     become a self-loop once remapped; backfills every field target_id is currently blank on from :id, its
//     own `name` untouched; then deletes :id. Irreversible - the frontend confirms before calling this)
//   POST   /organizations/:id/enrich-from-apify  {} -> updated org (full row, including the li_* fields below)
//     (requires the org to already have a linkedin_url; runs the harvestapi/linkedin-company Apify actor
//     against it. li_* fields are always overwritten with the fresh result, same as people's
//     enrich-from-apify; website_url/hq_country/description are filled only if currently blank. The org's `name`
//     is renamed to LinkedIn's own company name whenever that differs, UNLESS that name already belongs to a
//     different org - name uniqueness wins over LinkedIn's data in that one case, everything else still saves)
//   GET    /news?entity_type=organization|person&entity_id=uuid -> [ news_item, ... ]
//   POST   /news/search         { entity_type, entity_id, name, org_context? } -> [ news_item, ... ] (saved + deduped)
//   GET    /organizations/:id/connections -> [ {id, relationship_type, notes, direction, other: {id,name,org_type}}, ... ]
//   POST   /organizations/:id/connections { relationship_type, other_org_id? | other_org_name?, notes? } -> created connection (other_org_name
//     finds-or-creates via findExistingOrganization - accent-insensitive, see migration_021 - org_type "group" if new)
//   DELETE /connections/:id     -> { ok: true }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const APOLLO_API_KEY = Deno.env.get("APOLLO_API_KEY");
const APIFY_API_TOKEN = Deno.env.get("APIFY_API_TOKEN");
const ALLOWED_EMAIL = Deno.env.get("ALLOWED_EMAIL");

const OPENROUTER_MODEL = "openai/gpt-5-nano";
const APOLLO_BASE = "https://api.apollo.io/api/v1";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  // A cross-origin fetch (GitHub Pages calling this function) can't read a
  // response header unless it's explicitly exposed here. X-Has-More is GET
  // /people's way of telling the frontend whether there's a next page (see
  // searchPeopleGlobal) without that having to be inferrable from the
  // returned array's length. X-Total-Count/X-Enriched-Last-Month-Count (GET
  // /organizations and /people, with with_counts=true) carry the org/people
  // list counts - everything matching the current search/filters, not just
  // what's been paged in - see listOrganizations/searchPeopleGlobal.
  "Access-Control-Expose-Headers": "X-Has-More, X-Total-Count, X-Enriched-Last-Month-Count",
};

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
  });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- Auth ----------

async function authenticate(req: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return { ok: false, status: 401, error: "missing bearer token" };
  if (!ALLOWED_EMAIL) return { ok: false, status: 500, error: "ALLOWED_EMAIL is not configured on the server." };

  let res: Response;
  try {
    res = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    }, 10000);
  } catch {
    return { ok: false, status: 503, error: "auth check timed out or failed (network error) - please retry" };
  }
  if (!res.ok) return { ok: false, status: 401, error: "invalid or expired session" };
  const user = await res.json();
  if ((user.email || "").toLowerCase() !== ALLOWED_EMAIL.toLowerCase()) {
    return { ok: false, status: 403, error: "this account is not authorized for this app" };
  }
  return { ok: true };
}

// ---------- fetch helpers: timeout so a hung upstream call fails fast and
// cleanly (an uncaught abort/network error otherwise risks the platform
// killing the whole request mid-response, which produces a truncated/
// malformed body rather than a proper JSON error) ----------

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Supabase REST helper ----------

async function supabaseRequest(
  method: string,
  path: string,
  opts: { params?: Record<string, string>; body?: unknown; prefer?: string } = {},
): Promise<any> {
  let url = `${SUPABASE_URL}/rest/v1/${path}`;
  if (opts.params) url += "?" + new URLSearchParams(opts.params).toString();
  const headers: Record<string, string> = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (opts.prefer) headers["Prefer"] = opts.prefer;
  const res = await fetchWithTimeout(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }, 20000);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${detail}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Total rows matching a filter, without fetching them - `Prefer: count=exact`
// plus `limit=0` gets PostgREST to do the count and return zero rows, with
// the total in the Content-Range response header ("*/1234"). Used for the
// org/people list counts (index.html): those need the count of everything
// matching the current search/filters, not just how many rows happen to be
// loaded client-side so far (the lists are paginated - see listOrganizations/
// searchPeopleGlobal).
async function countMatching(method: string, path: string, params: Record<string, string>, body?: unknown): Promise<number> {
  // order is meaningless for a count and, worse, actively breaks this on an
  // RPC-backed resource (search_organizations_by_text/organizations_by_ids):
  // narrowing select to "id" below means whatever column the caller's order
  // was on (name.asc, from the main list query) is no longer part of the
  // shaped result set, and PostgREST rejects it - confirmed directly:
  // "column organizations.name does not exist" - which the org list's
  // search silently surfaced as "no results" (the frontend treats any
  // non-ok /organizations response as an empty page, see fetchOrgPage).
  const { order: _order, ...countParams } = params;
  const url = `${SUPABASE_URL}/rest/v1/${path}?` + new URLSearchParams({ ...countParams, select: "id", limit: "0" }).toString();
  const headers: Record<string, string> = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "count=exact",
  };
  const res = await fetchWithTimeout(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }, 20000);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Supabase ${method} ${path} count failed (${res.status}): ${detail}`);
  }
  await res.text();  // limit=0 means an empty body, but drain it regardless
  const total = (res.headers.get("content-range") || "").split("/")[1];
  return total && total !== "*" ? parseInt(total, 10) : 0;
}

// This project's PostgREST caps any single response at 1000 rows regardless
// of a higher `limit` param (confirmed: the organizations list was silently
// cutting off alphabetically at exactly row 1000 once the table passed that
// count). For a GET whose result can plausibly exceed that - a table-wide
// scan, or a filter like "everyone connected to the user" that can match
// thousands of rows - page through with limit/offset instead of trusting a
// single request to return everything. Safe to use for small results too,
// it just does one page and stops.
async function supabaseRequestAllPages(
  path: string,
  params: Record<string, string>,
  opts: { method?: string; body?: unknown } = {},
): Promise<any[]> {
  const pageSize = 1000;
  const results: any[] = [];
  let offset = 0;
  // Offset-based paging needs a fully stable order or pages can skip/repeat
  // rows (e.g. two people who happen to share a full_name, straddling a page
  // boundary) - append id.asc as a tiebreaker under whatever order the
  // caller asked for, rather than trusting their order alone to be unique.
  const order = params.order ? `${params.order},id.asc` : "id.asc";
  for (;;) {
    const page = await supabaseRequest(opts.method ?? "GET", path, {
      params: { ...params, order, limit: String(pageSize), offset: String(offset) },
      body: opts.body,
    });
    if (!page?.length) break;
    results.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

// A comma-separated query param (the org list's multi-select filter
// dropdowns - countries/org_types/sectors/investment_regions, index.html)
// -> a string array, or undefined if absent/empty. None of these values are
// expected to contain a literal comma (country/sector/investment-region
// names), so a plain split is enough - no need for the escaping `in.(...)`/
// `ov.{...}` themselves need once assembled (see inList/arrayOverlap).
function parseListParam(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

// Strips decorative emoji/pictograms from LinkedIn-sourced text - "🍋
// Isabelle Drault Gallo 🍋" or "Growth Hacker 🚀" style decoration people
// add to stand out in a feed, not signal worth keeping. Only matches actual
// pictograph/symbol/flag code points (Extended_Pictographic, regional
// indicators, the ZWJ/variation-selector/keycap combiners that ride along
// with them) - never touches legitimate accented or non-Latin text, so
// "Frédéric" or "Chhay" pass through untouched. Collapses whatever
// whitespace the removal leaves behind; empty result becomes null rather
// than an empty string.
function stripPictograms(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  const cleaned = text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")     // regional-indicator flag letters
    .replace(new RegExp("[‍️⃣]", "g"), "")     // ZWJ, variation selector, combining keycap
    .replace(/ {2,}/g, " ")            // only collapses runs of literal spaces left behind - never touches newlines (multi-line about/bio text)
    .replace(/ *\n */g, "\n")          // trims space now stranded at a line break, without collapsing the break itself
    .trim();
  return cleaned || null;
}

// Collapses any LinkedIn URL variant (country subdomains like at./de./fr.,
// missing www, trailing slash, tracking query strings, http) down to one
// canonical form: https://www.linkedin.com/<path>. Leaves non-LinkedIn or
// unparseable values untouched rather than guessing.
function normalizeLinkedinUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const original = raw.trim();
  if (!original) return null;
  const withScheme = /^https?:\/\//i.test(original) ? original : `https://${original}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return original;
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return original;
  const path = u.pathname.replace(/\/+$/, "");
  return `https://www.linkedin.com${path}`;
}

// Same idea as normalizeLinkedinUrl but for any website: forces https, drops
// www, drops trailing slash - so "duplicate website" matching isn't fooled by
// http vs https or a trailing slash.
function normalizeWebsiteUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const original = raw.trim();
  if (!original) return null;
  const withScheme = /^https?:\/\//i.test(original) ? original : `https://${original}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return original;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  const path = u.pathname.replace(/\/+$/, "");
  return `https://${host}${path}`;
}

// Quotes a value for use inside a PostgREST `or=(...)` filter expression,
// where commas/parens/quotes are syntactically significant.
function orValue(v: string): string {
  return /[,()"]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

// Same idea as orValue, but for the value lists inside an `in.(...)` filter
// or a Postgres array literal (`{...}`) - commas/parens/braces/quotes are
// all syntactically significant there too, so quote whenever one shows up.
function pgListValue(v: string): string {
  return /[,()"{}]/.test(v) ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : v;
}

// `column=in.(a,b,c)` - matches a scalar column against any of several
// values (the org list's Country/Type filter dropdowns - index.html).
function inList(values: string[]): string {
  return `in.(${values.map(pgListValue).join(",")})`;
}

// `column=ov.{a,b,c}` - matches an array column (sectors/investment_regions)
// that overlaps (shares at least one element with) any of several values -
// the org list's Sector/Investment Regions filter dropdowns.
function arrayOverlap(values: string[]): string {
  return `ov.{${values.map(pgListValue).join(",")}}`;
}

function mergeFields(existing: Record<string, any>, newFields: Record<string, any>) {
  const merged: Record<string, any> = {};
  for (const [k, v] of Object.entries(newFields)) {
    merged[k] = isBlank(v) ? existing[k] : v;
  }
  return merged;
}

// For direct-edit PATCH endpoints: only the keys actually present in the
// request body are included (so omitting a field leaves it untouched), but
// unlike mergeFields, a key that IS present is taken exactly as given - null
// or "" included - so the user can deliberately clear a field.
function pickDefined(body: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

// ---------- Organizations / people / memberships ----------

// Treats an org as "the same one" if the name matches, OR its website, OR
// its LinkedIn matches an existing row - so a firm found again under a
// slightly different name (or via a LinkedIn-URL add) still merges into the
// existing record instead of creating a duplicate.
async function findExistingOrganization(name: string, websiteUrl?: string | null, linkedinUrl?: string | null) {
  // A matching website/LinkedIn URL is checked first - a stronger identity
  // signal than a name string, and a plain eq filter (URLs aren't the kind
  // of thing accents show up in, no folding needed).
  const urlParts: string[] = [];
  if (websiteUrl) urlParts.push(`website_url.eq.${orValue(websiteUrl)}`);
  if (linkedinUrl) urlParts.push(`linkedin_url.eq.${orValue(linkedinUrl)}`);
  if (urlParts.length) {
    const urlMatch = await supabaseRequest("GET", "organizations", {
      params: { or: `(${urlParts.join(",")})`, select: "*", limit: "5" },
    });
    if (urlMatch?.length) return urlMatch[0];
  }
  // Falls back to name - via the find_organization_by_name RPC
  // (migration_021) rather than a plain ilike filter, so it's accent-
  // insensitive: typing (or picking from a dropdown) an accented name that
  // resolves differently than what's on file - or vice versa - still finds
  // the same org instead of silently creating a duplicate.
  const nameMatch = await supabaseRequest("GET", "rpc/find_organization_by_name", {
    params: { search_name: name, select: "*", limit: "5" },
  });
  return nameMatch?.[0] ?? null;
}

// Same idea for people: same name OR same LinkedIn URL counts as the same person.
async function findPeopleByNameOrLinkedin(name: string, linkedinUrl?: string | null) {
  const orParts = [`full_name.ilike.${orValue(name)}`];
  if (linkedinUrl) orParts.push(`linkedin_url.eq.${orValue(linkedinUrl)}`);
  const rows = await supabaseRequest("GET", "people", {
    params: { or: `(${orParts.join(",")})`, select: "*" },
  });
  return rows ?? [];
}

// Read-only preview of findPeopleByNameOrLinkedin's own match, with enough
// context (current roles) for a human to tell at a glance whether it's
// really the same person - backs GET /people/match-candidates, called by
// the "Add people" panel before POST /organizations would otherwise use
// that same name/linkedin_url match to silently reuse (or blindly create
// a duplicate of) an existing person. Same shape as one group's "people"
// array from findDuplicatePeopleCandidates, reused for the same reason:
// a name/company summary line, not a bare id.
async function findPersonMatchCandidates(name: string, linkedinUrl?: string | null) {
  const rows = await findPeopleByNameOrLinkedin(name, linkedinUrl);
  if (!rows.length) return [];
  const detailRows = await supabaseRequest("GET", "people", {
    params: {
      id: `in.(${rows.map((r: any) => r.id).join(",")})`,
      select: "id,full_name,linkedin_url,country,memberships(title,is_current,organizations(name))",
    },
  });
  return (detailRows ?? []).map((r: any) => ({
    id: r.id, full_name: r.full_name, linkedin_url: r.linkedin_url ?? null, country: r.country ?? null,
    linkedin_match: !!linkedinUrl && r.linkedin_url === linkedinUrl,
    roles: (r.memberships ?? []).filter((m: any) => m.is_current)
      .map((m: any) => ({ title: m.title, organization: m.organizations?.name ?? null })),
  }));
}

async function saveOrganization(payload: any) {
  const orgIn = payload.organization ?? {};
  const peopleIn: any[] = payload.people ?? [];
  const name = (orgIn.name ?? "").trim();
  if (!name) throw new HttpError(400, "organization.name is required");

  const websiteUrl = normalizeWebsiteUrl(orgIn.website_url);
  const linkedinUrl = normalizeLinkedinUrl(orgIn.linkedin_url);
  const orgFields = {
    name,
    // No fallback to a default type anymore - org_type now spans 20+ very
    // different kinds of organization (see ORG_TYPES), not just investor
    // sub-types where "vc" was a safe generic guess. Genuinely unclassified
    // stays null, same as everywhere else in the app.
    org_type: orgIn.org_type || null,
    website_url: websiteUrl,
    linkedin_url: linkedinUrl,
    hq_country: orgIn.hq_country || null,
    description: orgIn.description || null,
    sectors: Array.isArray(orgIn.sectors) ? orgIn.sectors.filter(Boolean) : [],
    // Investor-profile fields sourced from list-style directories, not from
    // OpenRouter research - present here only so a payload that does carry
    // them (a bulk import) round-trips through the normal merge-only-blanks
    // save path instead of being silently dropped.
    ticket_size: orgIn.ticket_size || null,
    investment_stages: Array.isArray(orgIn.investment_stages) ? orgIn.investment_stages.filter(Boolean) : [],
    investment_regions: Array.isArray(orgIn.investment_regions) ? orgIn.investment_regions.filter(Boolean) : [],
    fund_type_raw: orgIn.fund_type_raw || null,
  };

  const existingOrg = await findExistingOrganization(name, websiteUrl, linkedinUrl);
  let org;
  if (existingOrg) {
    org = (await supabaseRequest("PATCH", "organizations", {
      params: { id: `eq.${existingOrg.id}` },
      body: mergeFields(existingOrg, orgFields),
      prefer: "return=representation",
    }))[0];
  } else {
    org = (await supabaseRequest("POST", "organizations", {
      body: orgFields,
      prefer: "return=representation",
    }))[0];
  }
  const orgExisted = !!existingOrg;

  const savedPeople = [];
  for (const p of peopleIn) {
    const fullName = (p.full_name ?? "").trim();
    if (!fullName) continue;
    const personLinkedinUrl = normalizeLinkedinUrl(p.linkedin_url);
    const personFields = {
      full_name: fullName,
      linkedin_url: personLinkedinUrl,
      country: p.country || null,
    };
    // person_id (set by the "Add people" panel once GET /people/match-
    // candidates found a same-name record and the user confirmed it's who
    // they mean) skips the name search entirely and goes straight to that
    // record. force_new (set once the user said "no, different person")
    // skips only the name half of the match - a genuine linkedin_url match
    // is still a near-certain identity signal even then, so it's still
    // trusted without asking. Neither set (every other caller of
    // saveOrganization - plain /research, imports, ...) keeps the original
    // best-effort name-or-linkedin_url match, unchanged.
    const forcedPersonId = (p.person_id ?? "").trim();
    let candidates: any[] = [];
    if (forcedPersonId) {
      candidates = await supabaseRequest("GET", "people", { params: { id: `eq.${forcedPersonId}`, select: "*" } });
    } else if (p.force_new) {
      candidates = personLinkedinUrl
        ? await supabaseRequest("GET", "people", { params: { linkedin_url: `eq.${personLinkedinUrl}`, select: "*" } })
        : [];
    } else {
      candidates = await findPeopleByNameOrLinkedin(fullName, personLinkedinUrl);
    }
    let membershipsAtThisOrg: any[] = [];
    if (candidates.length) {
      membershipsAtThisOrg = await supabaseRequest("GET", "memberships", {
        params: {
          organization_id: `eq.${org.id}`,
          person_id: `in.(${candidates.map((c: any) => c.id).join(",")})`,
          select: "*",
        },
      });
    }
    let person = null;
    if (membershipsAtThisOrg.length) {
      const matchId = membershipsAtThisOrg[0].person_id;
      person = candidates.find((c: any) => c.id === matchId);
    } else if (candidates.length) {
      person = candidates[0];
    }

    if (person) {
      person = (await supabaseRequest("PATCH", "people", {
        params: { id: `eq.${person.id}` },
        body: mergeFields(person, personFields),
        prefer: "return=representation",
      }))[0];
    } else {
      person = (await supabaseRequest("POST", "people", {
        body: personFields,
        prefer: "return=representation",
      }))[0];
    }

    let membershipFields: Record<string, any> = {
      person_id: person.id,
      organization_id: org.id,
      title: p.title || null,
      focus: p.focus || null,
      is_current: true,
    };
    const existingMembership = membershipsAtThisOrg.find((m: any) => m.person_id === person.id);
    let jobChanged = false;
    if (existingMembership) {
      membershipFields = mergeFields(existingMembership, membershipFields);
      await supabaseRequest("PATCH", "memberships", {
        params: { id: `eq.${existingMembership.id}` },
        body: membershipFields,
      });
    } else {
      // Not yet a member of this org. If they're currently marked as working
      // somewhere else, treat this as a job change: close out the old
      // membership(s) (is_current: false, history preserved) before opening
      // the new one, rather than leaving them "currently" at both.
      const otherCurrentMemberships = await supabaseRequest("GET", "memberships", {
        params: { person_id: `eq.${person.id}`, is_current: "eq.true", select: "id" },
      });
      if (otherCurrentMemberships.length) {
        jobChanged = true;
        for (const m of otherCurrentMemberships) {
          await supabaseRequest("PATCH", "memberships", {
            params: { id: `eq.${m.id}` },
            body: { is_current: false },
          });
        }
      }
      await supabaseRequest("POST", "memberships", { body: membershipFields });
    }

    savedPeople.push({ ...person, title: membershipFields.title, focus: membershipFields.focus, job_changed: jobChanged });
  }

  return { organization: org, people: savedPeople, organization_existed: orgExisted };
}

// Person ids "in the user's network": everyone flagged is_user themselves,
// plus everyone reachable from one of them by a single person<->person row
// in `connections` (either direction - a LinkedIn-connection import only
// ever writes the user as entity_a, but this stays correct regardless of
// which side an edge was written from, and for any future non-LinkedIn
// source of person<->person connections too). Backs the connected_to_user
// flag on both people and organizations rows.
async function getUserConnectedPersonIds(): Promise<Set<string>> {
  const users = await supabaseRequest("GET", "people", { params: { is_user: "eq.true", select: "id" } });
  const userIds: string[] = (users ?? []).map((u: any) => u.id);
  const result = new Set<string>(userIds);
  if (!userIds.length) return result;
  const idList = `(${userIds.join(",")})`;
  // A single user can easily have 1000+ connections (e.g. every LinkedIn-
  // connection import) - paginated, not a single supabaseRequest.
  const [asA, asB] = await Promise.all([
    supabaseRequestAllPages("connections", { entity_a_type: "eq.person", entity_a_id: `in.${idList}`, entity_b_type: "eq.person", select: "entity_b_id" }),
    supabaseRequestAllPages("connections", { entity_b_type: "eq.person", entity_b_id: `in.${idList}`, entity_a_type: "eq.person", select: "entity_a_id" }),
  ]);
  (asA ?? []).forEach((c: any) => result.add(c.entity_b_id));
  (asB ?? []).forEach((c: any) => result.add(c.entity_a_id));
  return result;
}

// Past employers (org_type "employer", pulled from LinkedIn experience
// history via enrichPersonFromApify) are excluded by default - they aren't
// investment organizations and would otherwise flood the primary list this
// tool is actually about. includeEmployers is the escape hatch for browsing
// them directly when wanted.
// Every org with at least one person (current or past) who is themselves
// flagged is_user, or connected to one via `connections` - the JPL column,
// and (below) the jpl_only filter. A flat scan of (organization_id,
// person_id) pairs, cheap regardless of how many orgs are actually being
// asked about, so it's not worth scoping to just one page's ids (that
// would mean an in.(...) list of up to ~1500 UUIDs in the query string
// instead) - computed the same way whether or not jpl_only is set.
async function computeConnectedOrgIds(): Promise<Set<string>> {
  const connectedIds = await getUserConnectedPersonIds();
  const connectedOrgIds = new Set<string>();
  if (!connectedIds.size) return connectedOrgIds;
  const memberships = await supabaseRequestAllPages("memberships", { select: "organization_id,person_id" });
  for (const m of memberships) {
    if (connectedIds.has(m.person_id)) connectedOrgIds.add(m.organization_id);
  }
  return connectedOrgIds;
}

const ORG_SORT_COLUMNS = new Set(["name", "hq_country", "org_type", "updated_at"]);

type ListOrganizationsOptions = {
  includeEmployers: boolean;
  q?: string;
  limit?: number;
  offset?: number;
  starredOnly?: boolean;
  showHidden?: boolean;
  jplOnly?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  withCounts?: boolean;
  countries?: string[];
  orgTypes?: string[];
  sectors?: string[];
  investmentRegions?: string[];
};

// Same "one calendar month back from right now" window as the frontend's
// own (now-retired) client-side enrichedInLastMonthCount - the org/people
// list counts' "enriched in the last month" tooltip, computed here over
// everything matching the current search/filters via a second, filtered
// count query (see countMatching), not just whatever's been scrolled into
// view so far.
function enrichedSinceCutoffIso(): string {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 1);
  return cutoff.toISOString();
}

// limit omitted (undefined): returns everything (supabaseRequestAllPages) -
// the pre-pagination behavior, still relied on by callers that need the
// full list in one shot regardless of what the main org list is currently
// showing (the merge-target dropdown, the add-connection org picker; see
// index.html). limit given: a single page, for the main org list's
// infinite scroll - the caller decides whether there's a next page by
// whether this one came back full (one row in, one row out here, unlike
// searchPeopleGlobal - no membership-flattening to worry about). q, when
// given (and jpl_only isn't), searches via search_organizations_by_text
// (migration_023) - accent-insensitive name or hq_country match - instead
// of the old client-side filter, since a paginated list can't be searched
// against data it hasn't loaded yet. withCounts: also runs two cheap
// count-only queries (countMatching - Prefer: count=exact, limit=0) for the
// list's count/tooltip - the total matching the current filters, and how
// many of those were enriched in the last month - regardless of how much
// of the list has actually been paged in. Only requested by the frontend on
// a real reload (reloadOrgList), not on every infinite-scroll page
// (loadMoreOrgs), since the counts can't have changed just from paging in
// more of the same already-fixed result set.
async function listOrganizations(opts: ListOrganizationsOptions) {
  const sortColumn = opts.sort && ORG_SORT_COLUMNS.has(opts.sort) ? opts.sort : "name";
  const sortDir = opts.dir === "desc" ? "desc" : "asc";
  const params: Record<string, string> = {
    // li_profile_fetched_at is a single cheap timestamp (not one of the
    // heavier li_* profile fields) - included so the list can compute
    // "enriched in the last month" for the count tooltip (index.html)
    // without a separate fetch. investment_regions joins sectors as a
    // second array column now shown as its own list column (index.html).
    select: "id,name,org_type,website_url,linkedin_url,hq_country,country_code,sectors,investment_regions,updated_at,is_starred,is_hidden,li_profile_fetched_at",
    order: `${sortColumn}.${sortDir}`,
  };
  // org_type <> 'employer' would silently also exclude NULL org_type rows -
  // SQL comparisons against NULL are never true, not false - which would
  // hide newly-discovered-but-not-yet-classified orgs from the list they're
  // specifically meant to show up in for classification. Include NULL
  // explicitly instead of relying on neq alone.
  if (!opts.includeEmployers) params.or = "(org_type.is.null,org_type.neq.employer)";
  if (opts.starredOnly) params.is_starred = "eq.true";
  if (!opts.showHidden) params.is_hidden = "eq.false";
  // The Country/Type/Sector/Investment Regions column-header filter
  // dropdowns (index.html) - each independently narrows to whichever
  // values the user checked, ANDed with everything else here (so checking
  // "employer" under Type while "Include past employers" is off still
  // yields nothing, same as it would for any other filter combination that
  // can't simultaneously be satisfied).
  if (opts.countries?.length) params.hq_country = inList(opts.countries);
  if (opts.orgTypes?.length) params.org_type = inList(opts.orgTypes);
  if (opts.sectors?.length) params.sectors = arrayOverlap(opts.sectors);
  if (opts.investmentRegions?.length) params.investment_regions = arrayOverlap(opts.investmentRegions);

  // jpl_only used to add `?id=in.(<every connected org id>)` - that list
  // commonly runs into the thousands, and stuffing it into the URL blew
  // past PostgREST's/Cloudflare's URL length limits (confirmed directly: a
  // 414), which is why the toggle silently came back empty. Routed through
  // organizations_by_ids (migration_024) instead, a POST RPC that takes the
  // id list as a body param (no URL length limit) and folds q in too, so
  // id-restriction and search still combine in one call.
  let connectedOrgIds: Set<string> | null = null;
  let resourcePath: string;
  let method = "GET";
  let body: unknown;
  if (opts.jplOnly) {
    connectedOrgIds = await computeConnectedOrgIds();
    if (!connectedOrgIds.size) return { orgs: [], totalCount: 0, enrichedLastMonthCount: 0 };
    resourcePath = "rpc/organizations_by_ids";
    method = "POST";
    body = { target_ids: [...connectedOrgIds], search_query: opts.q ?? null };
  } else {
    resourcePath = opts.q ? "rpc/search_organizations_by_text" : "organizations";
    if (opts.q) params.search_query = opts.q;
  }

  const [orgs, totalCount, enrichedLastMonthCount] = await Promise.all([
    opts.limit !== undefined
      ? (await supabaseRequest(method, resourcePath, {
          params: { ...params, limit: String(opts.limit), offset: String(opts.offset ?? 0) },
          body,
        })) ?? []
      : supabaseRequestAllPages(resourcePath, params, { method, body }),
    opts.limit !== undefined && opts.withCounts ? countMatching(method, resourcePath, params, body) : undefined,
    opts.limit !== undefined && opts.withCounts
      ? countMatching(method, resourcePath, { ...params, li_profile_fetched_at: `gte.${enrichedSinceCutoffIso()}` }, body)
      : undefined,
  ]);
  if (!orgs.length) return { orgs, totalCount, enrichedLastMonthCount };

  if (!connectedOrgIds) connectedOrgIds = await computeConnectedOrgIds();
  for (const o of orgs) o.connected_to_user = connectedOrgIds.has(o.id);
  return { orgs, totalCount, enrichedLastMonthCount };
}

// Backs the org list's Country/Type/Sector/Investment Regions column-header
// filter dropdowns (index.html) - the checkbox options for each, as
// whatever values actually appear across EVERY organization (not scoped to
// the current include_employers/show_hidden/other-filter state, so opening
// one filter dropdown never depends on what's currently selected in
// another, and checking a box always stays a meaningful thing to do even
// after the list it's filtering has been narrowed down to nothing).
// org_type already has a fixed taxonomy elsewhere (ORG_TYPE_LABEL in
// index.html, the check constraint in migration_012) but this still reads
// distinct values from the data rather than that full list, so a type nothing
// is currently classified as doesn't show up as a dead-end checkbox.
async function getOrgFilterOptions() {
  const rows = await supabaseRequestAllPages("organizations", {
    select: "hq_country,org_type,sectors,investment_regions",
  });
  const countries = new Set<string>();
  const orgTypes = new Set<string>();
  const sectors = new Set<string>();
  const investmentRegions = new Set<string>();
  for (const r of rows) {
    if (r.hq_country) countries.add(r.hq_country);
    if (r.org_type) orgTypes.add(r.org_type);
    for (const s of r.sectors ?? []) if (s) sectors.add(s);
    for (const region of r.investment_regions ?? []) if (region) investmentRegions.add(region);
  }
  const sortedList = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return {
    countries: sortedList(countries),
    org_types: sortedList(orgTypes),
    sectors: sortedList(sectors),
    investment_regions: sortedList(investmentRegions),
  };
}

// The sector tags research (researchOrganization/researchPerson) is told to
// prefer reusing, so it stops inventing fresh wording for a concept already
// on file ("Climate tech" one day, "ClimateTech" the next, "Climate Tech"
// after that - exactly the kind of near-duplicate sprawl a 2026-09
// cleanup pass had to fix by hand across hundreds of orgs). Capped to
// tags already used by at least 2 organizations - the long tail of
// once-only, highly specific tags isn't established vocabulary worth
// nudging new research toward, and would just bloat the prompt.
async function getEstablishedSectorTags(): Promise<string[]> {
  const rows = await supabaseRequestAllPages("organizations", { select: "sectors" });
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const s of r.sectors ?? []) {
      if (!s) continue;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

// The sector-tag bullet both researchOrganization and researchPerson's
// prompts use, parameterized by the current established vocabulary
// (getEstablishedSectorTags) - fetched fresh per request rather than
// cached, so a tag added a moment ago is already available to steer the
// very next research call, and the list never goes stale.
function sectorTagInstructions(existingTags: string[]): string {
  if (!existingTags.length) return `2-6 short sector/industry tags it's associated with (e.g. "Fintech", "AI infrastructure", "Climate tech")`;
  return `2-6 short sector/industry tags it's associated with. Prefer reusing one of these existing tags if it genuinely fits, rather than inventing new wording for the same concept - only add a new tag when none of these are a good match: ${existingTags.join(", ")}`;
}

// Same idea as findDuplicatePeopleCandidates (see there for nameFingerprint/
// normalizeLinkedinUrl and groupByKeys, shared with this) - groups every
// organization by a fingerprint of its name OR its normalized linkedin_url,
// and returns any resulting group with more than one org. Single pass, no
// separate detail query needed: organizations is already a much smaller
// table than people, and the fields worth showing for context (org_type/
// linkedin_url/hq_country) are cheap enough to just select up front for
// everyone rather than fetch in two steps.
async function findDuplicateOrgCandidates() {
  const [rows, dismissed] = await Promise.all([
    supabaseRequestAllPages("organizations", { select: "id,name,org_type,linkedin_url,hq_country,li_company_id" }),
    getDismissedDuplicateKeys("organization"),
  ]);
  const rowsById = new Map((rows ?? []).map((r: any) => [r.id, r]));
  const groups = groupByKeys(
    rows ?? [],
    (r: any) => r.id,
    // li_company_id is LinkedIn's own stable numeric id for the company -
    // two orgs sharing one are certainly the same real company, even when
    // linkedin_url differs (a stale/renamed slug) or is missing on one side.
    [(r: any) => orgNameFingerprint(r.name) || null, (r: any) => normalizeLinkedinUrl(r.linkedin_url), (r: any) => r.li_company_id || null],
  );
  return [...groups.values()]
    .map((ids) => ids.map((id) => rowsById.get(id)))
    .filter((g) => g.length > 1 && !dismissed.has(groupMemberKey(g.map((o: any) => o.id))))
    .map((g) => ({
      orgs: g.map((o: any) => ({ id: o.id, name: o.name, org_type: o.org_type, linkedin_url: o.linkedin_url, hq_country: o.hq_country })),
    }));
}

async function getOrganization(id: string) {
  const orgs = await supabaseRequest("GET", "organizations", { params: { id: `eq.${id}`, select: "*" } });
  if (!orgs?.length) return null;
  const org = orgs[0];
  org.people = await supabaseRequest("GET", "memberships", {
    params: {
      organization_id: `eq.${id}`,
      select: "id,title,focus,is_current,start_date,end_date,people(*)",
    },
  });
  const connectedIds = await getUserConnectedPersonIds();
  for (const m of org.people ?? []) {
    if (m.people) m.people.connected_to_user = connectedIds.has(m.people.id);
  }
  return org;
}

// Merges sourceId into targetId: sourceId's team members and org<->org
// connections move onto targetId, targetId backfills any field it's
// currently blank on from sourceId (mergeFields, same "existing wins unless
// blank" idea as saveOrganization - just with the argument order flipped,
// since here the *target* is the one whose values should win), and sourceId
// is deleted. targetId's `name` is never touched - the whole point of
// picking a target is that its name is the one to keep.
async function mergeOrgInto(sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new HttpError(400, "Can't merge an organization into itself.");
  const [sourceRows, targetRows] = await Promise.all([
    supabaseRequest("GET", "organizations", { params: { id: `eq.${sourceId}`, select: "*" } }),
    supabaseRequest("GET", "organizations", { params: { id: `eq.${targetId}`, select: "*" } }),
  ]);
  const source = sourceRows?.[0];
  const target = targetRows?.[0];
  if (!source) throw new HttpError(404, "source organization not found");
  if (!target) throw new HttpError(404, "target organization not found");

  // Memberships: move each of source's onto target, unless target already
  // has a membership for that exact (person, title) - in which case it's a
  // pure duplicate of one already there and is just dropped, rather than
  // moved and colliding with the memberships_person_id_organization_id_title_key
  // unique constraint (same situation as the LinkedIn-connections import's
  // membership step earlier - see li_step4_memberships).
  const [sourceMemberships, targetMemberships] = await Promise.all([
    supabaseRequest("GET", "memberships", { params: { organization_id: `eq.${sourceId}`, select: "id,person_id,title" } }),
    supabaseRequest("GET", "memberships", { params: { organization_id: `eq.${targetId}`, select: "person_id,title" } }),
  ]);
  const targetKey = (m: { person_id: string; title: string | null }) => `${m.person_id}::${m.title ?? ""}`;
  const targetHas = new Set((targetMemberships ?? []).map(targetKey));
  for (const m of sourceMemberships ?? []) {
    if (targetHas.has(targetKey(m))) {
      await supabaseRequest("DELETE", "memberships", { params: { id: `eq.${m.id}` } });
    } else {
      await supabaseRequest("PATCH", "memberships", { params: { id: `eq.${m.id}` }, body: { organization_id: targetId } });
    }
  }

  // Connections: remap either side that points at source, except a
  // connection that already runs directly between source and target - that
  // would become a self-loop (target<->target) once remapped, so it's
  // dropped instead.
  const [asA, asB] = await Promise.all([
    supabaseRequest("GET", "connections", {
      params: { entity_a_type: "eq.organization", entity_a_id: `eq.${sourceId}`, select: "id,entity_b_type,entity_b_id" },
    }),
    supabaseRequest("GET", "connections", {
      params: { entity_b_type: "eq.organization", entity_b_id: `eq.${sourceId}`, select: "id,entity_a_type,entity_a_id" },
    }),
  ]);
  for (const c of asA ?? []) {
    const wouldSelfLoop = c.entity_b_type === "organization" && c.entity_b_id === targetId;
    if (wouldSelfLoop) await supabaseRequest("DELETE", "connections", { params: { id: `eq.${c.id}` } });
    else await supabaseRequest("PATCH", "connections", { params: { id: `eq.${c.id}` }, body: { entity_a_id: targetId } });
  }
  for (const c of asB ?? []) {
    const wouldSelfLoop = c.entity_a_type === "organization" && c.entity_a_id === targetId;
    if (wouldSelfLoop) await supabaseRequest("DELETE", "connections", { params: { id: `eq.${c.id}` } });
    else await supabaseRequest("PATCH", "connections", { params: { id: `eq.${c.id}` }, body: { entity_b_id: targetId } });
  }

  // Field backfill: every column target is currently blank on gets filled
  // from source, whatever it is (investor-profile fields, li_* fields
  // included) - id/created_at/updated_at/name are excluded, name because
  // target's is the one being kept, the others because they're not
  // meaningful to merge.
  const { id: _tid, created_at: _tca, updated_at: _tua, name: _tname, ...targetFieldsToFill } = target;
  const fields = mergeFields(source, targetFieldsToFill);
  // mergeFields only fills a field that's blank on target - false isn't
  // blank (isBlank), so is_starred otherwise never picks up a true from
  // source when target itself is unstarred, silently losing the star. A
  // merge should never make something LESS starred than either side was.
  fields.is_starred = source.is_starred || target.is_starred;
  const updated = (await supabaseRequest("PATCH", "organizations", {
    params: { id: `eq.${targetId}` },
    body: fields,
    prefer: "return=representation",
  }))[0];

  // News items aren't moved (same as a plain delete - see DELETE /organizations/:id):
  // they're not FK-linked to organizations at all (entity_type/entity_id is
  // generic, covering people too), so this just leaves them orphaned rather
  // than breaking anything.
  await supabaseRequest("DELETE", "organizations", { params: { id: `eq.${sourceId}` } });
  return updated;
}

// ---------- Connections (org<->org relationships: subsidiary/CVC-arm/division/other) ----------

async function listOrgConnections(orgId: string) {
  const [asA, asB] = await Promise.all([
    supabaseRequest("GET", "connections", {
      params: { entity_a_type: "eq.organization", entity_a_id: `eq.${orgId}`, select: "*" },
    }),
    supabaseRequest("GET", "connections", {
      params: { entity_b_type: "eq.organization", entity_b_id: `eq.${orgId}`, select: "*" },
    }),
  ]);
  const combined = [
    ...(asA ?? []).map((c: any) => ({
      id: c.id, relationship_type: c.relationship_type, notes: c.notes,
      direction: "a", other_type: c.entity_b_type, other_id: c.entity_b_id,
    })),
    ...(asB ?? []).map((c: any) => ({
      id: c.id, relationship_type: c.relationship_type, notes: c.notes,
      direction: "b", other_type: c.entity_a_type, other_id: c.entity_a_id,
    })),
  ];
  const orgIds = [...new Set(combined.filter((c) => c.other_type === "organization").map((c) => c.other_id))];
  let orgsById: Record<string, any> = {};
  if (orgIds.length) {
    const orgs = await supabaseRequest("GET", "organizations", {
      params: { id: `in.(${orgIds.join(",")})`, select: "id,name,org_type" },
    });
    orgsById = Object.fromEntries((orgs ?? []).map((o: any) => [o.id, o]));
  }
  return combined.map((c) => ({ ...c, other: c.other_type === "organization" ? orgsById[c.other_id] ?? null : null }));
}

async function createOrgConnection(
  orgId: string, relationshipType: string, otherOrgId: string, otherOrgName: string, notes: string,
) {
  let targetId = (otherOrgId ?? "").trim();
  if (!targetId) {
    if (!otherOrgName) throw new HttpError(400, "other_org_id or other_org_name is required");
    const existing = await findExistingOrganization(otherOrgName, null, null);
    if (existing) {
      targetId = existing.id;
    } else {
      const created = (await supabaseRequest("POST", "organizations", {
        body: { name: otherOrgName, org_type: "group" },
        prefer: "return=representation",
      }))[0];
      targetId = created.id;
    }
  }
  const row = (await supabaseRequest("POST", "connections", {
    body: {
      entity_a_type: "organization", entity_a_id: orgId,
      entity_b_type: "organization", entity_b_id: targetId,
      relationship_type: relationshipType,
      notes: notes || null,
    },
    prefer: "return=representation",
  }))[0];
  const other = (await supabaseRequest("GET", "organizations", {
    params: { id: `eq.${targetId}`, select: "id,name,org_type" },
  }))[0];
  return { id: row.id, relationship_type: row.relationship_type, notes: row.notes, direction: "a", other };
}

// includePast=false (default): one row per CURRENT membership - someone
// with two concurrent current roles (e.g. partner at a fund plus a board
// seat elsewhere) shows both, not just one "best" row picked between them
// (an earlier version of this function did that, which is what made a
// second current role look like it was only visible with "Include ex-
// employees" checked - it doesn't need that checkbox, it's current). A
// person with no current membership at all doesn't appear, matching the
// same strict current-only filter the org-scoped list already applies
// client-side. includePast=true: one row per membership regardless of
// is_current, so past roles show too (e.g. two past stints at the same
// company).
type SearchPeopleOptions = {
  query: string;
  includePast: boolean;
  limit?: number;
  offset?: number;
  starredOnly?: boolean;
  baOnly?: boolean;
  showHidden?: boolean;
  jplOnly?: boolean;
  withCounts?: boolean;
};

// limit omitted: returns everything, paginated internally
// (supabaseRequestAllPages) - the pre-pagination behavior, still relied on
// by callers that need the full list in one shot regardless of what the
// main people list is currently showing (the merge-target dropdown, see
// ensurePeopleNamesCache in index.html). limit given: a single page.
// Unlike listOrganizations, a "page" at the DB level (opts.limit people
// rows) doesn't map 1:1 to a page of output rows - each person is
// flattened into one row per membership below, so the returned array's
// length can land above, below, or (only coincidentally) at opts.limit.
// The frontend's infinite-scroll "did a full page come back" check can't
// use that length, then - so hasMore is computed here instead, from the
// raw pre-flatten count, and returned alongside the rows (see the /people
// route handler, which puts it on a response header). starred_only/
// ba_only/show_hidden/jpl_only filter server-side here now, for the same
// reason the org list's toggles do - a paginated list can't be filtered
// client-side against data it hasn't loaded yet. withCounts: also runs the
// count_people RPC (migration_025) for the list's count/tooltip - people
// matching the current filters, and how many of those were enriched in the
// last month - over everyone matching, not just what's been paged in.
// Doesn't reuse the generic countMatching/Prefer:count=exact approach
// listOrganizations uses: which people actually appear depends on
// includePast (a person with zero CURRENT memberships produces no row
// unless include_past is set - see the flattening loop below), which needs
// an EXISTS check against `memberships` that PostgREST's embed-filter
// syntax turned out not to support on top of an RPC-returned relation
// (confirmed directly: "column pgrst_call.is_current does not exist") -
// count_people does that check in SQL instead, and folds in the id-
// restriction/search that'd otherwise come from whichever of
// people/search_people_by_name/people_by_ids the main query below is
// using, so it doesn't need to care which of those this call picked.
async function searchPeopleGlobal(opts: SearchPeopleOptions): Promise<{ rows: any[]; hasMore: boolean; totalCount?: number; enrichedLastMonthCount?: number }> {
  const { query, includePast } = opts;
  const params: Record<string, string> = {
    // Lean, list-only fields - NOT select=* - the li_* LinkedIn-profile
    // columns (photo, headline, about, experience, education, skills, ...)
    // are the bulk of a person row and aren't used anywhere in the list
    // itself, only the detail pane, which fetches them for just the one
    // person actually opened (GET /people/:id, see loadPersonLinkedinDetail
    // in index.html) rather than every person in the list carrying that
    // weight whether opened or not - same idea as an org's detail pane
    // already doing its own GET /organizations/:id instead of reusing its
    // list row. On a "show everyone" scan (thousands of rows) this was the
    // single biggest driver of a slow, several-MB response. li_profile_
    // fetched_at is the one li_* field that DOES belong here despite that -
    // a single cheap timestamp, not one of the heavy fields - so the bulk
    // "Enrich all" button (runEnrichAllPeople in index.html) can tell who's
    // already been enriched without a per-person fetch.
    select: "id,full_name,linkedin_url,country,country_code,is_user,is_starred,is_hidden,is_ba,li_profile_fetched_at,memberships(id,organization_id,is_current,updated_at,title,focus,start_date,end_date,organizations(id,name))",
    order: "full_name.asc",
  };
  if (opts.starredOnly) params.is_starred = "eq.true";
  if (opts.baOnly) params.is_ba = "eq.true";
  if (!opts.showHidden) params.is_hidden = "eq.false";

  // connectedIds is needed for connected_to_user on every row regardless of
  // jpl_only, so it's always computed - jpl_only just also uses it as an id
  // filter on the query below.
  const connectedIds = await getUserConnectedPersonIds();

  // jpl_only used to add `?id=in.(<every connected person id>)` - that list
  // commonly runs into the thousands, and stuffing it into the URL blew
  // past PostgREST's/Cloudflare's URL length limits (confirmed directly: a
  // 400), which is why the toggle silently came back empty. Routed through
  // people_by_ids (migration_024) instead, a POST RPC that takes the id
  // list as a body param (no URL length limit) and folds the name search in
  // too, so id-restriction and search still combine in one call.
  let resourcePath: string;
  let method = "GET";
  let body: unknown;
  if (opts.jplOnly) {
    if (!connectedIds.size) return { rows: [], hasMore: false, totalCount: 0, enrichedLastMonthCount: 0 };
    resourcePath = "rpc/people_by_ids";
    method = "POST";
    body = { target_ids: [...connectedIds], search_query: query || null };
  } else {
    // A real search goes through the search_people_by_name RPC
    // (migration_020) instead of a plain ilike filter, so it's accent-
    // insensitive - "kart" matches "Kärt", "romeo" matches "Roméo" - via
    // Postgres's own unaccent() rather than reimplementing accent folding
    // here; select=/order=/limit= still work on it the same as a normal
    // table query since it's STABLE and returns setof people.
    resourcePath = query ? "rpc/search_people_by_name" : "people";
    if (query) params.search_query = query;
  }

  const countBody = {
    target_ids: opts.jplOnly ? [...connectedIds] : null,
    search_query: query || null,
    include_past: includePast,
    starred_only: !!opts.starredOnly,
    ba_only: !!opts.baOnly,
    show_hidden: !!opts.showHidden,
  };
  const [people, totalCount, enrichedLastMonthCount] = await Promise.all([
    opts.limit !== undefined
      ? (await supabaseRequest(method, resourcePath, {
          params: { ...params, limit: String(opts.limit), offset: String(opts.offset ?? 0) },
          body,
        })) ?? []
      : supabaseRequestAllPages(resourcePath, params, { method, body }),
    opts.limit !== undefined && opts.withCounts
      ? supabaseRequest("POST", "rpc/count_people", { body: countBody })
      : undefined,
    opts.limit !== undefined && opts.withCounts
      ? supabaseRequest("POST", "rpc/count_people", { body: { ...countBody, enriched_since: enrichedSinceCutoffIso() } })
      : undefined,
  ]);
  const hasMore = opts.limit !== undefined && people.length === opts.limit;

  const rows: any[] = [];
  for (const p of people ?? []) {
    const { memberships, ...rest } = p;
    rest.connected_to_user = connectedIds.has(p.id);
    const ms = memberships || [];
    const toRow = (m: any) => ({
      ...rest, title: m?.title || null, focus: m?.focus || null, membership_id: m?.id || null,
      is_current: m?.is_current ?? null, start_date: m?.start_date || null, end_date: m?.end_date || null,
      organization: m?.organizations || null,
    });
    if (includePast) {
      if (ms.length) ms.forEach((m: any) => rows.push(toRow(m)));
      else rows.push(toRow(null));
    } else {
      ms.filter((m: any) => m.is_current).forEach((m: any) => rows.push(toRow(m)));
    }
  }
  return { rows, hasMore, totalCount, enrichedLastMonthCount };
}

// Case/accent/punctuation/spacing-insensitive fingerprint of a name - two
// people collide here if they're spelled the same once you ignore how
// they're spelled ("Alexis Le Portz" and "Alexis Leportz" both become
// "alexisleportz"; an accented "Möller" and a plain "Moller" both become
// "moller"). Deliberately narrow: catches spacing/accent/punctuation
// variants and exact-name duplicates, NOT reordered names, nicknames, or
// misspellings a human would still recognize - a human still confirms each
// group before merging, this is just what surfaces candidates worth a look.
function nameFingerprint(name: string): string {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// A trailing domain-like suffix on an org name ("Zaion.ai", "Appsfire.com",
// "ApiBots.io" - all three found in this data, alongside the bare-name
// record for the same company) doesn't survive nameFingerprint as a match:
// stripping punctuation still leaves the suffix's own letters in place
// ("Zaion" -> "zaion", "Zaion.ai" -> "zaionai" - different strings). Common
// enough among startups naming themselves after their own domain that it's
// worth widening findDuplicateOrgCandidates for specifically (people don't
// have this pattern, so nameFingerprint alone still covers them). Only
// strips one recognized suffix, and only at the very end of the name - a
// company that just happens to have "AI" as the last word ("Anthropic AI")
// isn't touched, since there's no leading "." for the regex to match.
const ORG_NAME_SUFFIX_RE = /\.(ai|io|com|co|app|net|org|inc|tech|xyz)$/i;

// A trailing legal-entity designator ("Acme AG", "Acme GmbH", "Acme Ltd.",
// "Acme, Inc.", "Acme S.A.") is the same kind of miss as the domain suffix
// above, just word-shaped instead of ".xyz"-shaped - "Acme" and "Acme AG"
// otherwise fingerprint as "acme" vs "acmeag", never colliding. Periods are
// stripped before matching (so "S.A." and "SA" both hit the same entry),
// and up to two trailing words are dropped ("Pty Ltd", "Sp z o.o.") as long
// as each one is on the list - a real company whose actual, distinctive
// name happens to end in one of these short words ("Atlas AS") can still
// collide with an unrelated same-prefix org this way, but that's the same
// tradeoff the domain-suffix stripping already makes: this only surfaces
// candidates for a human to confirm, never merges anything on its own.
const LEGAL_SUFFIX_WORDS = new Set([
  "ag", "gmbh", "mbh", "ug", "kgaa",
  "sarl", "sas", "sasu", "eurl", "sa", "spa", "srl", "sl",
  "bv", "nv", "oy", "oyj", "ab", "aps", "as", "kft",
  "plc", "llp", "llc", "ltd", "limited", "inc", "incorporated",
  "corp", "corporation", "co", "company", "pty", "pte",
]);
function stripLegalSuffix(name: string): string {
  const words = name.replace(/\./g, "").trim().split(/\s+/);
  while (words.length > 1 && LEGAL_SUFFIX_WORDS.has(words[words.length - 1].toLowerCase().replace(/,$/, ""))) {
    words.pop();
  }
  return words.join(" ");
}

function orgNameFingerprint(name: string): string {
  return nameFingerprint(stripLegalSuffix(name.trim().replace(ORG_NAME_SUFFIX_RE, "")));
}

// Groups every id in `ids` into connected components, where two ids are
// linked if they share a value under ANY of the given key functions - used
// by findDuplicatePeopleCandidates/findDuplicateOrgCandidates so a pair
// sharing a linkedin_url still surfaces as a candidate even if their names
// look nothing alike (a rename, a nickname, a typo bad enough that
// nameFingerprint wouldn't catch it), and the reverse (same name,
// different/missing linkedin_url) still works exactly as before. Grouping
// is transitive - if a-b share a name and b-c share a linkedin_url, all
// three land in one group - so a rename caught mid-way still pulls
// everything together rather than splitting into two separate pairs.
// keyFns each return a normalized key for one record (a nameFingerprint or
// a normalizeLinkedinUrl call, say), or null/"" to opt that record out of
// that particular key's linking (e.g. no linkedin_url on file).
function groupByKeys<T>(records: T[], idOf: (r: T) => string, keyFns: ((r: T) => string | null)[]): Map<string, string[]> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of records) parent.set(idOf(r), idOf(r));
  for (const keyFn of keyFns) {
    const byKey = new Map<string, string>();  // key -> first id seen with it
    for (const r of records) {
      const key = keyFn(r);
      if (!key) continue;
      const id = idOf(r);
      const firstId = byKey.get(key);
      if (firstId) union(firstId, id);
      else byKey.set(key, id);
    }
  }
  const groups = new Map<string, string[]>();
  for (const r of records) {
    const root = find(idOf(r));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(idOf(r));
  }
  return groups;
}

// "Not duplicates" in the merge-candidates pop-up (people and orgs both) -
// dismissed_duplicate_groups (migration_022) remembers that decision so the
// same group doesn't keep resurfacing. Keyed on the exact set of member ids
// (sorted, comma-joined), not the name fingerprint that grouped them - if a
// third record with the same fingerprint shows up later, that's a new
// combination the user hasn't judged yet, so it surfaces again even though
// the original pair stays dismissed.
function groupMemberKey(ids: string[]): string {
  return [...ids].sort().join(",");
}

async function getDismissedDuplicateKeys(entityType: "person" | "organization"): Promise<Set<string>> {
  const rows = await supabaseRequest("GET", "dismissed_duplicate_groups", {
    params: { entity_type: `eq.${entityType}`, select: "member_ids" },
  });
  return new Set((rows ?? []).map((r: any) => r.member_ids));
}

async function dismissDuplicateGroup(entityType: "person" | "organization", ids: string[]) {
  if (!Array.isArray(ids) || ids.length < 2) throw new HttpError(400, "ids must be an array of at least two ids");
  await supabaseRequest("POST", "dismissed_duplicate_groups", {
    params: { on_conflict: "entity_type,member_ids" },
    body: { entity_type: entityType, member_ids: groupMemberKey(ids) },
    prefer: "resolution=ignore-duplicates",  // already dismissed - fine, not an error
  });
  return { ok: true };
}

// Groups every person by nameFingerprint OR normalized linkedin_url (see
// groupByKeys) and returns any resulting group with more than one person,
// each with enough context (current roles) for a human to tell at a glance
// whether they're really the same person. The linkedin_url link catches a
// pair nameFingerprint alone would miss entirely - a rename, a nickname, a
// spelling gap too wide for the fingerprint - since two records pointing at
// the identical LinkedIn profile are about as certain a duplicate signal as
// this app has. Two passes: a cheap id+name+linkedin_url scan of the whole
// table first (this is what runs on every people-list load, so it stays
// light), then a second, detail query scoped to only the handful of people
// who actually landed in a group, not the whole table.
async function findDuplicatePeopleCandidates() {
  const [rows, dismissed] = await Promise.all([
    supabaseRequestAllPages("people", { select: "id,full_name,linkedin_url" }),
    getDismissedDuplicateKeys("person"),
  ]);
  const groups = groupByKeys(
    rows ?? [],
    (r: any) => r.id,
    [(r: any) => nameFingerprint(r.full_name) || null, (r: any) => normalizeLinkedinUrl(r.linkedin_url)],
  );
  const rowsById = new Map((rows ?? []).map((r: any) => [r.id, r]));
  const dupeGroups = [...groups.values()]
    .map((ids) => ids.map((id) => rowsById.get(id)))
    .filter((g) => g.length > 1 && !dismissed.has(groupMemberKey(g.map((p: any) => p.id))));
  if (!dupeGroups.length) return [];

  const allIds = dupeGroups.flatMap((g) => g.map((p) => p.id));
  const detailRows = await supabaseRequest("GET", "people", {
    params: {
      id: `in.(${allIds.join(",")})`,
      select: "id,full_name,linkedin_url,country,memberships(title,is_current,organizations(name))",
    },
  });
  const byId = new Map((detailRows ?? []).map((r: any) => [r.id, r]));

  return dupeGroups.map((g) => ({
    people: g.map((p) => {
      const full: any = byId.get(p.id) ?? {};
      const currentRoles = (full.memberships ?? [])
        .filter((m: any) => m.is_current)
        .map((m: any) => ({ title: m.title, organization: m.organizations?.name ?? null }));
      return {
        id: p.id, full_name: p.full_name,
        linkedin_url: full.linkedin_url ?? null, country: full.country ?? null,
        roles: currentRoles,
      };
    }),
  }));
}

// ---------- Apollo (free organizations/enrich backfill only) ----------

function domainFromUrl(url?: string | null): string | null {
  if (!url) return null;
  let domain = url.trim().replace(/^https?:\/\//i, "").split("/")[0];
  domain = domain.replace(/^www\./i, "");
  return domain || null;
}

function formatLocation(city?: string | null, state?: string | null, country?: string | null) {
  if (city && state && country === "United States") return `${city}, ${state}`;
  if (city && country) return `${city}, ${country}`;
  return country || null;
}

async function apolloEnrichByDomain(domain: string): Promise<any | null> {
  try {
    const res = await fetchWithTimeout(`${APOLLO_BASE}/organizations/enrich?${new URLSearchParams({ domain })}`, {
      headers: { "x-api-key": APOLLO_API_KEY!, Accept: "application/json" },
    }, 15000);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.organization ?? null;
  } catch {
    return null;
  }
}

async function backfillFromApollo(org: Record<string, any>) {
  if (!APOLLO_API_KEY) return;
  const domain = domainFromUrl(org.website_url);
  if (!domain) return;
  const apolloOrg = await apolloEnrichByDomain(domain);
  if (!apolloOrg) return;
  if (!org.linkedin_url && apolloOrg.linkedin_url) org.linkedin_url = apolloOrg.linkedin_url;
  if (!org.description && apolloOrg.short_description) org.description = apolloOrg.short_description;
  if (!org.hq_country) {
    const loc = formatLocation(apolloOrg.city, apolloOrg.state, apolloOrg.country);
    if (loc) org.hq_country = loc;
  }
}

// ---------- Apify (two actors: a person LinkedIn-profile scraper and an org
// LinkedIn-company scraper - https://console.apify.com/actors/LpVuK3Zozwuipa5bp
// and https://console.apify.com/actors/UwSdACBp7ymaGUJjS (harvestapi/
// linkedin-company - same vendor as the person actor, swapped in for a
// richer response than the original unseenuser/LinkedIn-Company-Scraper,
// FEoKDOO9YzPRRz8Pf) respectively) ----------

const APIFY_LINKEDIN_PROFILE_ACTOR = "LpVuK3Zozwuipa5bp";
const APIFY_LINKEDIN_COMPANY_ACTOR = "UwSdACBp7ymaGUJjS";

// Starts a run and polls it directly (rather than the run-sync-get-
// dataset-items shortcut) specifically so a failed/aborted/timed-out run
// surfaces its real status and statusMessage - the shortcut endpoint can
// return "200 OK, zero items" for a run that didn't actually succeed,
// with nothing in the response to say why. Shared by both actors below -
// the run/poll/dataset-read mechanics are identical, only the actor id and
// input body differ.
async function runApifyActorAndGetFirstItem(actorId: string, input: Record<string, unknown>): Promise<any> {
  if (!APIFY_API_TOKEN) throw new HttpError(503, "APIFY_API_TOKEN is not configured.");

  // This does a start + several polls + a dataset read (with its own
  // retries) - each phase previously had its own generous independent
  // timeout, and those stacked up past Supabase's 150s per-request kill
  // switch (the wall-clock limit documented on openRouterCall above; the
  // same platform ceiling, hit here for the first time by a multi-phase
  // call instead of a slow single one). One shared 90s budget for the whole
  // function keeps every phase's timeout bounded by what's actually left,
  // so the total can't blow the platform limit - and it fails with a clear
  // timeout error well before that limit would kill it uncleanly.
  const overallDeadline = Date.now() + 90000;
  const remaining = () => overallDeadline - Date.now();
  const phaseTimeout = (capMs: number) => Math.max(1000, Math.min(capMs, remaining()));

  const startRes = await fetchWithTimeout(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_TOKEN}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
    phaseTimeout(15000),
  );
  if (!startRes.ok) {
    const detail = (await startRes.text()).slice(0, 500);
    throw new Error(`Apify run start failed (${startRes.status}): ${detail}`);
  }
  let run = (await startRes.json())?.data;
  if (!run?.id) throw new Error(`Apify run start returned no run id: ${JSON.stringify(run).slice(0, 300)}`);

  while ((run.status === "READY" || run.status === "RUNNING") && remaining() > 5000) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const pollRes = await fetchWithTimeout(`https://api.apify.com/v2/actor-runs/${run.id}?token=${APIFY_API_TOKEN}`, {}, phaseTimeout(10000));
    if (!pollRes.ok) break;  // keep the last known run state rather than erroring on a transient poll failure
    run = (await pollRes.json())?.data ?? run;
  }

  if (run.status !== "SUCCEEDED") {
    throw new Error(`Apify run ended with status ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""} (run ${run.id})`);
  }
  if (!run.defaultDatasetId) throw new Error(`Apify run succeeded but has no dataset (run ${run.id})`);

  // The run object flipping to SUCCEEDED doesn't guarantee the dataset write
  // it just made is visible to a read a moment later - retry the items fetch
  // on an empty result before concluding it's genuinely empty, rather than
  // reporting that on what might just be a read-after-write race.
  let item: any = null;
  while (!item && remaining() > 2000) {
    const itemsRes = await fetchWithTimeout(
      `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_API_TOKEN}&format=json`, {}, phaseTimeout(10000),
    );
    if (!itemsRes.ok) {
      const detail = (await itemsRes.text()).slice(0, 500);
      throw new Error(`Apify dataset fetch failed (${itemsRes.status}): ${detail}`);
    }
    const items = await itemsRes.json();
    item = Array.isArray(items) ? items[0] : null;
    if (!item && remaining() > 2000) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!item) {
    // A run this consistently produces zero items (confirmed reproducible,
    // not a one-off) points at the input the actor actually received, not
    // at timing - fetch it directly instead of asking to go check the Apify
    // console by hand.
    let recordedInput = "(couldn't fetch)";
    try {
      if (run.defaultKeyValueStoreId) {
        const inputRes = await fetchWithTimeout(
          `https://api.apify.com/v2/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT?token=${APIFY_API_TOKEN}`,
          {}, phaseTimeout(8000),
        );
        if (inputRes.ok) recordedInput = (await inputRes.text()).slice(0, 300);
      }
    } catch {
      // best-effort diagnostic only - don't let it mask the real error below
    }
    throw new Error(
      `Apify run ${run.id} succeeded but its dataset (${run.defaultDatasetId}) had no items after retrying. Recorded input: ${recordedInput}`,
    );
  }
  return item;
}

// The actor's input schema (confirmed against its current Console UI form -
// the .actor/input_schema.json fetched from its source at integration time
// showed a flat {url|publicIdentifier|profileId} shape, but the actor has
// since been rebuilt to take a batch-oriented {profileScraperMode, queries[]}
// shape instead, which is why every API-triggered run "succeeded" while
// silently processing zero queries).
async function fetchLinkedinProfileViaApify(linkedinUrl: string): Promise<Record<string, any> | null> {
  const item = await runApifyActorAndGetFirstItem(APIFY_LINKEDIN_PROFILE_ACTOR, {
    profileScraperMode: "Profile details no email ($4 per 1k)", queries: [linkedinUrl],
  });
  // The dataset item shape at integration time was {element: {...profile},
  // query, status, ...}, but the actor's rewrite to the batch queries[] input
  // (see above) may have changed this too - fall back to treating the item
  // itself as the profile if it looks like one (has fields a profile would).
  const profile = item.element ?? ((item.linkedinUrl || item.publicIdentifier) ? item : null);
  if (!profile) {
    throw new Error(`Apify returned an item with no recognizable profile shape: ${JSON.stringify(item).slice(0, 400)}`);
  }
  return profile;
}

// Takes a batch of LinkedIn company URLs in `companies` - a single-element
// array here, same batch-of-one idea as the person actor's queries[].
async function fetchLinkedinCompanyViaApify(linkedinUrl: string): Promise<Record<string, any> | null> {
  const item = await runApifyActorAndGetFirstItem(APIFY_LINKEDIN_COMPANY_ACTOR, {
    companies: [linkedinUrl],
  });
  // Shape unconfirmed against a live response at integration time (going on
  // the actor's published docs only) - same defensive fallback as the
  // person actor above, in case results also arrive wrapped in {element}.
  const company = item.element ?? ((item.linkedinUrl || item.universalName || item.name) ? item : null);
  if (!company) {
    throw new Error(`Apify returned an item with no recognizable company shape: ${JSON.stringify(item).slice(0, 400)}`);
  }
  return company;
}

// Maps the actor's profile shape onto our li_* columns. Nested sections
// (experience, education, ...) are kept as-is rather than reshaped - they're
// stored as jsonb and there's no need to normalize them for how they're used.
function mapApifyProfileToLiFields(profile: Record<string, any>): Record<string, any> {
  return {
    li_headline: stripPictograms(profile.headline),
    li_about: stripPictograms(profile.about),
    li_photo_url: profile.photo || null,
    li_location_text: profile.location?.linkedinText || null,
    // The sample response at integration time had topSkills as a single
    // "A • B" string, but (consistent with the input-shape rebuild found
    // above) it can also come back as an array - handle both.
    li_top_skills: Array.isArray(profile.topSkills) ? (profile.topSkills.join(", ") || null) : (profile.topSkills || null),
    li_connections_count: typeof profile.connectionsCount === "number" ? profile.connectionsCount : null,
    li_follower_count: typeof profile.followerCount === "number" ? profile.followerCount : null,
    li_open_to_work: typeof profile.openToWork === "boolean" ? profile.openToWork : null,
    li_hiring: typeof profile.hiring === "boolean" ? profile.hiring : null,
    li_verified: typeof profile.verified === "boolean" ? profile.verified : null,
    li_registered_at: profile.registeredAt || null,
    li_current_position: profile.currentPosition?.[0]?.companyName || null,
    li_experience: profile.experience || [],
    li_education: profile.education || [],
    li_certifications: profile.certifications || [],
    li_skills: profile.skills || [],
    li_languages: profile.languages || [],
    li_projects: profile.projects || [],
    li_publications: profile.publications || [],
    li_recommendations: profile.receivedRecommendations || [],
    li_profile_fetched_at: new Date().toISOString(),
  };
}

// Unlike the merge-only-blanks fields elsewhere, li_* fields are always
// overwritten with the fresh result - they only ever come from this one
// source, so there's nothing more-trusted to protect by not overwriting.
// country is the exception: it's a general field other flows also fill, so
// it keeps the usual only-if-blank treatment.
async function enrichPersonFromApify(personId: string) {
  const rows = await supabaseRequest("GET", "people", { params: { id: `eq.${personId}`, select: "linkedin_url,country" } });
  const person = rows?.[0];
  if (!person) throw new HttpError(404, "person not found");
  if (!person.linkedin_url) throw new HttpError(400, "This person has no LinkedIn URL yet.");

  const profile = await fetchLinkedinProfileViaApify(person.linkedin_url);
  if (!profile) throw new HttpError(502, "Apify found no profile data for this LinkedIn URL.");

  const fields = mapApifyProfileToLiFields(profile);
  const countryFromProfile = profile.location?.parsed?.country;
  if (!person.country && countryFromProfile) fields.country = countryFromProfile;
  // Like an org's name (renameOrgIfPossible), LinkedIn's own name is
  // authoritative once matched by URL - always overwritten, not merge-
  // only-blanks. Unlike orgs, full_name has no uniqueness constraint to
  // protect, so no clash check is needed here. Field name unconfirmed
  // against a live response (unlike headline/about/experience, already
  // seen live this session) - checks the couple of shapes a profile-fetch
  // actor plausibly uses.
  const nameFromProfile = stripPictograms(profile.fullName || profile.name || [profile.firstName, profile.lastName].filter(Boolean).join(" "));
  if (nameFromProfile) fields.full_name = nameFromProfile;

  const updated = (await supabaseRequest("PATCH", "people", {
    params: { id: `eq.${personId}` },
    body: fields,
    prefer: "return=representation",
  }))[0];
  await importEducationForPerson(personId, profile.education);
  await importPastEmploymentForPerson(personId, profile.experience);
  await syncCurrentRolesForPerson(personId, profile.experience, profile.currentPosition);
  return updated;
}

// A live response (confirmed against an actual run, unlike the rest of this
// mapping - see below) has no top-level `headquarter` field at all: the HQ
// is just whichever entry of `locations[]` has `headquarter: true` (falling
// back to the first location, then to a same-named top-level field in case
// a future actor version does add one back).
function extractHeadquarter(company: Record<string, any>): any {
  const locations = Array.isArray(company.locations) ? company.locations : [];
  return locations.find((l: any) => l?.headquarter) ?? locations[0] ?? company.headquarter ?? null;
}

// employeeCountRange comes back as an object ({start: 10001}, possibly with
// an end too) rather than a ready-made string - formatted here into the
// same kind of text a human would've typed into this field by hand.
function formatEmployeeRange(range: any): string | null {
  if (!range) return null;
  if (typeof range === "string") return range;
  const { start, end } = range;
  if (typeof start === "number" && typeof end === "number") return `${start}-${end}`;
  if (typeof start === "number") return `${start}+`;
  return null;
}

// Maps the company actor's shape onto our organizations li_* columns. Same
// always-overwrite reasoning as mapApifyProfileToLiFields above - these
// columns only ever come from this one source. foundedOn/lastFundingRound
// are kept as their raw nested shape (jsonb) rather than flattened further,
// same "no need to normalize past what's actually rendered" call as
// li_experience/li_education on people. Funding data comes nested under
// fundingData (numFundingRounds, lastFundingRound) rather than as flat
// top-level fields.
function mapApifyCompanyToLiFields(company: Record<string, any>): Record<string, any> {
  const founded = company.foundedOn;
  const foundedYear = typeof founded === "number" ? founded : (typeof founded?.year === "number" ? founded.year : null);
  const funding = company.fundingData ?? {};
  return {
    li_tagline: stripPictograms(company.tagline),
    li_logo_url: company.logo || null,
    // Field name unconfirmed against a live company-scrape response (same
    // caveat as li_headquarter below) - a person's experience entries
    // reference their employer's numeric id as companyId (confirmed live),
    // so that's tried first; id is the fallback guess for the company
    // actor's own shape.
    li_company_id: (company.companyId || company.id) ? String(company.companyId || company.id) : null,
    li_universal_name: company.universalName || null,
    li_company_type: company.companyType || null,
    li_phone: company.phone || null,
    li_employee_count: typeof company.employeeCount === "number" ? company.employeeCount : null,
    li_employee_count_range: formatEmployeeRange(company.employeeCountRange),
    li_follower_count: typeof company.followerCount === "number" ? company.followerCount : null,
    li_founded_year: foundedYear,
    // Published docs say "specialities" (Apify's own spelling); LinkedIn's
    // API itself has used "specialties" historically - accept either.
    li_specialities: Array.isArray(company.specialities) ? company.specialities : (Array.isArray(company.specialties) ? company.specialties : []),
    li_industries: company.industries || [],
    li_locations: company.locations || [],
    li_headquarter: extractHeadquarter(company),
    li_funding_rounds_count: typeof funding.numFundingRounds === "number" ? funding.numFundingRounds : null,
    li_last_funding_round: funding.lastFundingRound || null,
    li_active: typeof company.active === "boolean" ? company.active : null,
    li_page_verified: typeof company.pageVerified === "boolean" ? company.pageVerified : null,
    li_profile_fetched_at: new Date().toISOString(),
  };
}

// Best-effort "City, Country" text out of a locations[] entry (same shape
// as li_headquarter above) - mirrors profile.location?.parsed?.country's
// role for people (see enrichPersonFromApify): fills org.hq_country, but
// only if currently blank. Prefers parsed.text ("Paris, France") over just
// the country, matching how hq_country is already written everywhere else
// in this app (research, hand-editing) - a bare country name is the fallback,
// not the norm.
function hqLocationText(headquarter: any): string | null {
  if (!headquarter) return null;
  if (typeof headquarter === "string") return headquarter;
  return headquarter.parsed?.text || headquarter.parsed?.country || headquarter.country || null;
}

// Unlike people's enrich-from-apify, the general (non-li_*) fields this also
// touches - website_url, hq_country, description - stay merge-only-blanks:
// they're shared fields other flows (research, hand-editing) already own,
// same as country does for people. `name` is the deliberate exception the
// org detail pane's Enrich button doesn't have: LinkedIn's own company name
// is authoritative here, so it's renamed to match - unless that name is
// already taken by a different org, in which case the rename is skipped
// (surfaced via name_clash) but every li_* field still saves.
// Shared by enrichOrgFromApify and findOrgLinkedin: a candidate name found
// from LinkedIn is authoritative once we've matched this org by its
// LinkedIn URL, so rename to it - unless that name already belongs to a
// different existing org, in which case the rename is skipped (surfaced as
// name_clash, so the caller doesn't just fail the whole operation over a
// same-name duplicate) but everything else the caller found still saves.
async function renameOrgIfPossible(orgId: string, currentName: string, candidateName: string | null | undefined): Promise<{ name?: string; name_clash: string | null }> {
  const newName = stripPictograms(candidateName) || "";
  if (!newName || newName.toLowerCase() === currentName.toLowerCase()) return { name_clash: null };
  const clash = await supabaseRequest("GET", "organizations", {
    params: { name: `ilike.${orValue(newName)}`, id: `neq.${orgId}`, select: "id", limit: "1" },
  });
  return clash?.length ? { name_clash: newName } : { name: newName, name_clash: null };
}

// Shared by enrichOrgFromApify (given a known org.linkedin_url) and
// findOrgLinkedinByCompanyId below (given only org.li_company_id, resolving
// linkedin_url for the first time via the same company actor) - applies a
// fetched Apify company profile onto the org: the full li_* mapping, the
// same blank-fill fields (website_url/hq_country/description) and rename
// logic either caller needs. extraFields lets the company-id path also set
// linkedin_url itself, which mapApifyCompanyToLiFields never touches (in
// the normal enrich flow linkedin_url is the input, not an output).
async function applyApifyCompanyData(
  orgId: string,
  org: { name: string; website_url?: string | null; hq_country?: string | null; description?: string | null },
  company: Record<string, any>,
  extraFields: Record<string, any> = {},
) {
  const fields: Record<string, any> = { ...mapApifyCompanyToLiFields(company), ...extraFields };
  if (!org.website_url && company.website) fields.website_url = company.website;
  // hq_country is only ever "null" (the literal string, not blank) on rows a
  // past import already broke - real garbage, not a value worth protecting,
  // so it's treated the same as actually blank here.
  const hqCountry = hqLocationText(fields.li_headquarter);
  if ((!org.hq_country || org.hq_country === "null") && hqCountry) fields.hq_country = hqCountry;
  if (!org.description && company.description) fields.description = company.description;

  const rename = await renameOrgIfPossible(orgId, org.name, company.name);
  if (rename.name) fields.name = rename.name;

  const updated = (await supabaseRequest("PATCH", "organizations", {
    params: { id: `eq.${orgId}` },
    body: fields,
    prefer: "return=representation",
  }))[0];
  return { updated, rename };
}

async function enrichOrgFromApify(orgId: string) {
  const rows = await supabaseRequest("GET", "organizations", {
    params: { id: `eq.${orgId}`, select: "name,linkedin_url,website_url,hq_country,description" },
  });
  const org = rows?.[0];
  if (!org) throw new HttpError(404, "organization not found");
  if (!org.linkedin_url) throw new HttpError(400, "This organization has no LinkedIn URL yet.");

  const company = await fetchLinkedinCompanyViaApify(org.linkedin_url);
  if (!company) throw new HttpError(502, "Apify found no company data for this LinkedIn URL.");

  const { updated, rename } = await applyApifyCompanyData(orgId, org, company);
  return { ...updated, name_clash: rename.name_clash };
}

// Tried first, before the LLM name search below, whenever we already know
// this org's numeric LinkedIn company id (li_company_id - captured from a
// person's own experience history, or a previous run of this exact path -
// see migration_027/backfillOrgCompanyId). Resolving it through the Apify
// company actor - fed https://www.linkedin.com/company/<id> instead of a
// name - has no name-collision risk at all (the id IS the company, not a
// guess), unlike search-based matching. A raw unauthenticated fetch of that
// URL doesn't work for this (confirmed directly: LinkedIn 302s an anonymous
// request to a login wall instead of following through to the real page) -
// Apify's actor runs through its own session/proxy and isn't affected.
// Since a successful call returns the company's full profile, this also
// fully enriches the org in the same request via applyApifyCompanyData -
// the normal Enrich step then has nothing left to do (li_profile_fetched_at
// is already set). Returns null (never throws) on any failure - a stale id,
// a deleted/merged page, an Apify error - so the caller falls back to the
// LLM search rather than failing the whole find-linkedin request over a
// shortcut that just didn't pan out.
async function findOrgLinkedinByCompanyId(
  orgId: string,
  org: { name: string; website_url?: string | null; hq_country?: string | null; description?: string | null; li_company_id?: string | null },
) {
  if (!org.li_company_id) return null;
  let company: Record<string, any> | null;
  try {
    company = await fetchLinkedinCompanyViaApify(`https://www.linkedin.com/company/${org.li_company_id}`);
  } catch {
    return null;
  }
  if (!company) return null;
  const resolvedUrl = normalizeLinkedinUrl(
    company.linkedinUrl || (company.universalName ? `https://www.linkedin.com/company/${company.universalName}` : null),
  );
  if (!resolvedUrl) return null;

  const { updated, rename } = await applyApifyCompanyData(orgId, org, company, { linkedin_url: resolvedUrl });

  const clash = await supabaseRequest("GET", "organizations", {
    params: { linkedin_url: `eq.${resolvedUrl}`, id: `neq.${orgId}`, select: "id,name", limit: "1" },
  });
  return {
    linkedin_url: updated.linkedin_url, name: updated.name, org_type: updated.org_type,
    sectors: updated.sectors, hq_country: updated.hq_country,
    duplicate_of: clash?.[0] ? { id: clash[0].id, name: clash[0].name } : null,
    name_clash: rename.name_clash, candidates: [],
  };
}

// ---------- Schools / education (normalized from profile.education) ----------

async function findOrCreateSchool(name: string, linkedinUrl: string | null) {
  const orParts = [`name.ilike.${orValue(name)}`];
  if (linkedinUrl) orParts.push(`linkedin_url.eq.${orValue(linkedinUrl)}`);
  const existing = await supabaseRequest("GET", "schools", { params: { or: `(${orParts.join(",")})`, select: "*", limit: "1" } });
  if (existing?.[0]) {
    if (linkedinUrl && !existing[0].linkedin_url) {
      const patched = await supabaseRequest("PATCH", "schools", {
        params: { id: `eq.${existing[0].id}` },
        body: { linkedin_url: linkedinUrl },
        prefer: "return=representation",
      });
      return patched[0];
    }
    return existing[0];
  }
  const created = await supabaseRequest("POST", "schools", { body: { name, linkedin_url: linkedinUrl }, prefer: "return=representation" });
  return created[0];
}

// Matches on (person, school, degree) in application code rather than a DB
// unique constraint - degree can be null, and NULL never equals NULL in a
// unique index, so a constraint alone wouldn't stop duplicates piling up
// across repeated fetches of the same profile.
async function upsertEducationEntry(
  personId: string, schoolId: string, degree: string | null, period: string | null,
  startDate: string | null, endDate: string | null,
) {
  const existingRows = await supabaseRequest("GET", "education", {
    params: { person_id: `eq.${personId}`, school_id: `eq.${schoolId}`, select: "id,degree" },
  });
  const match = (existingRows ?? []).find((r: any) => (r.degree || null) === (degree || null));
  const fields = { degree, period, start_date: startDate, end_date: endDate };
  if (match) {
    await supabaseRequest("PATCH", "education", { params: { id: `eq.${match.id}` }, body: fields });
  } else {
    await supabaseRequest("POST", "education", { body: { person_id: personId, school_id: schoolId, ...fields } });
  }
}

// A live response's institution name/link land on schoolName/
// schoolLinkedinUrl (confirmed directly against real data - a person's
// li_education, e.g. {schoolName: "University of Oxford", schoolLinkedinUrl:
// "https://www.linkedin.com/company/4477/", ...}), not title/link as this
// originally assumed - which meant `name` was always "", so this whole
// function was a silent no-op for every person, forever: schools/education
// stayed empty tables despite li_education having the data all along. title/
// link kept as a fallback in case some other Apify actor version uses them.
async function importEducationForPerson(personId: string, educationArr: any[] | undefined) {
  for (const e of educationArr ?? []) {
    const name = (e.schoolName || e.title || "").trim();
    if (!name) continue;  // no institution name to key a school on - stays in the raw li_education JSON only
    const linkedinUrl = normalizeLinkedinUrl(e.schoolLinkedinUrl || e.link || null);
    const school = await findOrCreateSchool(name, linkedinUrl);
    await upsertEducationEntry(personId, school.id, e.degree || null, e.period || null, e.startDate?.text || null, e.endDate?.text || null);
  }
}

async function listPeopleAtSchool(schoolId: string) {
  const rows = await supabaseRequest("GET", "education", {
    params: { school_id: `eq.${schoolId}`, select: "degree,period,people(id,full_name,linkedin_url,country)" },
  });
  return (rows ?? []).map((r: any) => ({ ...r.people, degree: r.degree, period: r.period }));
}

async function listEducationForPerson(personId: string) {
  return await supabaseRequest("GET", "education", {
    params: {
      person_id: `eq.${personId}`,
      select: "id,degree,period,start_date,end_date,schools(id,name,linkedin_url)",
      order: "created_at.asc",
    },
  });
}

// ---------- Past employment (normalized from profile.experience) ----------

// LinkedIn's experience list includes the person's current role too - that's
// already tracked via their normal org membership, so importing it again
// here would create a near-duplicate. Anything still "Present" (no end
// date) is treated as current and skipped.
// Only an explicit "Present" end date means current - a missing endDate is
// ambiguous (most often a past role whose end date just wasn't captured)
// and must NOT be treated as current, or someone with no current role at
// all gets one of their old jobs misclassified as their current one.
function isCurrentExperienceEntry(e: any): boolean {
  return e.endDate?.text === "Present";
}

// A person's LinkedIn experience entry carries their employer's numeric
// LinkedIn id as companyId (confirmed live - e.g. "3054" for Sopra Steria) -
// this is a free byproduct of every person enrichment, not just direct org
// enrichment, so it's worth capturing every time it shows up regardless of
// whether the org itself has ever been Apify-enriched. Merge-only-blanks: a
// direct company-scrape's own li_company_id (mapApifyCompanyToLiFields) is
// the more authoritative source and is never overwritten by this.
async function backfillOrgCompanyId(org: { id: string; li_company_id?: string | null }, companyId: unknown) {
  if (org.li_company_id || !companyId) return;
  await supabaseRequest("PATCH", "organizations", { params: { id: `eq.${org.id}` }, body: { li_company_id: String(companyId) } });
  org.li_company_id = String(companyId);
}

async function importPastEmploymentForPerson(personId: string, experienceArr: any[] | undefined) {
  for (const e of experienceArr ?? []) {
    if (isCurrentExperienceEntry(e)) continue;
    const name = stripPictograms(e.companyName);
    if (!name) continue;
    const linkedinUrl = normalizeLinkedinUrl(e.companyLinkedinUrl || null);
    // Checked regardless of type: if this company is already a real vc/cvc/
    // angel/family_office/group org, link to that instead of creating an
    // "employer" duplicate of an org this tool already actually cares about.
    let org = await findExistingOrganization(name, null, linkedinUrl);
    if (!org) {
      org = (await supabaseRequest("POST", "organizations", { body: { name, org_type: "employer" }, prefer: "return=representation" }))[0];
    }
    await backfillOrgCompanyId(org, e.companyId);
    const title = stripPictograms(e.position);
    const existingMemberships = await supabaseRequest("GET", "memberships", {
      params: {
        person_id: `eq.${personId}`, organization_id: `eq.${org.id}`,
        title: title ? `eq.${orValue(title)}` : "is.null",
        select: "id",
      },
    });
    const fields = { start_date: e.startDate?.text || null, end_date: e.endDate?.text || null, employment_type: e.employmentType || null };
    if (existingMemberships?.[0]) {
      await supabaseRequest("PATCH", "memberships", { params: { id: `eq.${existingMemberships[0].id}` }, body: fields });
    } else {
      await supabaseRequest("POST", "memberships", {
        body: { person_id: personId, organization_id: org.id, title, is_current: false, ...fields },
      });
    }
  }
}

// LinkedIn's stated current role(s)/company(ies) are treated as authoritative
// for this person's current membership(s) - always synced, not merge-only-
// blanks like most enrichment here, per explicit instruction that this
// should always match what LinkedIn says. Someone can have more than one
// concurrent current role (e.g. partner at a fund and an advisor/board seat
// elsewhere), so every entry isCurrentExperienceEntry accepts gets synced as
// its own is_current membership, not just the first - only a membership at
// an org that LinkedIn's current-role data no longer backs up gets closed
// out. Falls back to profile.currentPosition (company name only, no title)
// if experience has nothing marked current.
async function syncCurrentRolesForPerson(personId: string, experienceArr: any[] | undefined, currentPositionArr: any[] | undefined) {
  // __order is this entry's position in LinkedIn's own profile.experience
  // array (captured before filtering to current-only) - "shown at the top
  // of the profile" is itself a real signal of which current role is
  // primary, and one that's there even when employmentType isn't (LinkedIn
  // often leaves it blank for an owner-operated side venture, not just for
  // a genuine second job - employmentType alone left ties unresolved).
  const currentEntries = (experienceArr ?? [])
    .map((e: any, i: number) => ({ ...e, __order: i }))
    .filter(isCurrentExperienceEntry);
  const sources = currentEntries.length
    ? currentEntries
    : (currentPositionArr ?? []).map((p: any, i: number) => ({ companyName: p.companyName, companyLinkedinUrl: p.companyLinkedinUrl, companyId: p.companyId, position: null, __order: i }));

  const syncedOrgIds = new Set<string>();
  for (const entry of sources) {
    const companyName = stripPictograms(entry.companyName);
    if (!companyName) continue;
    const linkedinUrl = normalizeLinkedinUrl(entry.companyLinkedinUrl || null);
    // Unlike importPastEmploymentForPerson, a brand-new org discovered here
    // is left with org_type blank rather than tagged "employer" - a tracked
    // investor's *current* company is likely relevant to this tool, not
    // incidental career history to hide, but its actual type shouldn't be
    // guessed either; it's left for a human to classify via the edit form.
    let org = await findExistingOrganization(companyName, null, linkedinUrl);
    if (!org) {
      org = (await supabaseRequest("POST", "organizations", { body: { name: companyName, org_type: null }, prefer: "return=representation" }))[0];
    }
    await backfillOrgCompanyId(org, entry.companyId);
    syncedOrgIds.add(org.id);
    const title = stripPictograms(entry.position);
    // employmentType (e.g. "Permanent" vs "Freelance"/"Volunteer") is what
    // listEmploymentHistoryForPerson's ranking uses to tell a real primary
    // job apart from a side/advisory/committee seat when someone has more
    // than one role marked current - both equally "current" by LinkedIn's
    // own definition, but not equally their main role.
    const employmentType = entry.employmentType || null;
    const experienceOrder = typeof entry.__order === "number" ? entry.__order : null;
    // A person can hold more than one existing membership at the very same
    // org already (e.g. one created from a LinkedIn-headline-parse import
    // with their title as of that snapshot, before a later full profile
    // fetch found a different/updated title for the same job) - fetching
    // all of them, not just the first, and closing out every one but the
    // row this sync actually updates, is what stops that turning into a
    // stray "ex" duplicate sitting alongside the real current row forever.
    // A person can't be simultaneously current under two different titles
    // at the same employer, unlike across different orgs (handled by
    // syncedOrgIds below).
    const existingMemberships = await supabaseRequest("GET", "memberships", {
      params: { person_id: `eq.${personId}`, organization_id: `eq.${org.id}`, select: "id,title,start_date,end_date" },
    });
    const rows = existingMemberships ?? [];
    // Only a row with no dates is eligible to be reused as "the same
    // ongoing relationship, just under a fresher title" - this function
    // never sets start_date/end_date (only importPastEmploymentForPerson
    // does), so a row that already has one is a genuine, separate past
    // stint (a real title/date range LinkedIn reported), not a stale
    // duplicate of *this* current entry. Reusing it would silently rewrite
    // real history - confirmed happening for a person with two Truffle
    // Capital stints, where the current-role sync grabbed the past
    // "Relations Investisseurs" (2015-2017) row and renamed it to their
    // actual current title, leaving a row that claimed to be both current
    // and ended in 2017 at once.
    const reusable = rows.filter((r: any) => !r.start_date && !r.end_date);
    const primary = reusable.find((r: any) => (r.title || null) === title) ?? reusable[0];
    let primaryId: string;
    if (primary) {
      await supabaseRequest("PATCH", "memberships", {
        params: { id: `eq.${primary.id}` },
        body: { title, is_current: true, employment_type: employmentType, experience_order: experienceOrder },
      });
      primaryId = primary.id;
    } else {
      const created = (await supabaseRequest("POST", "memberships", {
        body: { person_id: personId, organization_id: org.id, title, is_current: true, employment_type: employmentType, experience_order: experienceOrder },
        prefer: "return=representation",
      }))[0];
      primaryId = created.id;
    }
    for (const r of rows) {
      if (r.id !== primaryId) {
        await supabaseRequest("PATCH", "memberships", { params: { id: `eq.${r.id}` }, body: { is_current: false } });
      }
    }
  }

  // Distinguishes "LinkedIn clearly shows no current role" from "we got no
  // usable data at all" (a technical hiccup shouldn't wipe known-good data):
  // real, non-empty experience/currentPosition data with nothing synced
  // means genuinely no current role, so fall through and close out
  // whatever's still marked current below. Only bail out here if both were
  // empty/missing entirely.
  const hadUsableData = (experienceArr?.length ?? 0) > 0 || (currentPositionArr?.length ?? 0) > 0;
  if (!syncedOrgIds.size && !hadUsableData) return;

  const stillCurrent = await supabaseRequest("GET", "memberships", {
    params: { person_id: `eq.${personId}`, is_current: "eq.true", select: "id,organization_id" },
  });
  for (const m of stillCurrent ?? []) {
    if (!syncedOrgIds.has(m.organization_id)) {
      await supabaseRequest("PATCH", "memberships", { params: { id: `eq.${m.id}` }, body: { is_current: false } });
    }
  }
}

async function listEmploymentHistoryForPerson(personId: string) {
  return await supabaseRequest("GET", "memberships", {
    params: {
      person_id: `eq.${personId}`,
      select: "id,title,focus,is_current,start_date,end_date,employment_type,experience_order,organizations(id,name,org_type)",
      order: "is_current.desc",
    },
  });
}

// Research doesn't always surface where a firm invests (as opposed to where
// it's headquartered) - a plausible default for a firm with no stated
// investment region is that it invests where it's based. Run after Apollo
// backfill so a hq_country Apollo just filled in still counts.
function applyInvestmentRegionFallback(org: Record<string, any>) {
  if ((!org.investment_regions || org.investment_regions.length === 0) && org.hq_country) {
    org.investment_regions = [org.hq_country];
  }
}

// ---------- OpenRouter ----------

// Single bounded attempt, deliberately no internal retry by default: Supabase
// enforces a 150s wall-clock limit per request (both plans) and this call
// already competes with Apollo backfill + several Supabase writes for that
// budget - retrying in-process risks blowing past it and getting killed
// mid-response (a raw platform timeout, not our clean JSON error - which is
// worse, not better). Retries belong at the caller, as a fresh request with
// its own fresh 150s budget - see apiWithRetry on the frontend.
// The one exception is findPersonLinkedin's own name-order-swap retry, which
// passes a shorter timeoutMs specifically so two sequential calls still fit
// safely inside the 150s budget - see there for why that one case is worth it.
async function openRouterCall(userContent: string, schemaName: string, jsonSchema: any, timeoutMs = 45000): Promise<any> {
  if (!OPENROUTER_API_KEY) throw new HttpError(503, "OPENROUTER_API_KEY is not configured.");

  let res: Response;
  try {
    res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://patrlord.github.io/graph/",
        "X-Title": "Graph",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{ role: "user", content: userContent }],
        plugins: [{ id: "web", engine: "native", max_results: 10 }],
        response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema: jsonSchema } },
      }),
    }, timeoutMs);
  } catch (err) {
    throw new Error(`OpenRouter request timed out or failed (network error): ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`OpenRouter request failed (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenRouter returned no content.");
  return JSON.parse(content);
}

const NEVER_GUESS = "Never invent, guess, or construct a URL, name, or fact you didn't actually find via search - use null for anything you can't confirm.";

// Single source of truth for org_type: [slug, description for the AI
// classification prompt]. "employer" is deliberately excluded from this
// list - it's reserved for the passive past-employer auto-creation path
// (enrichPersonFromApify/importPastEmploymentForPerson), not something
// active research should assign. The DB check constraint (migration_012),
// the PATCH /organizations/:id validation list below, and the frontend's
// ORG_TYPE_LABEL must all stay in sync with this - there's no shared module
// between backend and frontend to enforce that automatically.
const ORG_TYPES: [string, string][] = [
  ["vc", "an independent venture capital firm"],
  ["cvc", "a corporate venture capital arm (invests from a corporation's balance sheet/strategic fund)"],
  ["angel", "an individual business angel / angel investor"],
  ["angel_network", "a network or syndicate of angel investors organized as a group"],
  ["family_office", "a family office or private wealth investment vehicle"],
  ["investment_syndicate", "an ad hoc or platform-based syndicate that pools capital for specific deals"],
  ["pe", "a private equity firm"],
  ["asset_manager", "an asset management firm (not specifically VC/PE)"],
  ["investment_bank", "an investment bank"],
  ["bank", "a retail or commercial bank"],
  ["insurer", "an insurance company"],
  ["startup", "an early-stage operating company - not an investor"],
  ["enterprise", "a large, established operating company/corporation - not an investor"],
  ["incubator_accelerator", "an incubator or accelerator program"],
  ["university", "a university or academic institution"],
  ["association", "a trade association, industry body, or non-profit membership organization"],
  ["legal", "a law firm or legal services provider"],
  ["consulting", "a management/strategy consulting firm"],
  ["audit_accounting", "an audit or accounting firm"],
  ["media_agency", "a media, PR, or marketing agency"],
  ["exec_search", "an executive search / headhunting firm"],
  ["interim_agency", "an interim-management staffing agency"],
  ["secondary", "a firm that buys/sells existing stakes in private funds or companies (secondaries investing)"],
  ["group", "none of the above fit well, but it's a real organization worth tracking"],
];
const ORG_TYPE_SLUGS = ORG_TYPES.map(([slug]) => slug);
// "employer" is a valid stored value (see above) even though research can't pick it.
const ALL_ORG_TYPE_SLUGS = [...ORG_TYPE_SLUGS, "employer"];

const ORG_TYPE_INSTRUCTIONS = `Classify the organization's type as exactly one of:
${ORG_TYPES.map(([slug, desc]) => `- "${slug}": ${desc}`).join("\n")}
If you can't tell which of these fits, leave org_type null rather than guessing.`;

// Only applies to organizations that actually invest capital - conditioned
// in the prompt itself (see researchOrganization/researchPerson) so a
// University or law firm doesn't get asked for a ticket size.
const INVESTOR_PROFILE_INSTRUCTIONS = `- Typical investment ticket size / check size it writes (e.g. "$250K-1M"), only if stated somewhere
- Investment stage(s) it invests at (e.g. "Pre-seed", "Seed", "Series A", "Growth")
- Geographic region(s) it focuses its investing in (e.g. "US", "Europe", "Global") - this is about where it invests, not where it's headquartered, though for a firm that only invests locally these are often the same
- A short, more specific fund-type label than the org_type classification above, if one applies (e.g. "Corporate VC", "Family Office", "Accelerator", "Venture Studio", "Fund of Funds") - otherwise leave null`;

const RESEARCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    organization: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        org_type: { type: ["string", "null"], enum: [...ORG_TYPE_SLUGS, null] },
        website_url: { type: ["string", "null"] },
        linkedin_url: { type: ["string", "null"] },
        hq_country: { type: ["string", "null"] },
        description: { type: ["string", "null"] },
        sectors: { type: "array", items: { type: "string" } },
        ticket_size: { type: ["string", "null"] },
        investment_stages: { type: "array", items: { type: "string" } },
        investment_regions: { type: "array", items: { type: "string" } },
        fund_type_raw: { type: ["string", "null"] },
      },
      required: [
        "name", "org_type", "website_url", "linkedin_url", "hq_country", "description", "sectors",
        "ticket_size", "investment_stages", "investment_regions", "fund_type_raw",
      ],
      additionalProperties: false,
    },
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          full_name: { type: "string" },
          title: { type: ["string", "null"] },
          focus: { type: ["string", "null"] },
          country: { type: ["string", "null"] },
          linkedin_url: { type: ["string", "null"] },
        },
        required: ["full_name", "title", "focus", "country", "linkedin_url"],
        additionalProperties: false,
      },
    },
  },
  required: ["organization", "people"],
  additionalProperties: false,
};

async function researchOrganization(name: string, linkedinUrl: string) {
  if (!name && !linkedinUrl) throw new HttpError(400, "name or linkedin_url is required");
  const who = name ? `"${name}"` : `the organization at this LinkedIn company page: ${linkedinUrl}`;
  const establishedSectorTags = await getEstablishedSectorTags();
  const prompt = `Search for and find information about ${who}: its official website, LinkedIn company page, key people, and what it does.

Report:
- Its name
- ${ORG_TYPE_INSTRUCTIONS}
- Official website URL and LinkedIn company page URL, only if confirmed
- Where it's headquartered (city and country)
- A one-sentence description
- ${sectorTagInstructions(establishedSectorTags)}
- If it's an investing organization (VC, CVC, PE, angel network, family office, investment syndicate, or similar), also report:
${INVESTOR_PROFILE_INSTRUCTIONS}
- Its current key people - leadership, partners, or other senior roles relevant to what it does (skip admin/ops staff). For each: full name, title, sector/focus if stated, country they're based in, and personal LinkedIn URL if confirmed.

If you cannot confidently identify it, leave "name" and other fields null rather than guessing (still pick a best-guess org_type if the search results make it reasonably clear, leave it null otherwise).

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "firm_research", RESEARCH_JSON_SCHEMA);
  data.organization = data.organization || {};
  data.people = data.people || [];
  if (data.organization.name) await backfillFromApollo(data.organization);
  applyInvestmentRegionFallback(data.organization);
  return data;
}

async function researchPerson(name: string, companyHint: string, linkedinUrl: string) {
  if (!name && !linkedinUrl) throw new HttpError(400, "name or linkedin_url is required");
  const who = name
    ? `"${name}"${companyHint ? `, who may work at "${companyHint}"` : ""}`
    : `the person at this LinkedIn URL: ${linkedinUrl}`;
  const establishedSectorTags = await getEstablishedSectorTags();
  const prompt = `Search for and identify ${who}, and the organization they currently work at.

Report:
- Their full name, current title, sector/focus if stated, and the country they're based in
- Their confirmed personal LinkedIn URL
- The organization they currently work at: its name, ${ORG_TYPE_INSTRUCTIONS}, official website, LinkedIn company page, headquarters (city and country), a one-sentence description, and ${sectorTagInstructions(establishedSectorTags)}. If it's an investing organization (VC, CVC, PE, angel network, family office, investment syndicate, or similar), also report:
${INVESTOR_PROFILE_INSTRUCTIONS}

If you cannot confidently identify this person or their current organization, leave the relevant fields null rather than guessing. Return exactly one entry in "people" (or none if you can't confirm anyone).

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "person_research", RESEARCH_JSON_SCHEMA);
  data.organization = data.organization || {};
  data.people = (data.people || []).slice(0, 1);
  if (data.organization.name) await backfillFromApollo(data.organization);
  applyInvestmentRegionFallback(data.organization);
  return data;
}

const NEWS_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          source: { type: ["string", "null"] },
          published_at: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
        },
        required: ["title", "url", "source", "published_at", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

async function searchAndSaveNews(entityType: string, entityId: string, name: string, orgContext?: string) {
  const prompt = `Search for recent news about "${name}"${orgContext ? ` at ${orgContext}` : ""} - funding announcements, new roles or hires, notable coverage, or other newsworthy mentions from roughly the last year.

For each distinct item found (up to 8), report: title, url, source/publication name, published date if known (else null), and a one-sentence summary. Only include real articles/pages you actually found via search - never invent one.

The title and summary must be plain prose only - no markdown links, citation brackets, or bracketed references like "[source](url)" anywhere in either field. Put the URL only in the "url" field.`;

  const data = await openRouterCall(prompt, "news_search", NEWS_JSON_SCHEMA);
  const items = (data.items || []).filter((i: any) => i.title && i.url);
  if (items.length) {
    const rows = items.map((i: any) => ({
      entity_type: entityType,
      entity_id: entityId,
      title: i.title,
      url: i.url,
      source: i.source || null,
      published_at: i.published_at || null,
      summary: i.summary || null,
    }));
    await supabaseRequest("POST", "news_items", {
      body: rows,
      params: { on_conflict: "entity_type,entity_id,url" },
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  return await listNews(entityType, entityId);
}

async function listNews(entityType: string, entityId: string) {
  return await supabaseRequest("GET", "news_items", {
    params: {
      entity_type: `eq.${entityType}`,
      entity_id: `eq.${entityId}`,
      select: "*",
      order: "found_at.desc",
    },
  });
}

const FIND_PERSON_LINKEDIN_SCHEMA = {
  type: "object",
  properties: {
    linkedin_url: { type: ["string", "null"] },
    observed_title: { type: ["string", "null"] },
    observed_company: { type: ["string", "null"] },
  },
  required: ["linkedin_url", "observed_title", "observed_company"],
  additionalProperties: false,
};

const PERSON_FROM_LINKEDIN_SCHEMA = {
  type: "object",
  properties: {
    observed_title: { type: ["string", "null"] },
    observed_company: { type: ["string", "null"] },
    observed_country: { type: ["string", "null"] },
  },
  required: ["observed_title", "observed_company", "observed_country"],
  additionalProperties: false,
};

const FIND_ORG_LINKEDIN_SCHEMA = {
  type: "object",
  properties: {
    linkedin_url: { type: ["string", "null"] },
    observed_name: { type: ["string", "null"] },
    observed_org_type: { type: ["string", "null"], enum: [...ORG_TYPE_SLUGS, null] },
    observed_industry: { type: ["string", "null"] },
    observed_hq: { type: ["string", "null"] },
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          linkedin_url: { type: "string" },
          observed_name: { type: ["string", "null"] },
          observed_org_type: { type: ["string", "null"], enum: [...ORG_TYPE_SLUGS, null] },
          observed_industry: { type: ["string", "null"] },
          observed_hq: { type: ["string", "null"] },
        },
        required: ["linkedin_url", "observed_name", "observed_org_type", "observed_industry", "observed_hq"],
        additionalProperties: false,
      },
    },
  },
  required: ["linkedin_url", "observed_name", "observed_org_type", "observed_industry", "observed_hq", "candidates"],
  additionalProperties: false,
};

// Pure search+verify step, no DB writes - shared by the initial attempt and
// the name-order-swapped retry below. Google-style search for "linkedin
// <name>, <title>, <company>", then checks the resulting linkedin.com/in/
// candidates one at a time (in the order the search ranked them) and stops
// at the first one that's actually verifiable as this person from what the
// search result says about them - rather than returning the top hit
// unconditionally.
async function searchPersonLinkedinCandidate(name: string, title: string, company: string, timeoutMs: number) {
  const who = [name, title, company].filter(Boolean).join(", ");
  const prompt = `Search for: linkedin ${who}

This is a person named "${name}"${title ? `, whose role is "${title}"` : ""}${company ? ` at "${company}"` : ""}. Find their personal LinkedIn profile.

From the search results, identify up to 3 candidate linkedin.com/in/... profile URLs that could belong to this specific person. Check them one at a time, in the order the search ranked them: for each, look at what the result's title/snippet says about that profile (name, job title, employer) and judge whether it genuinely matches this person - the name should match, and the role/employer should at least plausibly match. Stop at the first candidate you can confidently verify this way and return its URL.

If you verify a match, also report their current job title and current employer exactly as stated in that same search result/snippet (null for either if not stated there - don't guess).

If none of the candidates confidently match, return null for everything - never guess, and never return an unverified best-guess URL.

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "find_person_linkedin", FIND_PERSON_LINKEDIN_SCHEMA, timeoutMs);
  return {
    linkedin_url: normalizeLinkedinUrl(data.linkedin_url),
    observed_title: data.observed_title || null,
    observed_company: data.observed_company || null,
  };
}

// Saves the URL, and - only where blank, never overwriting - the title on
// their membership at organizationId, straight from what the same verified
// result stated.
//
// Some source lists give names surname-first ("Doe John"). If the name as
// given finds nothing, retries once with the word order reversed; if that
// verifies a real match, the reversed order is treated as this person's
// correct name. If that corrected name (or the LinkedIn URL itself) turns
// out to already belong to a different person row - the same real person
// recorded twice, e.g. once correctly elsewhere and once here misordered -
// merges into that existing record via mergePersonInto instead of renaming
// this one into a duplicate.
//
// This is the one place that makes two sequential OpenRouter calls (see the
// comment on openRouterCall), so each gets a shorter 25s timeout rather than
// the usual 45s default - worst case both attempts run the full duration,
// ~50s total, comfortably inside the 150s platform limit. Either attempt
// timing out or otherwise erroring is treated as "found nothing" rather than
// left to propagate - a slow miss should end as "Not found", not a crash.
async function findPersonLinkedin(
  personId: string, name: string, title: string, company: string, organizationId: string,
) {
  const PERSON_SEARCH_TIMEOUT_MS = 25000;
  let result;
  try {
    result = await searchPersonLinkedinCandidate(name, title, company, PERSON_SEARCH_TIMEOUT_MS);
  } catch {
    result = { linkedin_url: null, observed_title: null, observed_company: null };
  }
  let renamedTo: string | null = null;

  if (!result.linkedin_url) {
    const tokens = name.trim().split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      const swapped = [...tokens].reverse().join(" ");
      try {
        const swappedResult = await searchPersonLinkedinCandidate(swapped, title, company, PERSON_SEARCH_TIMEOUT_MS);
        if (swappedResult.linkedin_url) {
          result = swappedResult;
          renamedTo = swapped;
        }
      } catch {
        // best-effort retry - if it also fails, fall through to "not found" below
      }
    }
  }

  if (!result.linkedin_url) {
    return { linkedin_url: null, title: null, observed_company: null, renamed_to: null, merged_into_person_id: null };
  }
  const linkedinUrl = result.linkedin_url;

  if (renamedTo) {
    const candidates = await findPeopleByNameOrLinkedin(renamedTo, linkedinUrl);
    const other = candidates.find((c: any) => c.id !== personId);
    if (other) {
      await mergePersonInto(personId, other.id, organizationId, linkedinUrl, result.observed_title || title || null);
      return {
        linkedin_url: linkedinUrl, title: result.observed_title || null, observed_company: result.observed_company,
        renamed_to: renamedTo, merged_into_person_id: other.id,
      };
    }
  }

  const patchBody: Record<string, any> = { linkedin_url: linkedinUrl };
  if (renamedTo) patchBody.full_name = renamedTo;
  await supabaseRequest("PATCH", "people", { params: { id: `eq.${personId}` }, body: patchBody });

  let updatedTitle: string | null = null;
  if (result.observed_title && organizationId) {
    const memberships = await supabaseRequest("GET", "memberships", {
      params: { person_id: `eq.${personId}`, organization_id: `eq.${organizationId}`, select: "id,title" },
    });
    const membership = memberships?.[0];
    if (membership && !membership.title) {
      const patched = await supabaseRequest("PATCH", "memberships", {
        params: { id: `eq.${membership.id}` },
        body: { title: result.observed_title },
        prefer: "return=representation",
      });
      updatedTitle = patched[0].title;
    }
  }
  return {
    linkedin_url: linkedinUrl, title: updatedTitle, observed_company: result.observed_company || null,
    renamed_to: renamedTo, merged_into_person_id: null,
  };
}

// personId turned out to be the same real person as targetId (discovered via
// the name-swap retry above matching an existing different row). Carries the
// membership at organizationId over to targetId - same job-change semantics
// as saveOrganization (closes out targetId's other current membership(s) if
// it doesn't already have one here), backfills targetId's LinkedIn URL and
// that membership's title only where blank, then deletes personId - which
// cascades away its own now-redundant membership row(s).
async function mergePersonInto(
  sourceId: string, targetId: string, organizationId: string, linkedinUrl: string, bestTitle: string | null,
) {
  const targetRows = await supabaseRequest("GET", "people", { params: { id: `eq.${targetId}`, select: "linkedin_url" } });
  if (!targetRows?.[0]?.linkedin_url) {
    await supabaseRequest("PATCH", "people", { params: { id: `eq.${targetId}` }, body: { linkedin_url: linkedinUrl } });
  }

  if (organizationId) {
    const targetMemberships = await supabaseRequest("GET", "memberships", {
      params: { person_id: `eq.${targetId}`, organization_id: `eq.${organizationId}`, select: "id,title,is_current" },
    });
    const existing = targetMemberships?.[0];
    if (existing) {
      const patch: Record<string, any> = {};
      if (!existing.title && bestTitle) patch.title = bestTitle;
      if (!existing.is_current) patch.is_current = true;
      if (Object.keys(patch).length) {
        await supabaseRequest("PATCH", "memberships", { params: { id: `eq.${existing.id}` }, body: patch });
      }
    } else {
      const otherCurrent = await supabaseRequest("GET", "memberships", {
        params: { person_id: `eq.${targetId}`, is_current: "eq.true", select: "id" },
      });
      for (const m of otherCurrent ?? []) {
        await supabaseRequest("PATCH", "memberships", { params: { id: `eq.${m.id}` }, body: { is_current: false } });
      }
      await supabaseRequest("POST", "memberships", {
        body: { person_id: targetId, organization_id: organizationId, title: bestTitle, is_current: true },
      });
    }
  }

  await supabaseRequest("DELETE", "people", { params: { id: `eq.${sourceId}` } });
}

// General-purpose person merge for the "Merge into..." button in the person
// detail pane - unlike mergePersonInto above (find-linkedin's own narrow
// dedup, scoped to a single organization's membership), this moves every
// membership across every org, not just one. Same shape as mergeOrgInto:
// dedup memberships by (organization, title) instead of (org has this
// person already), move event_attendees the same way (dedup by event -
// source's event_attendees would otherwise just cascade-delete along with
// source, silently losing which events they attended), remap connections
// with a self-loop guard, backfill every blank field on target from source
// (full_name excluded - target's is the one being kept, same as an org's
// name), then delete source.
async function mergePersonRecordInto(sourceId: string, targetId: string) {
  if (sourceId === targetId) throw new HttpError(400, "Can't merge a person into themselves.");
  const [sourceRows, targetRows] = await Promise.all([
    supabaseRequest("GET", "people", { params: { id: `eq.${sourceId}`, select: "*" } }),
    supabaseRequest("GET", "people", { params: { id: `eq.${targetId}`, select: "*" } }),
  ]);
  const source = sourceRows?.[0];
  const target = targetRows?.[0];
  if (!source) throw new HttpError(404, "source person not found");
  if (!target) throw new HttpError(404, "target person not found");

  const [sourceMemberships, targetMemberships] = await Promise.all([
    supabaseRequest("GET", "memberships", { params: { person_id: `eq.${sourceId}`, select: "id,organization_id,title" } }),
    supabaseRequest("GET", "memberships", { params: { person_id: `eq.${targetId}`, select: "organization_id,title" } }),
  ]);
  const membershipKey = (m: { organization_id: string; title: string | null }) => `${m.organization_id}::${m.title ?? ""}`;
  const targetHasMembership = new Set((targetMemberships ?? []).map(membershipKey));
  for (const m of sourceMemberships ?? []) {
    if (targetHasMembership.has(membershipKey(m))) {
      await supabaseRequest("DELETE", "memberships", { params: { id: `eq.${m.id}` } });
    } else {
      await supabaseRequest("PATCH", "memberships", { params: { id: `eq.${m.id}` }, body: { person_id: targetId } });
    }
  }

  const [sourceEvents, targetEvents] = await Promise.all([
    supabaseRequest("GET", "event_attendees", { params: { person_id: `eq.${sourceId}`, select: "id,event_id" } }),
    supabaseRequest("GET", "event_attendees", { params: { person_id: `eq.${targetId}`, select: "event_id" } }),
  ]);
  const targetHasEvent = new Set((targetEvents ?? []).map((e: any) => e.event_id));
  for (const e of sourceEvents ?? []) {
    if (targetHasEvent.has(e.event_id)) {
      await supabaseRequest("DELETE", "event_attendees", { params: { id: `eq.${e.id}` } });
    } else {
      await supabaseRequest("PATCH", "event_attendees", { params: { id: `eq.${e.id}` }, body: { person_id: targetId } });
    }
  }

  const [asA, asB] = await Promise.all([
    supabaseRequest("GET", "connections", {
      params: { entity_a_type: "eq.person", entity_a_id: `eq.${sourceId}`, select: "id,entity_b_type,entity_b_id" },
    }),
    supabaseRequest("GET", "connections", {
      params: { entity_b_type: "eq.person", entity_b_id: `eq.${sourceId}`, select: "id,entity_a_type,entity_a_id" },
    }),
  ]);
  for (const c of asA ?? []) {
    const wouldSelfLoop = c.entity_b_type === "person" && c.entity_b_id === targetId;
    if (wouldSelfLoop) await supabaseRequest("DELETE", "connections", { params: { id: `eq.${c.id}` } });
    else await supabaseRequest("PATCH", "connections", { params: { id: `eq.${c.id}` }, body: { entity_a_id: targetId } });
  }
  for (const c of asB ?? []) {
    const wouldSelfLoop = c.entity_a_type === "person" && c.entity_a_id === targetId;
    if (wouldSelfLoop) await supabaseRequest("DELETE", "connections", { params: { id: `eq.${c.id}` } });
    else await supabaseRequest("PATCH", "connections", { params: { id: `eq.${c.id}` }, body: { entity_b_id: targetId } });
  }

  const { id: _tid, created_at: _tca, updated_at: _tua, full_name: _tname, ...targetFieldsToFill } = target;
  const fields = mergeFields(source, targetFieldsToFill);
  // Same reasoning as mergeOrgInto's is_starred line - mergeFields never
  // picks up a true from source when target itself is unstarred (false
  // isn't "blank"), silently losing the star. A merge should never end up
  // less starred than either side going in.
  fields.is_starred = source.is_starred || target.is_starred;
  const updated = (await supabaseRequest("PATCH", "people", {
    params: { id: `eq.${targetId}` },
    body: fields,
    prefer: "return=representation",
  }))[0];

  await supabaseRequest("DELETE", "people", { params: { id: `eq.${sourceId}` } });
  return updated;
}

// For when a LinkedIn URL is hand-entered (not found via findPersonLinkedin's
// own search) - the URL is already known and trusted, so this just looks up
// what else that profile says and fills in country/title, only where
// currently blank. Same merge-only-blanks idea as findPersonLinkedin's title
// backfill, just triggered by a save instead of a search.
async function enrichPersonFromLinkedinUrl(personId: string, linkedinUrl: string, name: string, organizationId: string) {
  const prompt = `Search for this LinkedIn profile: ${linkedinUrl}${name ? ` (belongs to "${name}")` : ""}

Report their current job title, current employer/company name, and the country they're based in, exactly as stated on that profile or in search results about it.

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "person_from_linkedin", PERSON_FROM_LINKEDIN_SCHEMA);

  let updatedCountry: string | null = null;
  if (data.observed_country) {
    const rows = await supabaseRequest("GET", "people", { params: { id: `eq.${personId}`, select: "country" } });
    if (!rows?.[0]?.country) {
      const patched = await supabaseRequest("PATCH", "people", {
        params: { id: `eq.${personId}` },
        body: { country: data.observed_country },
        prefer: "return=representation",
      });
      updatedCountry = patched[0].country;
    }
  }

  let updatedTitle: string | null = null;
  if (data.observed_title && organizationId) {
    const memberships = await supabaseRequest("GET", "memberships", {
      params: { person_id: `eq.${personId}`, organization_id: `eq.${organizationId}`, select: "id,title" },
    });
    const membership = memberships?.[0];
    if (membership && !membership.title) {
      const patched = await supabaseRequest("PATCH", "memberships", {
        params: { id: `eq.${membership.id}` },
        body: { title: data.observed_title },
        prefer: "return=representation",
      });
      updatedTitle = patched[0].title;
    }
  }
  return { country: updatedCountry, title: updatedTitle, observed_company: data.observed_company || null };
}

// Short labels for the "what's already on file" summary in findOrgLinkedin's
// prompt - keep in sync with the frontend's ORG_TYPE_LABEL (same slugs, same
// idea, just no shared module to enforce it). Falls back to the raw slug
// for anything not listed, so this can lag ORG_TYPES/ALL_ORG_TYPE_SLUGS
// without breaking - just reads a bit rawer in the prompt.
const FIND_ORG_TYPE_LABEL: Record<string, string> = {
  vc: "VC", cvc: "CVC (corporate VC)", angel: "angel investor", angel_network: "angel network",
  family_office: "family office", investment_syndicate: "investment syndicate", pe: "private equity firm",
  asset_manager: "asset manager", investment_bank: "investment bank", bank: "bank", insurer: "insurer",
  startup: "startup", enterprise: "enterprise", incubator_accelerator: "incubator/accelerator",
  university: "university", association: "association", legal: "law firm", consulting: "consulting firm",
  audit_accounting: "audit/accounting firm", media_agency: "media agency", exec_search: "exec search firm",
  interim_agency: "interim agency", group: "group", employer: "employer",
};

// Same idea as findPersonLinkedin, but for a company's LinkedIn page. Fills
// in sectors (from industry) and hq_country - only where currently blank.
//
// Company names collide often enough that "search for the name, verify
// against the snippet" alone isn't reliable - a completely unrelated
// company (different industry, different country, sometimes a startup that
// just happens to share the name) can look like a fine match from name
// alone. So this also tells the model whatever we already have on file
// about *this* org (type, sectors, ticket size, stage, description) and
// asks it to check the candidate is consistent with that - not just
// name-matching - before treating it as verified. When it finds more than
// one plausible candidate and can't confidently tell which is right even
// with that context, it reports them as `candidates` instead of guessing;
// the frontend then lets a human pick (or reject all of them).
async function findOrgLinkedin(orgId: string, name: string, websiteUrl: string, country: string) {
  const rows = await supabaseRequest("GET", "organizations", {
    params: {
      id: `eq.${orgId}`,
      select: "name,org_type,description,sectors,ticket_size,investment_stages,investment_regions,hq_country,website_url,li_company_id",
    },
  });
  const current = rows?.[0] || {};

  const byCompanyId = await findOrgLinkedinByCompanyId(orgId, current);
  if (byCompanyId) return byCompanyId;

  const effectiveWebsite = websiteUrl || current.website_url || "";
  const effectiveCountry = country || current.hq_country || "";

  const profileLines: string[] = [];
  if (current.org_type) profileLines.push(`Type: ${FIND_ORG_TYPE_LABEL[current.org_type] || current.org_type}`);
  if (current.sectors?.length) profileLines.push(`Sectors it invests in: ${current.sectors.join(", ")}`);
  if (current.ticket_size) profileLines.push(`Ticket size: ${current.ticket_size}`);
  if (current.investment_stages?.length) profileLines.push(`Investment stages: ${current.investment_stages.join(", ")}`);
  if (current.investment_regions?.length) profileLines.push(`Investment regions: ${current.investment_regions.join(", ")}`);
  if (current.description) profileLines.push(`Description on file: ${current.description}`);
  const knownProfile = profileLines.length
    ? `\n\nWhat's already on file about this specific company - use this to check you have the right one, not a different company that just happens to share the name:\n${profileLines.map((l) => `- ${l}`).join("\n")}`
    : "";

  const who = [name, effectiveWebsite, effectiveCountry].filter(Boolean).join(", ");
  const prompt = `Search for: linkedin ${who}

This is a company named "${name}"${effectiveWebsite ? `, whose website is ${effectiveWebsite}` : ""}${effectiveCountry ? `, headquartered in ${effectiveCountry}` : ""}.${knownProfile} Find their official LinkedIn company page.

Company names collide often - this search can surface a completely different company that just shares the name (different industry, different country, sometimes an unrelated startup). From the search results, identify up to 3 candidate linkedin.com/company/... URLs that could belong to this specific company. Check them one at a time, in the order the search ranked them: for each, look at what the result's title/snippet says about that company (name, industry, location) and judge whether it's consistent with what's already on file above (if given) - not just whether the name matches. Stop at the first candidate you can confidently verify this way and return its URL, leaving "candidates" empty.

If you verify a match, also report (each independently - leave any of them null rather than guessing if you're not confident, even if you did confirm the URL itself):
- Its correct/official name exactly as shown on that LinkedIn page
- ${ORG_TYPE_INSTRUCTIONS}
- Its industry/category and HQ location exactly as stated in that same search result/snippet

If two or more candidates look plausible by name but you can't confidently tell which one is this specific company even with the profile above, don't guess which is right - leave linkedin_url null and instead list up to 3 of them in "candidates" (their URL and whatever you can tell about their name/type/industry/HQ from the search result, each independently, null for anything unclear), so a human can pick.

If nothing found looks like a plausible match at all, return null for linkedin_url and an empty array for candidates.

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "find_org_linkedin", FIND_ORG_LINKEDIN_SCHEMA);
  const linkedinUrl = normalizeLinkedinUrl(data.linkedin_url);
  const candidates = (data.candidates ?? [])
    .map((c: any) => ({
      linkedin_url: normalizeLinkedinUrl(c.linkedin_url), name: stripPictograms(c.observed_name), org_type: c.observed_org_type || null,
      industry: c.observed_industry || null, hq: c.observed_hq || null,
    }))
    .filter((c: any) => c.linkedin_url);

  if (!linkedinUrl) return { linkedin_url: null, candidates };

  const orgFields: Record<string, any> = { linkedin_url: linkedinUrl };
  if ((!current.sectors || current.sectors.length === 0) && data.observed_industry) {
    orgFields.sectors = [data.observed_industry];
  }
  if (!current.hq_country && data.observed_hq) {
    orgFields.hq_country = data.observed_hq;
  }
  if (!current.org_type && data.observed_org_type) {
    orgFields.org_type = data.observed_org_type;
  }
  const rename = await renameOrgIfPossible(orgId, current.name ?? name, data.observed_name);
  if (rename.name) orgFields.name = rename.name;

  const updated = (await supabaseRequest("PATCH", "organizations", {
    params: { id: `eq.${orgId}` },
    body: orgFields,
    prefer: "return=representation",
  }))[0];

  // Still save the found URL either way (see above) - but flag it if some
  // *other* org already has this exact one, since that's a likely duplicate
  // worth checking (and now merging, via merge-into) rather than two
  // separate records for the same real company.
  const clash = await supabaseRequest("GET", "organizations", {
    params: { linkedin_url: `eq.${linkedinUrl}`, id: `neq.${orgId}`, select: "id,name", limit: "1" },
  });
  const duplicateOf = clash?.[0] ? { id: clash[0].id, name: clash[0].name } : null;

  return {
    linkedin_url: updated.linkedin_url, name: updated.name, org_type: updated.org_type,
    sectors: updated.sectors, hq_country: updated.hq_country,
    duplicate_of: duplicateOf, name_clash: rename.name_clash, candidates: [],
  };
}

// ---------- Routing ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  try {
    const auth = await authenticate(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/graph-api/, "") || "/";

    if (req.method === "POST" && path === "/research") {
      const body = await req.json();
      const name = (body.name ?? "").trim();
      const linkedinUrl = (body.linkedin_url ?? "").trim();
      if (!name && !linkedinUrl) return json({ error: "name or linkedin_url is required" }, 400);
      return json(await researchOrganization(name, linkedinUrl));
    }

    if (req.method === "POST" && path === "/research-person") {
      const body = await req.json();
      return json(await researchPerson(
        (body.name ?? "").trim(),
        (body.company_hint ?? "").trim(),
        (body.linkedin_url ?? "").trim(),
      ));
    }

    if (req.method === "GET" && path === "/organizations") {
      const limitParam = url.searchParams.get("limit");
      const offsetParam = url.searchParams.get("offset");
      const { orgs, totalCount, enrichedLastMonthCount } = await listOrganizations({
        includeEmployers: url.searchParams.get("include_employers") === "true",
        q: (url.searchParams.get("q") ?? "").trim() || undefined,
        limit: limitParam !== null ? parseInt(limitParam, 10) : undefined,
        offset: offsetParam !== null ? parseInt(offsetParam, 10) : undefined,
        starredOnly: url.searchParams.get("starred_only") === "true",
        showHidden: url.searchParams.get("show_hidden") === "true",
        jplOnly: url.searchParams.get("jpl_only") === "true",
        sort: url.searchParams.get("sort") ?? undefined,
        dir: url.searchParams.get("dir") === "desc" ? "desc" : "asc",
        withCounts: url.searchParams.get("with_counts") === "true",
        countries: parseListParam(url.searchParams.get("countries")),
        orgTypes: parseListParam(url.searchParams.get("org_types")),
        sectors: parseListParam(url.searchParams.get("sectors")),
        investmentRegions: parseListParam(url.searchParams.get("investment_regions")),
      });
      return json(orgs, 200, {
        ...(totalCount !== undefined ? { "X-Total-Count": String(totalCount) } : {}),
        ...(enrichedLastMonthCount !== undefined ? { "X-Enriched-Last-Month-Count": String(enrichedLastMonthCount) } : {}),
      });
    }

    // Checked ahead of orgIdMatch below, or "filter-options"/"duplicate-
    // candidates" would themselves be parsed as an organization id.
    if (req.method === "GET" && path === "/organizations/filter-options") {
      return json(await getOrgFilterOptions());
    }
    if (req.method === "GET" && path === "/organizations/duplicate-candidates") {
      return json(await findDuplicateOrgCandidates());
    }
    if (req.method === "POST" && path === "/organizations/duplicate-candidates/dismiss") {
      const body = await req.json();
      return json(await dismissDuplicateGroup("organization", body.ids));
    }

    if (req.method === "POST" && path === "/organizations") {
      const body = await req.json();
      return json(await saveOrganization(body));
    }

    if (req.method === "GET" && path === "/people") {
      const limitParam = url.searchParams.get("limit");
      const offsetParam = url.searchParams.get("offset");
      const { rows, hasMore, totalCount, enrichedLastMonthCount } = await searchPeopleGlobal({
        query: (url.searchParams.get("q") ?? "").trim(),
        includePast: url.searchParams.get("include_past") === "true",
        limit: limitParam !== null ? parseInt(limitParam, 10) : undefined,
        offset: offsetParam !== null ? parseInt(offsetParam, 10) : undefined,
        starredOnly: url.searchParams.get("starred_only") === "true",
        baOnly: url.searchParams.get("ba_only") === "true",
        showHidden: url.searchParams.get("show_hidden") === "true",
        jplOnly: url.searchParams.get("jpl_only") === "true",
        withCounts: url.searchParams.get("with_counts") === "true",
      });
      return json(rows, 200, {
        "X-Has-More": String(hasMore),
        ...(totalCount !== undefined ? { "X-Total-Count": String(totalCount) } : {}),
        ...(enrichedLastMonthCount !== undefined ? { "X-Enriched-Last-Month-Count": String(enrichedLastMonthCount) } : {}),
      });
    }

    // Checked ahead of the generic personIdMatch GET below, or "duplicate-
    // candidates" would itself be parsed as a person id.
    if (req.method === "GET" && path === "/people/duplicate-candidates") {
      return json(await findDuplicatePeopleCandidates());
    }
    if (req.method === "POST" && path === "/people/duplicate-candidates/dismiss") {
      const body = await req.json();
      return json(await dismissDuplicateGroup("person", body.ids));
    }
    // Same reason as duplicate-candidates above: ahead of the generic
    // personIdMatch GET, or "match-candidates" would be parsed as a person id.
    if (req.method === "GET" && path === "/people/match-candidates") {
      const name = (url.searchParams.get("name") ?? "").trim();
      if (!name) return json({ error: "name is required" }, 400);
      return json(await findPersonMatchCandidates(name, normalizeLinkedinUrl(url.searchParams.get("linkedin_url"))));
    }

    if (req.method === "GET" && path === "/news") {
      const entityType = url.searchParams.get("entity_type") ?? "";
      const entityId = url.searchParams.get("entity_id") ?? "";
      if (!entityType || !entityId) return json({ error: "entity_type and entity_id are required" }, 400);
      return json(await listNews(entityType, entityId));
    }

    if (req.method === "POST" && path === "/news/search") {
      const body = await req.json();
      const { entity_type, entity_id, name, org_context } = body;
      if (!entity_type || !entity_id || !name) {
        return json({ error: "entity_type, entity_id, and name are required" }, 400);
      }
      return json(await searchAndSaveNews(entity_type, entity_id, name, org_context));
    }

    if (req.method === "POST" && path === "/people/find-linkedin") {
      const body = await req.json();
      const personId = (body.person_id ?? "").trim();
      const name = (body.name ?? "").trim();
      if (!personId || !name) return json({ error: "person_id and name are required" }, 400);
      return json(await findPersonLinkedin(
        personId, name, (body.title ?? "").trim(), (body.company ?? "").trim(), (body.organization_id ?? "").trim(),
      ));
    }

    if (req.method === "POST" && path === "/organizations/find-linkedin") {
      const body = await req.json();
      const orgId = (body.org_id ?? "").trim();
      const name = (body.name ?? "").trim();
      if (!orgId || !name) return json({ error: "org_id and name are required" }, 400);
      return json(await findOrgLinkedin(orgId, name, (body.website_url ?? "").trim(), (body.country ?? "").trim()));
    }

    const orgConnectionsMatch = path.match(/^\/organizations\/([^/]+)\/connections$/);
    if (orgConnectionsMatch && req.method === "GET") {
      return json(await listOrgConnections(orgConnectionsMatch[1]));
    }
    if (orgConnectionsMatch && req.method === "POST") {
      const body = await req.json();
      const relationshipType = (body.relationship_type ?? "").trim();
      if (!relationshipType) return json({ error: "relationship_type is required" }, 400);
      return json(await createOrgConnection(
        orgConnectionsMatch[1], relationshipType,
        (body.other_org_id ?? "").trim(), (body.other_org_name ?? "").trim(), (body.notes ?? "").trim(),
      ));
    }

    const connectionIdMatch = path.match(/^\/connections\/([^/]+)$/);
    if (connectionIdMatch && req.method === "DELETE") {
      await supabaseRequest("DELETE", "connections", { params: { id: `eq.${connectionIdMatch[1]}` } });
      return json({ ok: true });
    }

    const orgIdMatch = path.match(/^\/organizations\/([^/]+)$/);
    if (orgIdMatch && req.method === "GET") {
      const org = await getOrganization(orgIdMatch[1]);
      if (!org) return json({ error: "organization not found" }, 404);
      return json(org);
    }
    if (orgIdMatch && req.method === "DELETE") {
      await supabaseRequest("DELETE", "organizations", { params: { id: `eq.${orgIdMatch[1]}` } });
      return json({ ok: true });
    }
    if (orgIdMatch && req.method === "PATCH") {
      const body = await req.json();
      const fields = pickDefined(body, [
        "name", "org_type", "website_url", "linkedin_url", "hq_country", "country_code", "description",
        "sectors", "ticket_size", "investment_stages", "investment_regions", "fund_type_raw",
        "is_starred", "is_hidden",
      ]);
      if ("name" in fields) {
        const newName = String(fields.name ?? "").trim();
        if (!newName) return json({ error: "name cannot be blank" }, 400);
        // organizations_name_key is a unique index on lower(name) - check for
        // a clash up front (same pattern as renameOrgIfPossible, for the
        // LinkedIn-driven rename) rather than letting a hand-edit hit that
        // constraint and surface a raw Postgres error to the user.
        const clash = await supabaseRequest("GET", "organizations", {
          params: { name: `ilike.${orValue(newName)}`, id: `neq.${orgIdMatch[1]}`, select: "id,name", limit: "1" },
        });
        if (clash?.length) {
          return json({ error: `An organization named "${clash[0].name}" already exists - pick a different name, or merge into it instead.` }, 409);
        }
        fields.name = newName;
      }
      if ("org_type" in fields) {
        if (fields.org_type && !ALL_ORG_TYPE_SLUGS.includes(fields.org_type)) {
          return json({ error: `org_type must be blank or one of ${ALL_ORG_TYPE_SLUGS.join(", ")}` }, 400);
        }
        fields.org_type = fields.org_type || null;  // "" is not a valid value for the check constraint - blank means null
      }
      if ("website_url" in fields) fields.website_url = normalizeWebsiteUrl(fields.website_url);
      if ("linkedin_url" in fields) fields.linkedin_url = normalizeLinkedinUrl(fields.linkedin_url);
      for (const arrayField of ["sectors", "investment_stages", "investment_regions"]) {
        if (arrayField in fields) fields[arrayField] = Array.isArray(fields[arrayField]) ? fields[arrayField].filter(Boolean) : [];
      }
      if (!Object.keys(fields).length) return json({ error: "no editable fields provided" }, 400);
      const updated = await supabaseRequest("PATCH", "organizations", {
        params: { id: `eq.${orgIdMatch[1]}` },
        body: fields,
        prefer: "return=representation",
      });
      if (!updated?.length) return json({ error: "organization not found" }, 404);
      return json(updated[0]);
    }

    const orgApifyMatch = path.match(/^\/organizations\/([^/]+)\/enrich-from-apify$/);
    if (orgApifyMatch && req.method === "POST") {
      return json(await enrichOrgFromApify(orgApifyMatch[1]));
    }

    const orgMergeMatch = path.match(/^\/organizations\/([^/]+)\/merge-into$/);
    if (orgMergeMatch && req.method === "POST") {
      const body = await req.json();
      const targetId = (body.target_id ?? "").trim();
      if (!targetId) return json({ error: "target_id is required" }, 400);
      return json(await mergeOrgInto(orgMergeMatch[1], targetId));
    }

    const personIdMatch = path.match(/^\/people\/([^/]+)$/);
    if (personIdMatch && req.method === "GET") {
      const rows = await supabaseRequest("GET", "people", { params: { id: `eq.${personIdMatch[1]}`, select: "*" } });
      if (!rows?.length) return json({ error: "person not found" }, 404);
      return json(rows[0]);
    }
    if (personIdMatch && req.method === "PATCH") {
      const body = await req.json();
      const fields = pickDefined(body, ["full_name", "linkedin_url", "country", "country_code", "is_user", "is_starred", "is_hidden", "is_ba"]);
      if ("full_name" in fields && !String(fields.full_name ?? "").trim()) return json({ error: "full_name cannot be blank" }, 400);
      if ("linkedin_url" in fields) fields.linkedin_url = normalizeLinkedinUrl(fields.linkedin_url);
      if (!Object.keys(fields).length) return json({ error: "no editable fields provided" }, 400);
      const updated = await supabaseRequest("PATCH", "people", {
        params: { id: `eq.${personIdMatch[1]}` },
        body: fields,
        prefer: "return=representation",
      });
      if (!updated?.length) return json({ error: "person not found" }, 404);
      return json(updated[0]);
    }
    if (personIdMatch && req.method === "DELETE") {
      await supabaseRequest("DELETE", "people", { params: { id: `eq.${personIdMatch[1]}` } });
      return json({ ok: true });
    }

    const personEnrichMatch = path.match(/^\/people\/([^/]+)\/enrich-from-linkedin$/);
    if (personEnrichMatch && req.method === "POST") {
      const body = await req.json();
      const linkedinUrl = (body.linkedin_url ?? "").trim();
      if (!linkedinUrl) return json({ error: "linkedin_url is required" }, 400);
      return json(await enrichPersonFromLinkedinUrl(
        personEnrichMatch[1], linkedinUrl, (body.name ?? "").trim(), (body.organization_id ?? "").trim(),
      ));
    }

    const personApifyMatch = path.match(/^\/people\/([^/]+)\/enrich-from-apify$/);
    if (personApifyMatch && req.method === "POST") {
      return json(await enrichPersonFromApify(personApifyMatch[1]));
    }

    const personMergeMatch = path.match(/^\/people\/([^/]+)\/merge-into$/);
    if (personMergeMatch && req.method === "POST") {
      const body = await req.json();
      const targetId = (body.target_id ?? "").trim();
      if (!targetId) return json({ error: "target_id is required" }, 400);
      return json(await mergePersonRecordInto(personMergeMatch[1], targetId));
    }

    const personEducationMatch = path.match(/^\/people\/([^/]+)\/education$/);
    if (personEducationMatch && req.method === "GET") {
      return json(await listEducationForPerson(personEducationMatch[1]));
    }

    const personEmploymentMatch = path.match(/^\/people\/([^/]+)\/employment-history$/);
    if (personEmploymentMatch && req.method === "GET") {
      return json(await listEmploymentHistoryForPerson(personEmploymentMatch[1]));
    }

    const schoolPeopleMatch = path.match(/^\/schools\/([^/]+)\/people$/);
    if (schoolPeopleMatch && req.method === "GET") {
      return json(await listPeopleAtSchool(schoolPeopleMatch[1]));
    }

    const membershipIdMatch = path.match(/^\/memberships\/([^/]+)$/);
    if (membershipIdMatch && req.method === "PATCH") {
      const body = await req.json();
      const fields = pickDefined(body, ["title", "focus"]);
      if (!Object.keys(fields).length) return json({ error: "no editable fields provided" }, 400);
      const updated = await supabaseRequest("PATCH", "memberships", {
        params: { id: `eq.${membershipIdMatch[1]}` },
        body: fields,
        prefer: "return=representation",
      });
      if (!updated?.length) return json({ error: "membership not found" }, 404);
      return json(updated[0]);
    }

    return json({ error: "not found" }, 404);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return json({ error: err instanceof Error ? err.message : String(err) }, status);
  }
});
