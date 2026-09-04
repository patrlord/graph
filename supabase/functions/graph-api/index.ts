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
//   GET    /organizations       -> [ {id, name, org_type, website_url, linkedin_url, hq_country, sectors, updated_at}, ... ]
//   POST   /organizations       { organization, people } -> saved { organization, people }
//     organization fields: name, org_type, website_url, linkedin_url, hq_country, description,
//     sectors[]; plus investor-profile fields not touched by research (ticket_size, investment_stages[],
//     investment_regions[], fund_type_raw) - sourced only from list-style bulk imports, merge-only-blanks
//     like everything else here
//   GET    /organizations/:id   -> org with nested people
//   DELETE /organizations/:id   -> { ok: true }
//   PATCH  /organizations/:id   { any subset of organization fields above } -> updated org (direct set, not merge-only-blanks - a
//     field present in the body is written exactly as given, including null/"" to clear it; for hand-editing in the UI)
//   GET    /people?q=term       -> [ {id, full_name, linkedin_url, country, title, focus, membership_id, organization}, ... ] (q omitted/empty -> all people, capped at 1000)
//   PATCH  /people/:id          { any subset of full_name, linkedin_url, country } -> updated person (direct set, same as organizations PATCH)
//   PATCH  /memberships/:id     { any subset of title, focus } -> updated membership (direct set, same as organizations PATCH)
//   POST   /people/:id/enrich-from-linkedin  { linkedin_url, name?, organization_id? } -> { country, title, observed_company }
//     (for a hand-entered LinkedIn URL, not one found via search - looks up what else that profile says and
//     fills in country/title, only where currently blank; organization_id needed to know which membership's title to fill)
//   POST   /people/:id/enrich-from-apify  {} -> updated person (full row, including the li_* fields below)
//     (requires the person to already have a linkedin_url; runs the harvestapi LinkedIn Profile Scraper Apify actor
//     against it and overwrites all li_* fields with the fresh result - country is filled only if currently blank)
//   POST   /people/find-linkedin  { person_id, name, title?, company?, organization_id? } -> { linkedin_url, title, observed_company, renamed_to, merged_into_person_id }
//     (saved if found; title only filled if the membership's was blank. If the name as given finds nothing, retries once with
//     the word order reversed (surname-first sources); a verified match there sets renamed_to. If that corrected name/URL
//     already belongs to a different existing person, merges into it instead (deletes person_id) and sets merged_into_person_id)
//   POST   /organizations/find-linkedin  { org_id, name, website_url?, country? } -> { linkedin_url, sectors, hq_country } (saved if found; sectors/hq_country only filled if blank)
//   GET    /news?entity_type=organization|person&entity_id=uuid -> [ news_item, ... ]
//   POST   /news/search         { entity_type, entity_id, name, org_context? } -> [ news_item, ... ] (saved + deduped)
//   GET    /organizations/:id/connections -> [ {id, relationship_type, notes, direction, other: {id,name,org_type}}, ... ]
//   POST   /organizations/:id/connections { relationship_type, other_org_id? | other_org_name?, notes? } -> created connection (other_org_name finds-or-creates, org_type "group" if new)
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
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
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

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
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
  const orParts = [`name.ilike.${orValue(name)}`];
  if (websiteUrl) orParts.push(`website_url.eq.${orValue(websiteUrl)}`);
  if (linkedinUrl) orParts.push(`linkedin_url.eq.${orValue(linkedinUrl)}`);
  const rows = await supabaseRequest("GET", "organizations", {
    params: { or: `(${orParts.join(",")})`, select: "*", limit: "5" },
  });
  return rows?.[0] ?? null;
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

