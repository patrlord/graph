# graph

Database of VCs, CVCs, business angels, and family offices — their team members and the connections between them.

Live at **https://patrlord.github.io/graph/**, gated behind Supabase Auth (single allowed account).

## Structure

- `index.html` — the whole frontend (static, served by GitHub Pages).
- `supabase/functions/graph-api/` — the backend (Supabase Edge Function). Research/news use OpenRouter (`openai/gpt-5-nano` + one grounded web search per call, not an agentic search loop); Apollo's free `organizations/enrich` backfills whatever OpenRouter didn't find; the person detail pane's "Fetch LinkedIn profile" button runs Apify's LinkedIn Profile Scraper actor (`LpVuK3Zozwuipa5bp`) against a known LinkedIn URL for the richer `li_*` profile fields (experience, education, skills, etc.).
- `schema.sql`, then `migration_002_*.sql` through `migration_005_*.sql` — run once each in the Supabase SQL Editor, in order.

## Deploying a change to the Edge Function

```bash
supabase functions deploy graph-api --project-ref chfqbznodqapxjcqzupj
```

## Secrets (Supabase function secrets, not in this repo)

`OPENROUTER_API_KEY`, `APOLLO_API_KEY`, `APIFY_API_TOKEN`, `ALLOWED_EMAIL` — set via:

```bash
supabase secrets set --project-ref chfqbznodqapxjcqzupj --env-file .env
```

(`.env` is a local, gitignored scratch file — see `.env.example`.)
