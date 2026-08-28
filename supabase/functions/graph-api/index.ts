// Graph API - Supabase Edge Function
//
// Hosted replacement for graph_app.py's backend. Holds ANTHROPIC_API_KEY,
// APOLLO_API_KEY, and ALLOWED_EMAIL as Supabase function secrets (never
// shipped to the static frontend). SUPABASE_URL / SUPABASE_ANON_KEY /
// SUPABASE_SERVICE_ROLE_KEY are auto-provided by the Edge Functions runtime.
//
// Auth: every request must carry `Authorization: Bearer <supabase-user-jwt>`
// from a real signed-in Supabase Auth session (not just the anon key, which
// is itself a validly-signed JWT but isn't tied to any user - it's checked
// for explicitly). The authenticated user's email must also match
// ALLOWED_EMAIL, as a second layer independent of whether public sign-ups
// happen to be left enabled on the project. This is a private tool, not a
// public one, so everything is gated (including reads), not just research.
//
// Routes (path is whatever follows the function name, e.g. /graph-api/research):
//   POST   /research            { name, org_type } -> { organization, people }
//   GET    /organizations       -> [ {id, name, org_type, website_url, linkedin_url, hq_country, updated_at}, ... ]
//   POST   /organizations       { organization, people } -> saved { organization, people }
//   GET    /organizations/:id   -> org with nested people
//   DELETE /organizations/:id   -> { ok: true }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const APOLLO_API_KEY = Deno.env.get("APOLLO_API_KEY");
const ALLOWED_EMAIL = Deno.env.get("ALLOWED_EMAIL");

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

const RESEARCH_MODEL = "claude-sonnet-5";
const MAX_WEB_SEARCHES = 8;
const APOLLO_BASE = "https://api.apollo.io/api/v1";

const ORG_TYPE_LABELS: Record<string, string> = {
  vc: "venture capital firm",
  cvc: "corporate venture capital arm",
  angel: "business angel / angel investor",
  family_office: "family office",
};

const RESEARCH_SYSTEM_PROMPT =
  "You are a careful research assistant that finds accurate, current information about " +
  "investment firms and the people on their team using web search. Be conservative: only " +
  "state facts you actually found via search, and never invent, guess, or construct a URL " +
  "(website or LinkedIn). If you cannot find a piece of information, use null rather than " +
  "guessing at it.";

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

function mergeFields(existing: Record<string, any>, newFields: Record<string, any>) {
  const merged: Record<string, any> = {};
  for (const [k, v] of Object.entries(newFields)) {
    merged[k] = v !== null && v !== undefined && v !== "" ? v : existing[k];
  }
  return merged;
}

async function findOrganizationByName(name: string) {
  const rows = await supabaseRequest("GET", "organizations", {
    params: { name: `ilike.${name}`, select: "*", limit: "1" },
  });
  return rows?.[0] ?? null;
}

async function findPeopleByName(name: string) {
  const rows = await supabaseRequest("GET", "people", {
    params: { full_name: `ilike.${name}`, select: "*" },
  });
  return rows ?? [];
}

async function saveOrganization(payload: any) {
  const orgIn = payload.organization ?? {};
  const peopleIn: any[] = payload.people ?? [];
  const name = (orgIn.name ?? "").trim();
  if (!name) throw new HttpError(400, "organization.name is required");

  const orgFields = {
    name,
    org_type: orgIn.org_type || "vc",
    website_url: orgIn.website_url || null,
    linkedin_url: orgIn.linkedin_url || null,
    hq_country: orgIn.hq_country || null,
    description: orgIn.description || null,
  };

  const existingOrg = await findOrganizationByName(name);
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

  const savedPeople = [];
  for (const p of peopleIn) {
    const fullName = (p.full_name ?? "").trim();
    if (!fullName) continue;
    const personFields = {
      full_name: fullName,
      linkedin_url: p.linkedin_url || null,
      country: p.country || null,
    };
    const candidates = await findPeopleByName(fullName);
    let existingMemberships: any[] = [];
    if (candidates.length) {
      existingMemberships = await supabaseRequest("GET", "memberships", {
        params: {
          organization_id: `eq.${org.id}`,
          person_id: `in.(${candidates.map((c: any) => c.id).join(",")})`,
          select: "*",
        },
      });
    }
    let person = null;
    if (existingMemberships.length) {
      const matchId = existingMemberships[0].person_id;
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
    const existingMembership = existingMemberships.find((m: any) => m.person_id === person.id);
    if (existingMembership) {
      membershipFields = mergeFields(existingMembership, membershipFields);
      await supabaseRequest("PATCH", "memberships", {
        params: { id: `eq.${existingMembership.id}` },
        body: membershipFields,
      });
    } else {
      await supabaseRequest("POST", "memberships", { body: membershipFields });
    }

    savedPeople.push({ ...person, title: membershipFields.title, focus: membershipFields.focus });
  }

  return { organization: org, people: savedPeople };
}

async function listOrganizations() {
  return await supabaseRequest("GET", "organizations", {
    params: {
      select: "id,name,org_type,website_url,linkedin_url,hq_country,updated_at",
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

// ---------- Research (Claude web search) ----------

async function researchOrganization(name: string, orgType: string) {
  if (!ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY is not configured.");
  const orgTypeLabel = ORG_TYPE_LABELS[orgType] || "investment firm";
  const prompt = `Research "${name}", a ${orgTypeLabel}.

1. Find its official website URL and its official LinkedIn company page URL.
2. Identify its current key team members - partners, principals, investment directors, and \
similar investment-team roles (skip purely operational/admin staff like office managers). For \
each person find:
   - full name
   - title (their role at the firm)
   - sector/focus if stated anywhere (e.g. "Fintech, Series A-B"), else null
   - the country they are based in, else null
   - their personal LinkedIn profile URL, only if you can find and confirm it - leave null \
otherwise, never guess or construct one

Use web search as needed, but don't over-search - a couple of searches per hard-to-find person is \
plenty; if it's not findable after that, use null and move on rather than exhausting your search \
budget on it. When you are done, respond with ONLY a single fenced json code block, and nothing \
else after it, containing exactly this shape:

\`\`\`json
{
  "organization": {
    "name": "...",
    "website_url": "... or null",
    "linkedin_url": "... or null",
    "hq_country": "... or null",
    "description": "one sentence description of the firm, or null"
  },
  "people": [
    {"full_name": "...", "title": "...", "focus": "... or null", "country": "... or null", "linkedin_url": "... or null"}
  ]
}
\`\`\``;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: RESEARCH_MODEL,
      max_tokens: 4096,
      system: RESEARCH_SYSTEM_PROMPT,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`Anthropic request failed (${res.status}): ${detail}`);
  }
  const response = await res.json();
  const text = (response.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  const match = text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
  if (!match) throw new Error("Could not find a JSON result in the model's response.");
  const data = JSON.parse(match[1]);
  data.organization = data.organization || {};
  data.organization.org_type = orgType;
  data.people = data.people || [];
  await backfillFromApollo(data.organization);
  return data;
}

// ---------- Routing ----------

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
      const orgType = body.org_type || "vc";
      if (!name) return json({ error: "name is required" }, 400);
      return json(await researchOrganization(name, orgType));
    }

    if (req.method === "GET" && path === "/organizations") {
      return json(await listOrganizations());
    }

    if (req.method === "POST" && path === "/organizations") {
      const body = await req.json();
      return json(await saveOrganization(body));
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
