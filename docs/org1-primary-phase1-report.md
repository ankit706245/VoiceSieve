# Org 1 Primary: Phase 1 Report

Date: 2026-10-24
Status: Org 1 Phase 1 is applied for authentication, shadow tenant, dashboard code, and tests. The Supabase cutover is prepared and staging-tested; it is on hold pending explicit approval, and no production changes have been made. Historical records were not deleted, moved, or re-owned.

## Scope and constraints

Make Org 1 the single primary organization for Vaani while preserving Org 2 and every historical user, workflow, run, call, transcript, lead, buyer, seller, and machine record.

Constraints followed:

- Organization is resolved server-side from authenticated membership, never from request parameters.
- Org 2 remains legacy/audit data. It was not deleted or disabled.
- No historical ownership or `organization_id` values were changed.
- No bulk moves, duplicate records, or live-data fixtures were created.
- No PSTN call, WhatsApp message, or external side effect was triggered.
- The live-write dashboard suite was run only against the local test database with `VAANI_DATABASE_URL` unset; it was not run against Supabase.

## Data sources

Two separate PostgreSQL clusters remain in use.

| Surface | Database | Org 1 observed | Org 2 observed |
| --- | --- | --- | --- |
| Dashboard | Supabase session pooler | 293 Workflow 3 runs/legacy leads, 106 calls, 173 transcripts, 75 sales buyers, 40 legacy customers | 2 buyer leads, 2 Workflow 4 runs |
| Dograh API | local `dograh-local-postgres-1` | 207 runs/leads, 59 calls, 74 transcripts | 0 leads, 0 Workflow 4 runs |

The clusters are not synchronized copies. No merge or backfill is proposed without a separate approved migration.

## Final organization state

### Dashboard authentication

- Active Supabase auth user prefix: `f37e075c`.
- Active auth-linked `public.vaani_user_profiles` row now maps to `organization_id = 1`.
- Stale profile prefix `4e00b674` remains on `organization_id = 2`; it has no matching `auth.users` row.
- Migration backup table `public.vaani_user_profiles_org1_backup_20261024` contains 1 row.
- The active auth email and dashboard `public.users` email still differ by one digit. The verified profile mapping remains the reliable link; email-only joins are unsafe.

### Local shadow tenant

- Active BRAIVEX shadow tenant `t_4aa47d40c5b3b88e` now maps to `organization_id = 1`.
- Shadow user `u_b2cd57d97e01967a` and 5 existing sessions remain bound to that tenant.
- Backup before the tenant change: `dashboard/data/db.json.bak-org1-2026-10-24T09-07-58-139Z`.

### Dograh backend

- Both local Dograh users have `selected_organization_id = 1`.
- Workflows 1, 2, and 3 belong to Org 1. Workflow 4 belongs to Org 2.
- Workflow 3 is active in Org 1 and remains the intended Vaani workflow.
- Runtime definition 6 version 3 and dashboard definition 9 version 4 are published with Vaani content.
- The Dograh UI follows the backend selected organization; both local users resolve Org 1.

## Applied changes

### `dashboard/lib/vaani-sales.js`

- Added `preferredWorkflowId()`: defaults to Workflow 3, with `VAANI_WORKFLOW_ID` / `DOGRAH_WORKFLOW_ID` override.
- Added `resolveOrgWorkflowId()`: uses the preferred workflow only when it is active and owned by the authenticated organization; otherwise falls back to that organization's first active workflow; never returns another organization's workflow.
- `addLead()` now resolves the organization-owned workflow instead of selecting the first active workflow.
- Manual lead duplicate checks remain organization-scoped.
- `buildManualLeadInsert()` casts `$3::jsonb`, fixing the Postgres parameter-type error.
- `createCallSession()` no longer defaults to Workflow 3.
- `getOverview().connected_calls` now counts only the preferred Vaani workflow.
- `ingestCallComplete()` now requires `workflow_id`, resolves the workflow's organization, and rejects run-context or relay organization mismatches.

### `dashboard/server.js`

