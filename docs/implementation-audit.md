# Vaani Backend — Implementation Audit (Phase 0, read-only)

Date: 2026-09-30. Method: code inspection + read-only SELECTs. No production
writes, no migrations run, no messages/calls sent, no credentials exposed.
Uncommitted working-tree changes were preserved and are NOT part of this audit.

## 1. Existing architecture and data flow

- Runtime: plain Node.js HTTP server, zero web framework. Entry:
  `dashboard/server.js` (PORT default 8787). Helpers in `dashboard/lib/core.js`
  (JSON file store `dashboard/data/db.json`, scrypt passwords, `rxv_sess`
  cookie sessions, per-IP rate limiter, static file server).
- Auth: session cookie -> `core.getSession/requireAuth` -> `ctx.tenant`
  (db.json tenant). Tenant carries `organization_id`; every sales query is
  scoped by it via `resolveOrganizationId`. No new auth needed.
- DB transport: `dashboard/lib/supadb.js`. Uses `VAANI_DATABASE_URL`
  (Supabase session pooler, node-postgres) when set, else legacy
  `docker exec dograh-local-postgres-1` psql. `.env` is loaded by
  `core.loadEnv()` from `dashboard/.env` then project `.env`; shell env wins.
- Domain model: NO separate buyer/seller tables. Lead records live in
  `public.workflow_runs.gathered_context.extracted_variables` (JSON) and are
  projected through view `public.vaani_excavator_sales_leads`, whose
  `organization_id` comes from `workflows.organization_id` via
  `workflow_runs.workflow_id`. Inventory lives in `public.vaani_machines`.
  Matches persist in `public.vaani_buyer_machine_matches`. Follow-ups in
  `public.vaani_follow_up_tasks`. DNC in `public.vaani_dnc_registry`
  (composite PK organization_id + phone_number).
- Frontend: `dashboard/public/vaani-sales.html` (single file, embedded JS),
  session cookie auth, per-section data loading, Lead360 drawer, simulation
  panel (test scaffolding, demo/simulated pathways only).

## 2. Existing capabilities and reusable components

- Reads (all authenticated + org-scoped): overview/digest, sellers, buyers,
  machines, demand/matching read model, follow-ups, calls + call detail,
  lead timeline/evidence/whatsapp-history/lead360, activities, DNC, search.
- Writes: manual buyer/seller (`addLead`), machine (`addMachineRecord`),
  CSV-style imports, follow-up status + validated task transitions
  (`PENDING/DUE/IN_PROGRESS/COMPLETED/SKIPPED/CANCELLED` with allowed
  transitions), evidence request/receive, outbound buyer/seller call
  initiation (existing telephony path, no PSTN faking in UI).
- Matching: pure `evaluateBuyerMatches(buyer, stock)` + async
  `runIntelligentMatching` with persistence into
  `vaani_buyer_machine_matches` (match_type/evidence_json). Reuse, do not rebuild.
- Validation/extraction: `vaani-extractor.js`, `vaani-llm-extractor.js`
  (matchMachineModel, price/year/hours parsers, qualification + temperature
  evaluators). Tenant isolation migration `001_phase_e_tenant_isolation.sql`
  is the isolation contract; `002` (whatsapp evidence) and `003` (buyer
  matches) extend it.
- Tests: `dashboard/test/vaani-sales-dashboard.test.js` (demo-mode reads),
  `dashboard/test/vaani-sales-add-lead.test.js` (7 passing: INSERT shape,
  safe error mapping, zero-write duplicate + EXPLAIN). `lib/vaani-phase23.test.js`
  needs live DB + shell env (12 Classification tests currently fail without it).

## 3. Existing API routes and database tables

