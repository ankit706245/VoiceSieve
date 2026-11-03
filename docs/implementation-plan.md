# Vaani Backend — Implementation Plan (Phase 0)

Follows `docs/implementation-audit.md`. Phases run strictly in order; each
phase ends with changed-file summary, test results, open issues, and an
approval gate before the next phase. No production writes, migrations,
messages, or deployments without explicit approval.

## Phase 1 — Buyer/Seller repair
- Scope: scoped duplicate validation (org-aware phone check), field
  validators (phone/budget/required), PUT/PATCH/archive endpoints reusing
  existing POST/GET routes, safe error mapping reuse (`mapLeadSaveError`).
- Files: `dashboard/lib/vaani-sales.js`, `dashboard/server.js`,
  `dashboard/public/vaani-sales.html`, `dashboard/test/vaani-sales-*.test.js`,
  `docs/api-contract.md` (new: routes + examples).
- Tests: pure validators, scoped-duplicate zero-write tests, EXPLAIN tests,
  auth/tenant negative tests (401/403/409). No live writes without approval.
- Risks: JSON-field queries stay parameterized; no org hardcoding.
- Gate: review API contract + test report.

## Phase 2 — Inventory CRUD + price persistence
- Scope: first document asking-price semantics (sourcing_cost_inr vs
  target_resale_inr vs future deal price) in `docs/database-design.md`;
  update/archive endpoints; availability states mapped to existing
  `status` values (available/in_sourcing_pipeline/sold/unavailable);
  partial-update guard (no silent overwrites).
- Files: same trio + `migrations/004_*.sql` ONLY if a verified gap needs it
  (with rollback notes; never run on production here).
- Tests: price round-trip (zero-write EXPLAIN + mocked), transition guards.
- Gate: approve semantics doc before any migration-shaped change.

## Phase 3 — Matching engine (reuse, don't rebuild)
- Scope: deterministic FULL/PARTIAL/NO_MATCH over stored buyer + inventory
  rows using `evaluateBuyerMatches`; persist to
  `vaani_buyer_machine_matches` with dedup; re-evaluation triggers on
  requirement/inventory change; SOLD/unavailable excluded; unknowns stay unknown.
- Files: `vaani-sales.js` matching section, matching tests, contract update.
- Tests: budget/type/location/spec/year/hours cases, sold-exclusion,
  duplicate-prevention, recalculation. Never send messages in tests.
- Gate: review match explanations on real org-1 sample (read-only).

## Phase 4 — Deal workflow (new entity)
- Scope: new deal table via migration (buyer+machine+seller links, proposed/
  counter/agreed price split from asking price, stage machine with valid
  transitions, RESERVED/SOLD guards, concurrency safety, audit history).
- Files: `migrations/00X_deals.sql`, deal service, server deal routes,
  tests, docs. Needs explicit migration approval; designed, not applied, here.
- Gate: approve migration SQL + transition table first.

## Phase 5 — Follow-ups/activity/dashboard
- Scope: wire existing task engine + timelines to deals/matches; dashboard
  summaries reuse overview/digest; keep WhatsApp out of automation.
- Files: drawer/summary UI, `vaani-tasks.js` only if gaps verified.
- Gate: browser checklist sign-off.

## Phase 6 — Security/regression/isolated tests
- Scope: 401/403/cross-org tests, injection/validation tests, full dashboard
  regression, no-external-call verification. Isolated DB or fixtures only.
- Output: `docs/testing-report.md` with actual results (no claimed passes).

## Phase 7 — WhatsApp boundary (disabled)
- Scope: document provider abstraction, event model, webhook/queue/status
  interfaces in `docs/future-whatsapp-integration.md`. Keep mock-only code.
  No credentials, no live sends, no workflow changes.
- Gate: final review; automation stays off.