- Added `primaryOrganizationId()` with `VAANI_PRIMARY_ORG_ID` defaulting to 1.
- Buyer and seller outbound routes are primary-organization-only. The buyer route resolves the org-owned workflow and uses it for pre-create.
- Existing-customer lookups and the `/api/vaani/buyers/:id/call` prefetch now prove organization ownership through the call-to-workflow chain.
- Simulation and demo paths use the resolved workflow instead of hardcoded Workflow 3.
- `_dispatchDograhCall()` uses `preferredWorkflowId()`.
- Legacy customer, call, and buyer list/detail routes are organization-scoped.
- Legacy customer creation and legacy demo ingestion are primary-organization-only.
- `queryVaaniLeads` filters counts and interactions to the preferred Vaani workflow.
- Fixed the customer list `ORDER BY t.created_at` by selecting `c.created_at`.
- Customer detail calls and call detail transcripts now use `json_agg`; `queryPostgres` otherwise returns only the first JSON row.
- Cross-org detail checks now fail with 404 for customer/buyer identity and 403 for call transcripts/summary.

### Dograh code (prepared, not deployed)

- `dograh/api/services/workflow/initial_context.py`: reserves `organization_id` so public embed callers cannot inject or replace it.
- `dograh/api/tasks/vaani_relay.py`: uses the workflow's organization as authoritative. A conflicting legacy/context organization causes the relay to skip rather than re-home the run.
- `dograh/api/tests/test_initial_context.py`: covers reserved `organization_id`.
- `dograh/api/tests/test_vaani_relay.py`: covers workflow-org authority, conflicting-context rejection, and dashboard source lookup from either repo layout.

### Database and local runtime

- Applied `migrations/005_vaani_org1_primary_mapping.sql` after a dry run with `ROLLBACK`.
- Updated the local shadow tenant to Org 1 with a file backup.
- Restarted the local dashboard after code review. Current PID: `20728`. `/` returns 200; `/api/me` returns 401 without a session, as expected.

## Route inventory and final status

### Dashboard auth and identity

| Route | Organization source | Final status |
| --- | --- | --- |
| `POST /api/auth/braivex/login` | Supabase identity plus `vaani_user_profiles` | Active profile maps Org 1 |
| `POST /api/auth/login` | Legacy local user and tenant | Not the Vaani primary flow |
| `GET /api/me` | Session tenant | Shadow tenant is Org 1 |
| `POST /api/auth/logout` | Session | No organization impact |

### Vaani sales reads

| Route | Organization source | Final status |
| --- | --- | --- |
| `GET /api/vaani/sales/overview` | Bearer mapping or session tenant | Org-scoped; connected calls filtered to Workflow 3 |
| `GET /api/vaani/sales/buyers` | Bearer mapping or session tenant | Org-scoped; bearer and cookie paths agree |
| `GET /api/vaani/sales/pipeline` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/sellers` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/machines` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/demand` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/follow-ups` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/tasks` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/calls` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/calls/:id` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/leads/:id` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/leads/:id/timeline` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/leads/:id/evidence` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/leads/:id/whatsapp` | Session tenant | Org-scoped, dry-run only |
| `GET /api/vaani/sales/activities` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/dnc` | Session tenant | Org-scoped |
| `GET /api/vaani/sales/search` | Session tenant | Org-scoped |

### Vaani sales writes

| Route | Organization source | Final status |
| --- | --- | --- |
| `POST /api/vaani/sales/buyers` | Session tenant | Uses resolved org-owned workflow |
| `POST /api/vaani/sales/sellers` | Session tenant | Uses resolved org-owned workflow |
| `POST /api/vaani/sales/machines` | Session tenant | Org-scoped |
| `POST /api/vaani/import/buyers` | Session tenant | Uses lead insert path |
| `POST /api/vaani/import/sellers` | Session tenant | Uses lead insert path |
| `POST /api/vaani/import/machines` | Session tenant | Org-scoped |
| `POST /api/vaani/sales/outbound/buyer` | Session tenant | Primary-only; resolved Workflow 3; org-owned pre-create |
| `POST /api/vaani/sales/outbound/seller` | Session tenant | Primary-only |
| `POST /api/vaani/sales/calls/:id/status` | Session tenant plus run chain | Org-scoped |
| `POST /api/vaani/sales/follow-up/status` | Session tenant | Org-scoped |
| `POST /api/vaani/sales/tasks/transition` | Session tenant | Org-scoped |
| `POST /api/vaani/sales/evidence/request` | Session tenant | Org-scoped |
| `POST /api/vaani/sales/evidence/received` | Session tenant | Org-scoped |
| `POST /api/vaani/sales/simulate-call` | Session tenant | Uses resolved org-owned workflow |
| `POST /api/vaani/sales/simulate-inbound-media` | Session tenant | Org-scoped |
| `POST /api/vaani/sales/whatsapp/demo-send` | Session tenant | Dry run only |
| `POST /api/vaani/sales/whatsapp/demo-reply` | Session tenant | Dry run only |
| `POST /api/vaani/sales/cleanup-simulations` | Session tenant plus super admin | Destructive; not changed |

