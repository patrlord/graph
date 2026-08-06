"""
Graph — local web UI + Claude-powered research backend for a database of
VCs, CVCs, business angels, and family offices, their team members, and
the connections between them.

Run: python3 graph_app.py
Requires: pip install anthropic
Requires env (shell or local .env file, gitignored):
  ANTHROPIC_API_KEY     - for researching firms/people via Claude web search
  SUPABASE_URL          - e.g. https://xxxx.supabase.co
  SUPABASE_SERVICE_KEY  - the service_role secret key (Project Settings > API Keys)
Opens http://localhost:7434 in your browser automatically.
"""

import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import http.server
from pathlib import Path

import anthropic

MODEL = "claude-opus-4-8"
PORT = 7434

APP_DIR = Path(__file__).resolve().parent
HTML_FILE = APP_DIR / "graph.html"

ORG_TYPE_LABELS = {
    "vc": "venture capital firm",
    "cvc": "corporate venture capital arm",
    "angel": "business angel / angel investor",
    "family_office": "family office",
}

RESEARCH_SYSTEM_PROMPT = (
    "You are a careful research assistant that finds accurate, current information about "
    "investment firms and the people on their team using web search. Be conservative: only "
    "state facts you actually found via search, and never invent, guess, or construct a URL "
    "(website or LinkedIn). If you cannot find a piece of information, use null rather than "
    "guessing at it."
)


def _load_dotenv():
    env_file = APP_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _supabase_configured() -> bool:
    return bool(os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_KEY"))


def _supabase_request(method: str, path: str, params: dict = None, body=None, prefer: str = None):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    base = re.sub(r"/rest/v1$", "", base)
    url = f"{base}/rest/v1/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    key = os.environ["SUPABASE_SERVICE_KEY"]
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:500]
        raise RuntimeError(f"Supabase {method} {path} failed ({exc.code}): {detail}")


def _research_organization(name: str, org_type: str) -> dict:
    client = anthropic.Anthropic()
    org_type_label = ORG_TYPE_LABELS.get(org_type, "investment firm")
    prompt = f"""Research "{name}", a {org_type_label}.

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

Use web search as needed, searching multiple times if useful (official site, LinkedIn, team \
page, press). When you are done, respond with ONLY a single fenced json code block, and nothing \
else after it, containing exactly this shape:

```json
{{
  "organization": {{
    "name": "...",
    "website_url": "... or null",
    "linkedin_url": "... or null",
    "hq_country": "... or null",
    "description": "one sentence description of the firm, or null"
  }},
  "people": [
    {{"full_name": "...", "title": "...", "focus": "... or null", "country": "... or null", "linkedin_url": "... or null"}}
  ]
}}
```"""
    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=RESEARCH_SYSTEM_PROMPT,
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 12}],
        messages=[{"role": "user", "content": prompt}],
    )
    text = "".join(b.text for b in response.content if b.type == "text")
    match = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL)
    if not match:
        raise RuntimeError("Could not find a JSON result in the model's response.")
    data = json.loads(match.group(1))
    data.setdefault("organization", {})["org_type"] = org_type
    data.setdefault("people", [])
    return data


def _find_organization_by_name(name: str):
    rows = _supabase_request("GET", "organizations", params={"name": f"ilike.{name}", "select": "*", "limit": "1"})
    return rows[0] if rows else None


def _find_person_by_name(name: str):
    rows = _supabase_request("GET", "people", params={"full_name": f"ilike.{name}", "select": "*"})
    return rows or []


def _merge_fields(existing: dict, new_fields: dict) -> dict:
    """New values win, but a blank/null incoming value keeps whatever was already
    stored rather than clobbering it - so saving from a source with thinner data
    (e.g. a bulk import with no titles) never erases richer data saved earlier."""
    return {k: (v if v not in (None, "") else existing.get(k)) for k, v in new_fields.items()}


