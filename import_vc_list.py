"""
One-off importer for VC_List.xlsx -> Supabase.

Expects columns: VC Name, Website, Key People, Location.
"Key People" is a comma-separated list of names, sometimes ending in a
"(+N more)" suffix (the source truncated the list) - that suffix is
stripped, and it just means N additional team members weren't captured.

Run: python3 import_vc_list.py /path/to/VC_List.xlsx
"""

import re
import sys

import openpyxl

import graph_app as app

MORE_SUFFIX_RE = re.compile(r"\s*\(\+\d+\s+more\)\s*$")


def _normalize_website(url: str):
    url = (url or "").strip()
    if not url:
        return None
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = "https://" + url
    return url


def _parse_people(raw: str):
    if not raw or not raw.strip():
        return [], 0
    cleaned = raw.strip()
    more_count = 0
    match = re.search(r"\(\+(\d+)\s+more\)\s*$", cleaned)
    if match:
        more_count = int(match.group(1))
        cleaned = MORE_SUFFIX_RE.sub("", cleaned)
    names = [n.strip() for n in cleaned.split(",") if n.strip()]
    return names, more_count


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "VC_List.xlsx"
    app._load_dotenv()
    if not app._supabase_configured():
        print("Supabase is not configured (check .env).")
        sys.exit(1)

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    print(f"Loaded {len(rows)} rows from {path}")

    total_people = 0
    total_truncated = 0
    errors = []

    for i, row in enumerate(rows, start=2):
        name, website, key_people, location = (row + (None, None, None, None))[:4]
        name = (name or "").strip()
        if not name:
            continue
        names, more_count = _parse_people(key_people)
        total_people += len(names)
        total_truncated += more_count

        payload = {
            "organization": {
                "name": name,
                "org_type": "vc",
                "website_url": _normalize_website(website),
                "linkedin_url": None,
                "hq_country": (location or "").strip() or None,
                "description": None,
            },
            "people": [
                {"full_name": n, "title": None, "focus": None, "country": None, "linkedin_url": None}
                for n in names
            ],
        }
        try:
            app._save_organization(payload)
            print(f"[{i}/{len(rows)+1}] Saved {name} ({len(names)} people)")
        except Exception as exc:
            print(f"[{i}/{len(rows)+1}] FAILED {name}: {exc}")
            errors.append((name, str(exc)))

    print("\nDone.")
    print(f"Organizations processed: {len(rows)}")
    print(f"People saved: {total_people}")
    print(f"Additional team members not listed in source (truncated '+N more'): {total_truncated}")
    if errors:
        print(f"Errors ({len(errors)}):")
        for name, err in errors:
            print(f"  - {name}: {err}")


if __name__ == "__main__":
    main()