### Legacy Vaani routes

| Route | Organization source | Final status |
| --- | --- | --- |
| `GET /api/vaani/customers` | Session tenant plus call/run chain | Org-scoped |
| `GET /api/vaani/customers/:id` | Session tenant plus call/run chain | Org-scoped; calls array fixed |
| `POST /api/vaani/customers` | Session tenant | Primary-only |
| `GET /api/vaani/calls` | Session tenant plus call/run chain | Org-scoped |
| `GET /api/vaani/calls/:id` | Run chain | Org-scoped; transcripts array fixed |
| `GET /api/vaani/leads` | Session tenant | Filtered to preferred Workflow 3 |
| `GET /api/vaani/buyers` | Session tenant plus call/run chain | Org-scoped |
| `GET /api/vaani/buyers/:id` | Session tenant plus call/run chain | Customer identity checked before return |
| `GET /api/vaani/buyers/:id/calls/:id` | Run chain | Org-scoped |
| `POST /api/vaani/buyers/:id/call` | Session tenant plus org-scoped prefetch | Org-scoped, then primary-only outbound |
| `POST /api/vaani/demo/calls/complete` | Session tenant | Primary-only |
| `GET /api/vaani/internal/machines` | Internal secret plus buyer run | Scoped |

### Ingestion and integrations

| Route or task | Organization source | Final status |
| --- | --- | --- |
| `POST /api/v1/vaani/calls/complete` | Ingestion secret plus workflow row | Requires workflow_id; workflow org authoritative |
| `POST /api/vaani/calls/complete` | Ingestion secret plus workflow row | Same |
| `POST /api/v1/vaani/extract` | Ingestion secret | No organization data |
| `api/tasks/vaani_relay.py` | Workflow organization | Code uses workflow org; not deployed |
| `api/tasks/workflow_completion.py` | Calls relay after completion | No direct organization logic |
| PayU webhook | Separate billing flow | Not part of Vaani organization resolution |
| n8n | None found | No dependency |

## Service inventory and final status

| Service or file | Role | Final status |
| --- | --- | --- |
| `dashboard/lib/braivex-auth.js` | Supabase token verification and profile mapping | No-fallback design; active profile maps Org 1 |
| `dashboard/server.js` | Auth, route dispatch, outbound, legacy routes | Primary guards, org scoping, resolved workflow, array fixes |
| `dashboard/lib/vaani-sales.js` | Vaani queries and ingestion | Preferred workflow resolver, org-scoped lead writes, workflow-org ingestion |
| `dashboard/public/vaani-sales.html` | Vaani UI | Uses cookie auth for most sections and bearer for Overview/Buyers; both now resolve Org 1 |
| `dashboard/lib/supadb.js` | Supabase transport | Dashboard-only; separate from Dograh API database |
| `dashboard/data/db.json` | Local shadow tenants and sessions | Active BRAIVEX tenant maps Org 1 |
| `dograh/api/services/auth/depends.py` | User and organization resolution | Uses `selected_organization_id`; no request override |
| `dograh/api/routes/workflow.py` | Workflow CRUD and runs | Organization scoped |
| `dograh/api/tasks/vaani_relay.py` | Post-call relay | Workflow-org authoritative in code; deployment pending |
| `dograh/api/services/workflow/initial_context.py` | Reserved context keys | `organization_id` reserved in code; deployment pending |
| `dograh/api/routes/public_embed.py` | Public embed sessions | Binds run organization from token; injection blocked once deployed |
| `dograh/ui/src` | Dograh console | No organization switcher; follows backend Org 1 selection |

## Verification and tests

### Dashboard