async function saveOrganization(payload: any) {
  const orgIn = payload.organization ?? {};
  const peopleIn: any[] = payload.people ?? [];
  const name = (orgIn.name ?? "").trim();
  if (!name) throw new HttpError(400, "organization.name is required");

  const websiteUrl = normalizeWebsiteUrl(orgIn.website_url);
  const linkedinUrl = normalizeLinkedinUrl(orgIn.linkedin_url);
  const orgFields = {
    name,
    org_type: orgIn.org_type || "vc",
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
    const candidates = await findPeopleByNameOrLinkedin(fullName, personLinkedinUrl);
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

async function listOrganizations() {
  return await supabaseRequest("GET", "organizations", {
    params: {
      select: "id,name,org_type,website_url,linkedin_url,hq_country,sectors,updated_at",
      order: "name.asc",
    },
  });
}

async function getOrganization(id: string) {
  const orgs = await supabaseRequest("GET", "organizations", { params: { id: `eq.${id}`, select: "*" } });
  if (!orgs?.length) return null;
  const org = orgs[0];
  org.people = await supabaseRequest("GET", "memberships", {
    params: {
      organization_id: `eq.${id}`,
      select: "id,title,focus,is_current,people(*)",
    },
  });
  return org;
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

async function searchPeopleGlobal(query: string) {
  const params: Record<string, string> = {
    select: "*,memberships(id,organization_id,is_current,updated_at,title,focus,organizations(id,name))",
    order: "full_name.asc",
    limit: query ? "25" : "1000",
  };
  if (query) params.full_name = `ilike.*${query}*`;
  const people = await supabaseRequest("GET", "people", { params });
  return (people ?? []).map((p: any) => {
    const ms = [...(p.memberships || [])].sort((a: any, b: any) => {
      if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
    const best = ms[0];
    const { memberships, ...rest } = p;
    return {
      ...rest, title: best?.title || null, focus: best?.focus || null,
      membership_id: best?.id || null, organization: best?.organizations || null,
    };
  });
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

// ---------- Apify (LinkedIn Profile Scraper actor, https://console.apify.com/actors/LpVuK3Zozwuipa5bp) ----------

const APIFY_LINKEDIN_PROFILE_ACTOR = "LpVuK3Zozwuipa5bp";

// Runs the actor synchronously and returns its one dataset item's "element"
// (the actual profile - the actor also returns query/status/requestId
// alongside it, which we don't need). Actor input just wants one of
// url/publicIdentifier/profileId; we always have the URL. Returns null if
// the actor found nothing for this URL (rather than throwing) so the caller
// can distinguish "ran fine, no profile" from a real request failure.
async function fetchLinkedinProfileViaApify(linkedinUrl: string): Promise<Record<string, any> | null> {
  if (!APIFY_API_TOKEN) throw new HttpError(503, "APIFY_API_TOKEN is not configured.");
  const res = await fetchWithTimeout(
    `https://api.apify.com/v2/acts/${APIFY_LINKEDIN_PROFILE_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: linkedinUrl }),
    },
    60000,
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Apify request failed (${res.status}): ${detail}`);
  }
  const items = await res.json();
  const item = Array.isArray(items) ? items[0] : null;
  if (!item) return null;  // genuinely empty dataset - actor ran, found nothing at all
  if (!item.element) {
    // The actor's own code (see console.apify.com/actors/LpVuK3Zozwuipa5bp source)
    // pushes harvest-api's error payload as-is - no "element" key - when the
    // underlying lookup itself failed, instead of the usual {element, query,
    // status} shape. Surface whatever it says rather than reporting a plain
    // "no data" that hides the real reason.
    throw new Error(`Apify/harvest-api returned no profile: ${JSON.stringify(item).slice(0, 400)}`);
  }
  return item.element;
}

// Maps the actor's profile shape onto our li_* columns. Nested sections
// (experience, education, ...) are kept as-is rather than reshaped - they're
// stored as jsonb and there's no need to normalize them for how they're used.
function mapApifyProfileToLiFields(profile: Record<string, any>): Record<string, any> {
  return {
    li_headline: profile.headline || null,
    li_about: profile.about || null,
    li_photo_url: profile.photo || null,
    li_location_text: profile.location?.linkedinText || null,
    li_top_skills: profile.topSkills || null,
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

  const updated = (await supabaseRequest("PATCH", "people", {
    params: { id: `eq.${personId}` },
    body: fields,
    prefer: "return=representation",
  }))[0];
  return updated;
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

const ORG_TYPE_INSTRUCTIONS = `Classify the firm's type as exactly one of:
- "vc": an independent venture capital firm
- "cvc": a corporate venture capital arm (invests from a corporation's balance sheet/strategic fund)
- "angel": an individual business angel / angel investor
- "family_office": a family office or private wealth investment vehicle
If genuinely unclear, default to "vc".`;

const INVESTOR_PROFILE_INSTRUCTIONS = `- Typical investment ticket size / check size it writes (e.g. "$250K-1M"), only if stated somewhere
- Investment stage(s) it invests at (e.g. "Pre-seed", "Seed", "Series A", "Growth")
- Geographic region(s) it focuses its investing in (e.g. "US", "Europe", "Global") - this is about where it invests, not where it's headquartered, though for a firm that only invests locally these are often the same
- A short, more specific fund-type label than the vc/cvc/angel/family_office classification above, if one applies (e.g. "Corporate VC", "Family Office", "Accelerator", "Venture Studio", "Fund of Funds") - otherwise leave null`;

const RESEARCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    organization: {
      type: "object",
      properties: {
        name: { type: ["string", "null"] },
        org_type: { type: "string", enum: ["vc", "cvc", "angel", "family_office"] },
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
  const who = name ? `"${name}"` : `the firm at this LinkedIn company page: ${linkedinUrl}`;
  const prompt = `Search for and find information about ${who}, an investment organization: its official website, LinkedIn company page, key team members, and sectors it invests in.

Report:
- Its name
- ${ORG_TYPE_INSTRUCTIONS}
- Official website URL and LinkedIn company page URL, only if confirmed
- Where it's headquartered (city and country)
- A one-sentence description of the firm
- 2-6 short sector/industry tags it focuses on (e.g. "Fintech", "AI infrastructure", "Climate tech")
${INVESTOR_PROFILE_INSTRUCTIONS}
- Its current key team members - partners, principals, investment directors and similar investment-team roles (skip admin/ops staff). For each: full name, title, sector/focus if stated, country they're based in, and personal LinkedIn URL if confirmed.

If you cannot confidently identify the firm, leave "name" and other fields null rather than guessing (still pick a best-guess org_type if you can tell it's an investment organization at all).

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "firm_research", RESEARCH_JSON_SCHEMA);
  data.organization = data.organization || {};
  if (!data.organization.org_type) data.organization.org_type = "vc";
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
  const prompt = `Search for and identify ${who} - an individual working at a VC, CVC, business angel, or family office firm.

Report:
- Their full name, current title, sector/focus if stated, and the country they're based in
- Their confirmed personal LinkedIn URL
- The firm they currently work at: its name, ${ORG_TYPE_INSTRUCTIONS}, official website, LinkedIn company page, headquarters (city and country), a one-sentence description, and 2-6 short sector/industry tags. Also, about that firm:
${INVESTOR_PROFILE_INSTRUCTIONS}

If you cannot confidently identify this person or their current firm, leave the relevant fields null rather than guessing. Return exactly one entry in "people" (or none if you can't confirm anyone).

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "person_research", RESEARCH_JSON_SCHEMA);
  data.organization = data.organization || {};
  if (!data.organization.org_type) data.organization.org_type = "vc";
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
    observed_industry: { type: ["string", "null"] },
    observed_hq: { type: ["string", "null"] },
  },
  required: ["linkedin_url", "observed_industry", "observed_hq"],
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

// Same idea as findPersonLinkedin, but for a company's LinkedIn page. Fills
// in sectors (from industry) and hq_country - only where currently blank.
async function findOrgLinkedin(orgId: string, name: string, websiteUrl: string, country: string) {
  const who = [name, websiteUrl, country].filter(Boolean).join(", ");
  const prompt = `Search for: linkedin ${who}

This is a company named "${name}"${websiteUrl ? `, whose website is ${websiteUrl}` : ""}${country ? `, headquartered in ${country}` : ""}. Find their official LinkedIn company page.

From the search results, identify up to 3 candidate linkedin.com/company/... URLs that could belong to this specific company. Check them one at a time, in the order the search ranked them: for each, look at what the result's title/snippet says about that company (name, industry, location) and judge whether it genuinely matches - the name should match, and location/industry should at least plausibly match. Stop at the first candidate you can confidently verify this way and return its URL.

If you verify a match, also report the company's industry/category and HQ location exactly as stated in that same search result/snippet (null for either if not stated there - don't guess).

If none of the candidates confidently match, return null for everything - never guess, and never return an unverified best-guess URL.

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "find_org_linkedin", FIND_ORG_LINKEDIN_SCHEMA);
  const linkedinUrl = normalizeLinkedinUrl(data.linkedin_url);
  if (!linkedinUrl) return { linkedin_url: null };

  const existingRows = await supabaseRequest("GET", "organizations", {
    params: { id: `eq.${orgId}`, select: "sectors,hq_country" },
  });
  const current = existingRows?.[0] || {};
  const orgFields: Record<string, any> = { linkedin_url: linkedinUrl };
  if ((!current.sectors || current.sectors.length === 0) && data.observed_industry) {
    orgFields.sectors = [data.observed_industry];
  }
  if (!current.hq_country && data.observed_hq) {
    orgFields.hq_country = data.observed_hq;
  }
  const updated = (await supabaseRequest("PATCH", "organizations", {
    params: { id: `eq.${orgId}` },
    body: orgFields,
    prefer: "return=representation",
  }))[0];
  return { linkedin_url: updated.linkedin_url, sectors: updated.sectors, hq_country: updated.hq_country };
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
      return json(await listOrganizations());
    }

    if (req.method === "POST" && path === "/organizations") {
      const body = await req.json();
      return json(await saveOrganization(body));
    }

    if (req.method === "GET" && path === "/people") {
      const q = (url.searchParams.get("q") ?? "").trim();
      return json(await searchPeopleGlobal(q));
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
        "name", "org_type", "website_url", "linkedin_url", "hq_country", "description",
        "sectors", "ticket_size", "investment_stages", "investment_regions", "fund_type_raw",
      ]);
      if ("name" in fields && !String(fields.name ?? "").trim()) return json({ error: "name cannot be blank" }, 400);
      if ("org_type" in fields && !["vc", "cvc", "angel", "family_office", "group"].includes(fields.org_type)) {
        return json({ error: "org_type must be one of vc, cvc, angel, family_office, group" }, 400);
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

    const personIdMatch = path.match(/^\/people\/([^/]+)$/);
    if (personIdMatch && req.method === "PATCH") {
      const body = await req.json();
      const fields = pickDefined(body, ["full_name", "linkedin_url", "country"]);
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
