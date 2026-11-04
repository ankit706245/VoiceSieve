# Braivex Vaani

A Supabase-backed AI voice CRM for excavator buyers, sellers and machine inventory.

## Surfaces

| URL | What it is |
| --- | --- |
| `/` | Marketing site |
| `/braivex-login.html` | Sign in / create account |
| `/app.html` | Opens the CRM (auth gated) |
| `/vaani-sales.html` | The CRM itself (auth gated) |

`/app.html` and `/vaani-sales.html` require a valid Supabase session. The server
checks the `braivex_token` HttpOnly cookie (or a bearer token for API clients)
before serving the page. Tokens are never accepted from the query string.

## Stack

- Node 18+ with no web framework.
- Supabase Auth for accounts.
- Supabase Postgres for every business row.
- One `pg` dependency for the database pool.
- Static HTML/CSS/JS in `public/`. No build step.

There is no local JSON database, no SQLite, and no Docker fallback.

## Setup

```sh
sh setup.sh
```

Fill in `.env`:

```sh
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=...
VAANI_DATABASE_URL=postgresql://...
VAANI_INGESTION_SECRET=...
```

Start:

```sh
node server.js
```

Default port is `8787`.

## Signup and login

1. Signup calls Supabase Auth, then creates one isolated organization, one
   default `Vaani Sales` workflow, and one `vaani_user_profiles` mapping.
2. Login exchanges email and password for a Supabase access token.
3. The token is set as an HttpOnly cookie; the browser never stores it in
   JavaScript-accessible storage or the URL.
4. Every CRM query is scoped to the caller's `organization_id`. A user can
   never read another organization's rows.

## API

Public:

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/session` (exchange an email-link token for the cookie)
- `POST /api/auth/logout`
- `GET /api/health`

Authenticated (bearer token or cookie):

- `GET /api/me`
- `GET /api/vaani/sales/overview`
- `GET /api/vaani/sales/sellers`
- `GET /api/vaani/sales/buyers`
- `GET /api/vaani/sales/machines`
- `GET /api/vaani/sales/demand`
- `GET /api/vaani/sales/follow-ups`
- `GET /api/vaani/sales/calls`
- `GET /api/vaani/sales/dnc`
- `GET /api/vaani/sales/activities`
- `GET /api/vaani/sales/search`
- `GET /api/vaani/sales/leads/:id`
- `POST /api/vaani/sales/entries`
- `POST /api/vaani/sales/import`
- `POST /api/vaani/sales/follow-up/status`

Service-to-service:

- `POST /api/v1/vaani/calls/complete`
- `POST /api/v1/vaani/extract`
- `POST /api/v1/vaani/whatsapp/webhook`

## Data model

Auth lives in `auth.users` and `auth.identities` (Supabase managed).

Application tables:

- `organizations`: one row per customer workspace.
- `workflows`: the Vaani workflow owned by an organization.
- `workflow_runs`: one row per call or manual lead.
- `vaani_user_profiles`: Supabase user to organization mapping.
- `vaani_customers`: customer records.
- `vaani_calls`: call lifecycle and outcome.
- `vaani_transcripts`: call transcript segments.
- `vaani_call_summaries`: per-call summaries.
- `vaani_machines`: machine inventory.
- `vaani_buyer_machine_matches`: buyer to machine matches.
- `vaani_digital_evidence`: photos, videos and documents promised by sellers.
- `vaani_follow_up_tasks`: persistent follow-up tasks.
- `vaani_whatsapp_messages` / `vaani_whatsapp_inbound_events`: WhatsApp history.
- `vaani_dnc_registry`: do-not-call numbers.
- `vaani_excavator_sales_leads`: read-only view over `workflow_runs` + `workflows`.
- `vaani_customer_leads`: read-only customer view.

Manual buyers and sellers are `workflow_runs` rows with `mode = 'manual'`.
The CRM reads them through `vaani_excavator_sales_leads`.

## Tests

```sh
npm test
```

Auth, redirect, session and CRM add/import suites are the release gate.

## Security

- Supabase anon key and database URL stay server side.
- Passwords are never stored by this app.
- The access token is stored only in an HttpOnly cookie. The password is never
  stored, and the token never appears in the URL or web storage.
- Every write validates `organization_id` before touching the database.
- Ingestion webhooks fail closed without `VAANI_INGESTION_SECRET`.