- 126 tests passed across 14 read-only/mocked files, 0 failures.
- The run excludes `dashboard/test/vaani-sales-dashboard.test.js`, which writes live data.
- Covered: BRAIVEX auth, no org fallback, org-scoped Overview/Buyers, session refresh, legacy customer/call/buyer routes, primary write guards, outbound primary-only behavior, Workflow 3 resolution, ingestion classification, callback integration, SQL parameterization, and manual lead zero-write checks.

### Dograh

- 9 relay tests passed in a disposable container using the edited source and a dummy database URL. No running service was rebuilt or restarted.
- `initial_context` assertions passed for reserved `organization_id` and retained non-reserved context.
- Relay tests cover workflow-org authority, conflicting-context rejection, idempotent payload/run ID, retries, and source-level dashboard lookup.

### Live read-only checks

- No browser session cookie was available in the workspace. Cookie-path checks used the real handlers with a synthetic `ctx.tenant.organization_id = 1` against the live database. The active shadow tenant and its 5 sessions are Org 1, so the actual session resolves the same context.
- Bearer and cookie paths agree for the sales endpoints:
  - Overview: 192 distinct leads, 293 connected calls.
  - Buyers: 75.
- Legacy cookie paths: 40 customers, 54 calls.
- Org 1 customer detail: 200 with calls. Org 2 detail: 404.
- Org 1 call 131 detail: 200 with 19 transcripts and summary. Org 2: 403.
- Outbound existing-customer query: Org 1 found, Org 2 not found.
- Legacy leads: Org 1 293 interactions, Org 2 0 because the count is restricted to Workflow 3.

## Rollback

### Profile mapping

Restore the active auth-linked profile from the backup table:

```sql
BEGIN;
UPDATE public.vaani_user_profiles p
   SET organization_id = b.organization_id,
       updated_at = CURRENT_TIMESTAMP
  FROM public.vaani_user_profiles_org1_backup_20261024 b
 WHERE p.supabase_user_id = b.supabase_user_id;
COMMIT;
```

### Local shadow tenant

Set tenant `t_4aa47d40c5b3b88e` back to `organization_id = 2`. Do not restore the entire `db.json` backup if newer sessions have been created; edit only the tenant mapping. The pre-change file backup is `dashboard/data/db.json.bak-org1-2026-10-24T09-07-58-139Z`.

### Code and runtime

- Revert the specific dashboard and Dograh edits. No schema change is required for the code paths.
- Restart the local dashboard after a code rollback. Current PID: `20728`.
- Dograh changes are not live. If they are later deployed, roll back the image to the prior tag and recreate the API/UI containers.

## Blockers and open items

1. Dograh API/UI deployment is pending approval. The containers use baked images with no bind mounts. The relay and reserved-context changes are not live until a reviewed rebuild/recreate.
2. Dashboard Supabase and Dograh local Postgres contain different counts. No canonical source or sync path is approved.
3. The active auth email differs from dashboard `public.users` by one digit. The profile mapping remains the only reliable link.
4. Org 2 manual lead writes are still technically possible under Workflow 4 if an Org 2 session were created. No auth user currently maps to Org 2, so it is not reachable through the active login. A follow-up can make all manual/import Vaani writes primary-only.
5. Legacy demo endpoints still write unscoped rows, but they are now primary-only. Full org-column scoping or retirement remains a separate decision.
6. Pre-existing `getLead360` error for run `1000039`: `cannot pass more than 100 arguments to a function`. This was not introduced by the Org 1 changes and needs a separate fix.
7. `dashboard/test/vaani-sales-dashboard.test.js` remains unsafe to run against live data.

## Final alignment status

| Area | Status |
| --- | --- |
| Auth mapping | Org 1 primary; stale Org 2 profile retained without an auth user |
| Shadow tenant | Org 1; existing sessions retained |
| Dashboard reads | Org 1; bearer and cookie sales paths agree |
| Dashboard writes | Org 1 for manual leads, outbound, simulations, and legacy demo routes; Org 2 manual write residual documented |
| Workflow selection | Workflow 3 preferred for Org 1; org-owned fallback only |
| Outbound voice | Primary-organization-only; resolved Workflow 3 |
| Ingestion | Workflow organization authoritative; mismatches rejected |
| Legacy customer/call/buyer routes | Org-scoped; cross-org detail access blocked |
| Dograh backend code | Prepared; deployment pending approval |
| Dograh UI | Follows backend Org 1 selection; no code change needed |
| Org 2 historical data | Preserved; not deleted, moved, or re-owned |
| Historical records | Unchanged |
| External side effects | None triggered during testing |

