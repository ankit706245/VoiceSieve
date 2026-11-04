# Braivex Vaani. Repo guide for future sessions.

## What this is

A Supabase-backed AI voice CRM for excavator buyers, sellers and inventory.
Marketing page, login page, and a sales command center.

## Current architecture

- `server.js`: auth, CRM API, Vaani ingestion webhooks, static files.
- `lib/core.js`: env loader, HTTP helpers, Supabase bearer/cookie session,
  rate limit, static server.
- `lib/braivex-auth.js`: Supabase signup, password grant, token verification,
  organization mapping, per-signup workspace provisioning.
- `lib/vaani-sales.js`: all CRM reads and writes.
- `lib/vaani-tasks.js`: persistent follow-up tasks.
- `lib/vaani-whatsapp.js`: WhatsApp dry-run and inbound handling.
- `lib/vaani-extractor.js` and `lib/vaani-llm-extractor.js`: transcript
  extraction.
- `lib/supadb.js`: the only database transport. Supabase Postgres only.
- `public/index.html`: marketing.
- `public/braivex-login.html`: sign in and signup.
- `public/app.html`: auth-gated CRM entry.
- `public/vaani-sales.html`: CRM UI.
- `data/fixtures/demo-sales-data.json`: demo mode fixture only.

## Rules

- Supabase is the only auth and data store. Do not add db.json, SQLite, or a
  Docker database fallback.
- Every query and write must be scoped by `organization_id`.
- New signup = new organization + new `Vaani Sales` workflow + profile mapping.
- Never hardcode organization 1.
- Do not add RapidX branding. The brand is Braivex Vaani.
- Keep the browser free of secrets. Supabase keys stay server side.

## Auth flow

1. `POST /api/auth/signup` creates the Supabase user, then provisions the
   organization and workflow in one CTE.
2. `POST /api/auth/login` exchanges email and password for a Supabase token.
3. The token is set as the `braivex_token` HttpOnly cookie and returned in the
   JSON body for API calls.
4. `/app.html` and `/vaani-sales.html` are gated by `core.getSession`, which
   accepts the cookie, a bearer token, or `?access_token=`.
5. `sessionStorage` holds the token for API calls. The password is never stored.

## Database

Application tables are listed in `README.md`. The important join is:

`auth.users.id` -> `vaani_user_profiles.supabase_user_id` ->
`vaani_user_profiles.organization_id` -> `workflows.organization_id` ->
`workflow_runs.workflow_id`.

## Commands

```sh
node server.js          # start
npm test                # test suite
sh setup.sh             # first-run setup
```
