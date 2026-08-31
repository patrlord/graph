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
//   POST   /research-person     { name?, company_hint?, linkedin_url? } -> { organization, people: [one] }
//   GET    /organizations       -> [ {id, name, org_type, website_url, linkedin_url, hq_country, sectors, updated_at}, ... ]
//   POST   /organizations       { organization, people } -> saved { organization, people }
//   GET    /organizations/:id   -> org with nested people
//   DELETE /organizations/:id   -> { ok: true }
//   GET    /people?q=term       -> [ {id, full_name, linkedin_url, country, title, organization}, ... ]
//   GET    /news?entity_type=organization|person&entity_id=uuid -> [ news_item, ... ]
//   POST   /news/search         { entity_type, entity_id, name, org_context? } -> [ news_item, ... ] (saved + deduped)

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const APOLLO_API_KEY = Deno.env.get("APOLLO_API_KEY");
const ALLOWED_EMAIL = Deno.env.get("ALLOWED_EMAIL");

const OPENROUTER_MODEL = "openai/gpt-5-nano";
const APOLLO_BASE = "https://api.apollo.io/api/v1";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY },
  });
  if (!res.ok) return { ok: false, status: 401, error: "invalid or expired session" };
  const user = await res.json();
  if ((user.email || "").toLowerCase() !== ALLOWED_EMAIL.toLowerCase()) {
    return { ok: false, status: 403, error: "this account is not authorized for this app" };
  }
  return { ok: true };
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
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
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
      select: "id,title,focus,is_current,people(id,full_name,linkedin_url,country)",
    },
  });
  return org;
}

async function searchPeopleGlobal(query: string) {
  const people = await supabaseRequest("GET", "people", {
    params: {
      full_name: `ilike.*${query}*`,
      select: "*,memberships(organization_id,is_current,updated_at,title,organizations(id,name))",
      limit: "25",
    },
  });
  return (people ?? []).map((p: any) => {
    const ms = [...(p.memberships || [])].sort((a: any, b: any) => {
      if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
    const best = ms[0];
    const { memberships, ...rest } = p;
    return { ...rest, title: best?.title || null, organization: best?.organizations || null };
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
    const res = await fetch(`${APOLLO_BASE}/organizations/enrich?${new URLSearchParams({ domain })}`, {
      headers: { "x-api-key": APOLLO_API_KEY!, Accept: "application/json" },
    });
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

// ---------- OpenRouter ----------

async function openRouterCall(userContent: string, schemaName: string, jsonSchema: any): Promise<any> {
  if (!OPENROUTER_API_KEY) throw new HttpError(503, "OPENROUTER_API_KEY is not configured.");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
      plugins: [{ id: "web", engine: "exa", max_results: 10 }],
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema: jsonSchema } },
    }),
  });
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
      },
      required: ["name", "org_type", "website_url", "linkedin_url", "hq_country", "description", "sectors"],
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
- Its current key team members - partners, principals, investment directors and similar investment-team roles (skip admin/ops staff). For each: full name, title, sector/focus if stated, country they're based in, and personal LinkedIn URL if confirmed.

If you cannot confidently identify the firm, leave "name" and other fields null rather than guessing (still pick a best-guess org_type if you can tell it's an investment organization at all).

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "firm_research", RESEARCH_JSON_SCHEMA);
  data.organization = data.organization || {};
  if (!data.organization.org_type) data.organization.org_type = "vc";
  data.people = data.people || [];
  if (data.organization.name) await backfillFromApollo(data.organization);
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
- The firm they currently work at: its name, ${ORG_TYPE_INSTRUCTIONS}, official website, LinkedIn company page, headquarters (city and country), a one-sentence description, and 2-6 short sector/industry tags

If you cannot confidently identify this person or their current firm, leave the relevant fields null rather than guessing. Return exactly one entry in "people" (or none if you can't confirm anyone).

${NEVER_GUESS}`;

  const data = await openRouterCall(prompt, "person_research", RESEARCH_JSON_SCHEMA);
  data.organization = data.organization || {};
  if (!data.organization.org_type) data.organization.org_type = "vc";
  data.people = (data.people || []).slice(0, 1);
  if (data.organization.name) await backfillFromApollo(data.organization);
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

// ---------- Routing ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  const auth = await authenticate(req);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/graph-api/, "") || "/";

  try {
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
      if (!q) return json({ error: "q is required" }, 400);
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

    return json({ error: "not found" }, 404);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    return json({ error: err instanceof Error ? err.message : String(err) }, status);
  }
});