## Supabase cutover readiness (2026-10-24)

Status: prepared and staging-tested. No production migration, token update, API recreate, or dashboard restart has been executed. The production Supabase database and the running services are unchanged.

### Target and schema

- Target: Supabase session pooler `aws-0-ap-northeast-1.pooler.supabase.com:5432`, database `postgres`, PostgreSQL 17.6, `max_connections=60`.
- Supabase `public` has 42 base tables: 29 Dograh/Alembic tables plus 13 Vaani tables.
- The 28 Dograh application tables are structurally identical to local at Alembic `f3a1c47b9e02`; the comparison found 0 schema differences.
- Supabase data: 2 organizations, 2 users, 4 workflows, 8 workflow definitions, 299 workflow runs, 33 text sessions, 1 embed token, 59 embed sessions, 2 tools.
- Local Dograh data: 2 organizations, 2 users, 4 workflows, 7 definitions, 211 runs, 18 text sessions, 1 embed token, 21 embed sessions.
- Workflow 3 (`Vaani AI Used Excavator Sales`) belongs to Org 1. Its `released_definition_id` is 9 in Supabase and 6 locally. Org 1 owns 297 of the 299 Supabase runs; Org 2 owns 2.
- No historical Supabase rows were copied from local, and no historical rows were deleted or re-owned.

### Prepared code and configuration

- `dograh/api/db_engine_config.py`: shared asyncpg TLS, pool, recycle, timeout, and statement-cache configuration.
- `dograh/api/db/base_client.py`, `dograh/api/db/database.py`, and `dograh/api/alembic/env.py` use the shared connect arguments.
- `dograh/docker-compose.supabase.yaml`: `DOGRAH_DB_SSL=verify-full`, `DOGRAH_DB_SSLROOTCERT=/app/api/certs/supabase-pooler-ca.pem`, pool 1 + overflow 1, and image override `local/dograh-api:supabase-prod-20261024`.
- CA: `dograh/api/certs/supabase-pooler-ca.pem` and `dashboard/certs/supabase-pooler-ca.pem`. This is the public Supabase Root 2021 CA, valid to 2031-04-26. It is not a secret.
- `dashboard/lib/supadb.js`: TLS with `rejectUnauthorized: true` for `*.pooler.supabase.com`; fails closed if the CA is unreadable; pool max 3.
- `dashboard/lib/vaani-sales.js`: fixed the `runStartedAtSql` double-quote bug (`''...''::timestamptz` became `'...'::timestamptz`). Without this, any completed call carrying a start time would fail ingestion.
- Final image `local/dograh-api:supabase-prod-20261024` includes the CA, the shared DB config, the relay/retry code, and the pipecat `langfuse_helpers` helper. The import check passed.
- Test updates: Org 1 outbound context, bearer-only Overview/Buyers, `DASHBOARD_TEST_URL`, Org 1 call-detail ownership assertion, and the `resolveOrgWorkflowId` stub.

### Verification completed

- Staging database `dograh_staging_20261024` was migrated from zero to `3a7b91c5d402`, downgraded to `f3a1c47b9e02`, seeded with representative Supabase rows, and upgraded through all three pending migrations.
- Migration effects with data: `c4e21b7f80a9` affected 0 workflow/definition rows; `6d7b40a9c2e1` added `queued_runs.claimed_at` and preserved the seeded row; `3a7b91c5d402` added `transfer_agent` and preserved both tools rows.
- Staging API with the new image: `POST /api/v1/public/embed/init` returned 200. The run was 1, workflow 3, Org 1, definition 9, `smallwebrtc`, `inbound`, state `initialized`. `initial_context` carried source, tenant, agent, demo, max-session, customer, phone, buyer/seller classification, intent, origin, machine, budget, city, and lead fields; reserved `organization_id` was absent. The embed session token was 55 characters and token usage incremented to 1.
- Final image `BaseDBClient` with `verify-full` read Supabase: 4 workflows, 299 runs, 2 organizations, 2 tools. `pg_stat_ssl=false` is expected through the pooler; the client-side TLS handshake and CA/hostname verification succeeded. The protected deployment env file was also used for a successful read.
- Node `pg` with `rejectUnauthorized: true` and `dashboard/lib/supadb.js` read `f3a1c47b9e02|4|299|2`.
- Dashboard suite: 631 tests, 621 pass, 0 fail, 10 skipped, using `VAANI_DATABASE_URL=` and `DASHBOARD_TEST_URL=http://localhost:8788`. The suite ran against the local test database, not Supabase. The temporary 8788 server was stopped.
- The suite writes fixed test run IDs `999901`-`999912` and `999999`. Clean those rows before a rerun; the suite is not idempotent by itself.
- No PSTN call, WhatsApp message, or production migration was triggered.