Routes (all under `/api/vaani/sales/`, auth + org scope): GET overview,
digest, sellers, buyers, machines, demand, follow-ups|tasks, calls,
calls/:id, leads/:id/timeline|evidence|whatsapp, leads/:id (Lead360),
activities, dnc, search; POST buyers, sellers, machines, import/*,
outbound/buyer, outbound/seller, evidence/request, follow-up/status,
tasks/transition, evidence/received, simulate-call, simulate-inbound-media.
Health: `GET /api/health` (public, liveness flags only). No PUT/PATCH/DELETE
sales routes exist (no update/archive APIs).
Tables (41 base tables; Vaani-relevant): `workflow_runs`, `workflows`,
`vaani_excavator_sales_leads` (view), `vaani_machines`,
`vaani_buyer_machine_matches`, `vaani_follow_up_tasks`,
`vaani_dnc_registry`, `vaani_digital_evidence`, `vaani_calls`,
`vaani_call_summaries`, `vaani_transcripts`, `vaani_customers`,
`vaani_whatsapp_messages`, `vaani_whatsapp_inbound_events`, `organizations`.
No dedicated deals table and no deal state machine exist.

## 4. Missing or broken functionality (verified)

1. Boot crash (FIXED in working tree): `initFilters()` bound 10 filter element
   IDs that do not exist in the HTML, aborting boot before auth/data load,
   leaving all counts at 0 for every user. Fixed with null-guards.
2. `ReferenceError: method is not defined` (FIXED): the six manual/import
   POST routes referenced an undefined variable, 500ing every save before
   auth. Fixed with `const method = req.method`.
3. Manual-lead id overflow (FIXED): `addLead` sent Date.now() ids into
   `workflow_runs.id integer`. Now uses the sequence + `RETURNING id`.
4. Dead duplicate guards (FIXED in lead + machine paths): existence check
   tested `.length` on values that resolve to bare scalars. Same pattern
   still present wherever else `exists.length` is used; grep before reuse.
5. Machine price invisible (FIXED): manual price went only to
   `sourcing_cost_inr` while inventory UI reads `target_resale_inr`; now
   written to both. Asking-price semantics still need documenting
   (sourcing_cost vs target_resale vs deal price) before Phase 2 changes.
6. Silent failures (FIXED for saves; loader hardened): generic toasts hid
   server errors; one failing section zeroed the whole dashboard. Loader now
   isolates sections, ignores stale responses, names failures.
7. Missing: update/archive endpoints, deal/negotiation entity + transitions,
   reservation/sold guards, match re-evaluation triggers, pagination on list
   reads, temperature mutation endpoint (only filters/badges exist; no status
   buttons and no backend mutation, so nothing to repair there).
8. Data note (do NOT delete without approval): two accidental TEST seller
   rows exist (`workflow_runs` ids 1000022, 1000023, `vaani-manual-*`,
   visible in org-1 seller counts 54 -> 56). Awaiting owner approval.

## 5. Security and data-integrity risks

- `addLead` hardcodes `workflow_id = 3`: manual leads inherit that
  workflow's organization for reads, so cross-org visibility is wrong for any
  caller outside that org. Fix by resolving/creating an org-owned workflow
  (proposal parked, needs approval; never hardcode other org ids).
- Duplicate checks are (were) globally scoped and partially dead: same phone
  across tenants could false-reject or duplicate. Scope checks by
  organization when touched.
- `publicTenant` returns `organization_id || 1` for display: org-less tenants
  look like org 1 in `/api/me` while data APIs correctly 403. Cosmetic but
  confusing; do not rely on it server-side (server logic correctly does not).
- Lib-level query catches return 200-empty on DB errors, masking outages as
  zero data. Loader hardening mitigates display; backend should propagate or
  tag errors in a later phase.
- Manual-test discipline: never insert through code paths under test without
  approval; prefer EXPLAIN + validation-throw + pure-function tests
  (established pattern in `vaani-sales-add-lead.test.js`).
- WhatsApp stays disabled: only `MockWhatsAppProvider` (dry-run flags) is
  wired; `vaani_whatsapp_*` tables are storage only. No provider credentials
  are configured and none may be added in core phases.

## 6. Proposed implementation phases (detail in implementation-plan.md)

- Phase 1: buyer/seller repair (validation, scoped duplicates, update/archive
  APIs, no hardcoded orgs).
- Phase 2: inventory CRUD + asking-price semantics doc + availability states.
- Phase 3: deterministic matching on stored data (reuse evaluator +
  persistence; dedup; re-evaluation triggers).
- Phase 4: deal entity (migration + transitions + reservation/sold guards).
- Phase 5: follow-ups/activity/dashboard wiring.
- Phase 6: security/regression/isolated-DB tests.
- Phase 7: WhatsApp boundary doc, disabled.

## 7. Exact files expected to change

- Phase 1: `dashboard/lib/vaani-sales.js` (`addLead`, validators),
  `dashboard/server.js` (PUT/PATCH/archive routes + mapping),
  `dashboard/public/vaani-sales.html` (edit flows),
  `dashboard/test/vaani-sales-*.test.js`, `docs/api-contract.md` (new).
- Phase 2: same trio + migration `migrations/004_*.sql` (only if verified
  missing) + `docs/database-design.md` (new).
- Phase 3: `vaani-sales.js` matching section, `003`-style migration only if
  needed, matching tests.
- Phase 4: new `migrations/00X_deals.sql`, deal service (new lib or section),
  server deal routes, tests, docs.
- Phase 5-6: drawer/summary wiring, `docs/testing-report.md` (new).
- Phase 7: `docs/future-whatsapp-integration.md` (new). Keep
  `lib/vaani-whatsapp.js` mock-only.
- Reference (do not duplicate): `docs/VAANI-SALES-ARCHITECTURE.md`,
  `docs/VAANI-MATCHING-ENGINE-V1.md`,
  `docs/VAANI-INVENTORY-MATCHING-CONTRACT-V1.md`,
  `docs/VAANI-FOLLOW-UP-ENGINE-V1.md`, `docs/entity-model/*`,
  `docs/dashboard/VAANI-SALES-DATA-CONTRACT.md`.

## 8. Open questions needing owner approval

1. Delete TEST rows 1000022/1000023? 2. Permit one supervised real-write
   verification per phase? 3. Which tenant is canonical for manual leads
   (resolve workflow-per-org design)? 4. Restore filter UI or leave display-only?