def _save_organization(payload: dict) -> dict:
    org_in = payload.get("organization") or {}
    people_in = payload.get("people") or []
    name = (org_in.get("name") or "").strip()
    if not name:
        raise ValueError("organization.name is required")

    org_fields = {
        "name": name,
        "org_type": org_in.get("org_type") or "vc",
        "website_url": org_in.get("website_url") or None,
        "linkedin_url": org_in.get("linkedin_url") or None,
        "hq_country": org_in.get("hq_country") or None,
        "description": org_in.get("description") or None,
    }

    existing = _find_organization_by_name(name)
    if existing:
        org = _supabase_request(
            "PATCH", "organizations", params={"id": f"eq.{existing['id']}"},
            body=_merge_fields(existing, org_fields), prefer="return=representation",
        )[0]
    else:
        org = _supabase_request(
            "POST", "organizations", body=org_fields, prefer="return=representation",
        )[0]

    saved_people = []
    for p in people_in:
        full_name = (p.get("full_name") or "").strip()
        if not full_name:
            continue
        person_fields = {
            "full_name": full_name,
            "linkedin_url": p.get("linkedin_url") or None,
            "country": p.get("country") or None,
        }
        candidates = _find_person_by_name(full_name)
        existing_memberships = []
        if candidates:
            existing_memberships = _supabase_request(
                "GET", "memberships",
                params={
                    "organization_id": f"eq.{org['id']}",
                    "person_id": f"in.({','.join(c['id'] for c in candidates)})",
                    "select": "*",
                },
            )
        person = None
        if existing_memberships:
            match_id = existing_memberships[0]["person_id"]
            person = next(c for c in candidates if c["id"] == match_id)
        elif candidates:
            person = candidates[0]

        if person:
            person = _supabase_request(
                "PATCH", "people", params={"id": f"eq.{person['id']}"},
                body=_merge_fields(person, person_fields), prefer="return=representation",
            )[0]
        else:
            person = _supabase_request(
                "POST", "people", body=person_fields, prefer="return=representation",
            )[0]

        membership_fields = {
            "person_id": person["id"],
            "organization_id": org["id"],
            "title": p.get("title") or None,
            "focus": p.get("focus") or None,
            "is_current": True,
        }
        existing_membership = next(
            (m for m in existing_memberships if m["person_id"] == person["id"]), None
        )
        if existing_membership:
            membership_fields = _merge_fields(existing_membership, membership_fields)
            _supabase_request(
                "PATCH", "memberships", params={"id": f"eq.{existing_membership['id']}"},
                body=membership_fields,
            )
        else:
            _supabase_request("POST", "memberships", body=membership_fields)

        saved_people.append({**person, "title": membership_fields.get("title"), "focus": membership_fields.get("focus")})

    return {"organization": org, "people": saved_people}


def _list_organizations() -> list:
    return _supabase_request(
        "GET", "organizations",
        params={"select": "id,name,org_type,website_url,linkedin_url,hq_country,updated_at", "order": "name.asc"},
    )


def _get_organization(org_id: str) -> dict:
    orgs = _supabase_request("GET", "organizations", params={"id": f"eq.{org_id}", "select": "*"})
    if not orgs:
        return None
    org = orgs[0]
    memberships = _supabase_request(
        "GET", "memberships",
        params={
            "organization_id": f"eq.{org_id}",
            "select": "id,title,focus,is_current,people(id,full_name,linkedin_url,country)",
        },
    )
    org["people"] = memberships
    return org


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _send(self, code: int, ctype: str, body: bytes):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code: int, obj):
        self._send(code, "application/json", json.dumps(obj).encode())

    def do_GET(self):
        if self.path == "/":
            self._send(200, "text/html", HTML_FILE.read_bytes())
        elif self.path == "/api/config":
            self._send_json(200, {
                "supabase_configured": _supabase_configured(),
                "anthropic_configured": bool(os.environ.get("ANTHROPIC_API_KEY")),
            })
        elif self.path == "/api/organizations":
            self._require_supabase(lambda: self._send_json(200, _list_organizations()))
        elif self.path.startswith("/api/organizations/"):
            org_id = self.path[len("/api/organizations/"):]
            self._require_supabase(lambda: self._get_org_route(org_id))
        else:
            self._send(404, "text/plain", b"not found")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        if self.path == "/api/research":
            self._research_route(body)
        elif self.path == "/api/organizations":
            self._require_supabase(lambda: self._save_route(body))
        else:
            self._send(404, "text/plain", b"not found")

    def do_DELETE(self):
        if self.path.startswith("/api/organizations/"):
            org_id = self.path[len("/api/organizations/"):]
            self._require_supabase(lambda: self._delete_route(org_id))
        else:
            self._send(404, "text/plain", b"not found")

    def _require_supabase(self, fn):
        if not _supabase_configured():
            self._send_json(503, {"error": "Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY missing)."})
            return
        try:
            fn()
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _research_route(self, body: dict):
        name = (body.get("name") or "").strip()
        org_type = body.get("org_type") or "vc"
        if not name:
            self._send_json(400, {"error": "name is required"})
            return
        if not os.environ.get("ANTHROPIC_API_KEY"):
            self._send_json(503, {"error": "ANTHROPIC_API_KEY is not configured."})
            return
        try:
            result = _research_organization(name, org_type)
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})
            return
        self._send_json(200, result)

    def _save_route(self, body: dict):
        try:
            result = _save_organization(body)
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        self._send_json(200, result)

    def _get_org_route(self, org_id: str):
        org = _get_organization(org_id)
        if org is None:
            self._send_json(404, {"error": "organization not found"})
            return
        self._send_json(200, org)

    def _delete_route(self, org_id: str):
        _supabase_request("DELETE", "organizations", params={"id": f"eq.{org_id}"})
        self._send_json(200, {"ok": True})


def main():
    _load_dotenv()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Warning: ANTHROPIC_API_KEY is not set.")
        print("  export ANTHROPIC_API_KEY=your-key-here, or add it to a local .env file")
    if not _supabase_configured():
        print("Warning: SUPABASE_URL / SUPABASE_SERVICE_KEY are not set.")
        print("  research will still work, but saving/browsing the database will not")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"Serving at {url}", flush=True)
    if not os.environ.get("GRAPH_APP_NO_BROWSER"):
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