### Current production state (unchanged)

- Supabase is still at `f3a1c47b9e02`; the three migrations are pending. `queued_runs.claimed_at` is absent and `tool_category` lacks `transfer_agent`.
- `embed_tokens` id 1 (workflow 3, Org 1, active, usage 60) expires at `2026-10-22T17:06:55.529168Z`. New embed init is rejected with `403 Embed token has expired`.
- `dograh-local-api-1` is healthy on `127.0.0.1:8000` but still uses `local/dograh-api:rumik-v1-p41-groq-retry-fixed` and the local Postgres. It lacks the new relay/reserved-context code.
- The dashboard process is PID 20728 on `127.0.0.1:8787`, started as `node server.js`. It has the old in-memory `vaani-sales.js` and non-TLS `supadb.js`. The `.dashboard.pid` file is stale (`27808`), so `run-dashboard.sh stop` cannot stop 20728. The restart must stop 20728 directly and remove the stale pidfile.
- The dashboard `.env` does not contain `VAANI_INGESTION_SECRET`, but `core.loadEnv` also loads the main repo `.env`, which does contain it and matches the live API container. The current dashboard accepts an authenticated empty POST from the API container to `/api/v1/vaani/calls/complete` (400 `missing_primary_phone`, not 401). A restart from `run-dashboard.sh` reloads the main `.env`, so no copy is required; adding the key to `dashboard/.env` is optional self-containment. `DOGRAH_EMBED_TOKEN` is also in the main `.env`; its hash matches both the live API container and the Supabase `embed_tokens` row, so clearing that row's expiry is sufficient. The dashboard's `VAANI_INTERNAL_API_SECRET` is a different value and is not accepted by `verifyIngestionAuth`. The API container's `VAANI_ENDPOINT_URL` is unset, so the relay uses the verified default `http://host.docker.internal:8787/api/v1/vaani/calls/complete`; the API container reaches the dashboard health endpoint with HTTP 200.
- Security note: a local grep during this audit displayed the dashboard's `VAANI_INTERNAL_API_SECRET` value. It is not the Supabase password and is not consumed by the Dograh API. Rotate it before or during the dashboard restart: generate a new random value, update `dashboard/.env` (mode 0600), restart, and verify the internal routes. No other secret values were printed.
- Supabase `campaigns` has 0 rows and `queued_runs` has 0 rows. Recreating the API's campaign orchestrator and ARI manager will not initiate a PSTN campaign.
- Session-pooler budget: 8 API clients (four DB-owning processes at 1 steady + 1 burst) plus 3 dashboard clients = 11 of 15.
- Pre-existing unrelated issue: `getLead360` for run `1000039` fails with `cannot pass more than 100 arguments to a function`.

### Exact production plan (requires approval)

Preflight and backup:

1. Use two protected files, both mode 0600: `dograh-prod-20261024.env` (seven live service credentials: the five infrastructure credentials plus the two Vaani service secrets, Supabase asyncpg `DATABASE_URL`, and the image tag) and `dograh-prod-rollback-20261024.env` (the same seven credentials, the old local `DATABASE_URL`, and the old image tag). No secret values are printed.
2. Back up `workflows.workflow_configurations` and `workflow_definitions.workflow_configurations` (4 + 8 rows, 0 affected by `c4e21`), plus `queued_runs` metadata (0 rows) and `tools` IDs/categories (2 `http_api` rows). Record the old token expiry; do not dump the token.
3. Confirm `alembic_version=f3a1c47b9e02`, 4 workflows, 8 definitions, 299 runs, 2 organizations, 2 tools, 0 queued runs, and 0 affected configs.

Apply migrations:

4. Run a one-off container with the new image and the protected env: `alembic -c /app/api/alembic.ini upgrade head`. Verify `alembic_version=3a7b91c5d402`, all counts unchanged, `claimed_at` present, `transfer_agent` present, both tools still `http_api`, and 0 workflow/definition rows rewritten.
5. Clear the expired token: `UPDATE public.embed_tokens SET expires_at=NULL, updated_at=now() WHERE id=1 AND workflow_id=3 AND organization_id=1 AND is_active=true;`. Verify `expires_at IS NULL`, the usage count is unchanged, and the token hash still matches the main `.env` and the live API container without printing either value.

Recreate only the API:

6. Run `docker compose -p dograh-local --env-file ../.env --env-file .env --env-file <prod-env> -f docker-compose.local-api.yaml -f docker-compose.supabase.yaml up -d --no-deps --force-recreate api`. This uses `local/dograh-api:supabase-prod-20261024`, `verify-full`, the CA, and the Supabase URL. It does not recreate Postgres, Redis, MinIO, or the UI.
7. Verify `/api/v1/health` returns 200, `DOGRAH_DB_SSL=verify-full`, the CA is present, pool 1/1 is active, the API logs show the Supabase connection without TLS/auth errors, and Alembic remains at head.

Restart the dashboard:

8. Before starting the dashboard, verify the main `.env` still supplies `DOGRAH_EMBED_TOKEN` and `VAANI_INGESTION_SECRET` and that they match the live API container; both checks already pass. Adding them to `dashboard/.env` is optional self-containment, not required. Then stop PID 20728, wait for 8787 to free, remove the stale `.dashboard.pid`, and run `PORT=8787 ./run-dashboard.sh start`. Verify `/api/health` returns 200, the startup log's Supabase digest reads succeed through the CA, and an authenticated empty POST from the API container to `/api/v1/vaani/calls/complete` returns 400 (auth passed) rather than 401. The new process uses the timestamp fix and the TLS transport.
9. Verify `dashboard/lib/supadb.js` still reads `3a7b91c5d402|4|299|2` and that Org 1 data is visible.

Non-PSTN acceptance test:

10. Call `POST /api/v1/public/embed/init` with the production token and a synthetic buyer context (test name and phone, no real customer). Verify the new run is Org 1 / workflow 3 / definition 9 / `smallwebrtc` / `inbound`, `initial_context` carries the CRM fields, `organization_id` is absent, and token usage increments. This creates a new Supabase run/session; it does not use PSTN or WhatsApp.
11. Post a synthetic completion payload to the production dashboard for that run, using the API container's `VAANI_INGESTION_SECRET` without printing it. Include a synthetic transcript, summary, buyer/seller classification, requirement, budget, location, and follow-up. Verify the Org 1 dashboard shows the lead, buyer/seller details, requirement, budget, location, follow-up, transcript, and summary. This writes labeled test rows to Supabase; clean them after verification. It does not use PSTN, WhatsApp, or TTS; the normal transcript extraction path may call Groq. Optionally, with separate approval, run a browser WebRTC call for an end-to-end voice test.
12. Clean up the test run/session and the staging database only after verification. Keep the backups and protected env files until sign-off.

### Rollback

- API startup failure: recreate the old image with the rollback env: `docker compose -p dograh-local --env-file ../.env --env-file .env --env-file <rollback-env> -f docker-compose.local-api.yaml up -d --no-deps --force-recreate api`. This restores `local/dograh-api:rumik-v1-p41-groq-retry-fixed` and the old local `DATABASE_URL`; Postgres, Redis, MinIO, and the UI are untouched.
- Schema rollback: run `alembic -c /app/api/alembic.ini downgrade f3a1c47b9e02` with the new image and Supabase env. `c4e21` downgrade is a no-op; restore the workflow/definition config backup if any row changed. `6d7b` drops `claimed_at` (table empty); `3a7b` removes `transfer_agent` (no tool uses it). Restore the token expiry to `2026-10-22T17:06:55.529168Z`.
- Dashboard failure: start the new process with `VAANI_DATABASE_URL=` and the local DB to keep the UI available while fixing TLS. The old non-TLS transport is not restored; the new transport was verified against Supabase.
- Historical rows: no rollback needed. The migrations do not delete or re-own them.

### Approval gate

No production migration, token update, API recreate, or dashboard restart has been executed. The user selected **Hold** on 2026-10-24. Approval of the plan above is required before proceeding. If any verification step fails, the cutover stops and the rollback above is used.
