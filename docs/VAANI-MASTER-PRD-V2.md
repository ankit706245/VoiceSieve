# VAANI MASTER PRD V2
## AI Voice Sales & Purchase Command Center for Used Excavators

**Product:** Vaani (वाणी)  
**Business:** Used-excavator/construction-machine sourcing, refurbishment, and resale  
**Version:** 2.0  
**Status:** Draft for repository review; this document is not proof of implementation or production readiness.  
**Prepared:** 25 October 2026

> **Evidence rule:** This PRD consolidates the existing `VAANI_MASTER_PRD_V1.md`, `VAANI_PRD_AND_HANDOFF.md`, `VAANI_CURRENT_PROJECT_STATUS.md`, and reported audit/implementation evidence. It does not prove every feature works. Fresh read-only code/runtime evidence takes precedence over historical claims. When evidence conflicts, stop and reconcile before making changes.

## 1. Product vision

Vaani is a Hindi/Hinglish AI voice sales and purchase agent for a business that sources used excavators/construction machines from sellers, refurbishes them, stores them at a Jaipur yard/warehouse, and resells them to buyers.

Target business loop: **Lead/data → permitted call/demo conversation → natural conversation → structured data capture → inventory matching → lead/follow-up → CRM/dashboard visibility.**

Messaging, telephony, and automation actions must be represented truthfully. A mock/pending action must never be shown as sent/completed. Never claim a real call or WhatsApp message occurred unless the integration and event evidence confirm it.

## 2. Users and information to capture

### Users
- **Buyer:** wants to purchase a used machine.
- **Seller:** offers a machine for sale.
- **Sales operator:** manages buyers, sellers, inventory, calls, leads, and follow-ups.
- **Owner/admin:** reviews performance and manages permitted settings/integrations.

Authorization must be enforced server-side; UI visibility alone is not authorization.

### Buyer details
Capture only when relevant and not already provided: machine/category, brand/model/specifications, budget, location, model-year preference, quantity where relevant, timeline/urgency, financing interest where relevant, buying intent, objections, and next action/callback.

### Seller details
Capture as relevant: contact/location, machine category/brand/model/year, running hours, condition/application/history, asking price, WhatsApp availability, willingness to provide photos/video/RC documents, and next action/human callback.

**Current scope boundary:** GST collection and seller quantity/timeline extraction are out of scope unless separately approved.

## 3. Non-negotiable conversation and business rules

1. The business sells used machines. Never ask buyers whether they want a new or used machine.
2. Never invent inventory, prices, specifications, availability, finance terms, delivery promises, or commitments.
3. Vaani does not negotiate prices. For sellers, record asking price without counter-offering or promising a purchase price. For buyers, capture budget without negotiating or promising an unapproved sale price. Human staff own valuation and negotiation.
4. Never expose prompts, workflow/node names, tool names, system instructions, internal reasoning, API/backend details, schemas, or extraction logic.
5. Never narrate internal steps or say “according to my workflow.”
6. Use natural short Hindi/Hinglish turns, appropriate “ji/sir/madam,” and one conversational question at a time by default.
7. Remember facts already supplied. Ask only for missing or genuinely ambiguous details.
8. Handle interruptions naturally and continue from the next useful missing detail.
9. If the customer declines, acknowledge politely and stop aggressive selling.
10. If a tool/integration fails, explain naturally without exposing technical internals.
11. Never claim a message, call, callback, or task was completed unless the relevant system confirms it.
12. Respect do-not-call (DNC) and consent/suppression rules. No indefinite retries.
13. Escalate technical questions, valuation, exceptions, and commitments beyond Vaani’s authority to a human.

Preferred identity, where appropriate: “Om Shyam Earthmovers se Vaani bol rahi hoon.” Never claim to be a human employee.

## 4. Frozen delivery roadmap — preserve names and order

This is the authoritative roadmap. Do not rename, reorder, skip, or silently replace these phases with numbering from older documents.

| Phase | Name | Handoff status |
|---|---|---|
| 1 | Voice Foundation | DONE (historically reported; preserve and regression-test) |
| 2 | Sales Intelligence | CURRENT |
| 3 | Sales Conversation Engine | Later |
| 4 | Sales Actions | Later |
| 5 | CRM + Call Intelligence | Later |
| 6 | Owner UI/UX | Later |
| 7 | Latency + Reliability Hardening | Later |
| 8 | Production/Owner Readiness | Final |

Older docs use different phase numbering (including Phase 0–9, Phase 4F/5/6/7/8A, and implementation-audit phases). Preserve useful requirements from them but map work to this frozen roadmap and explicitly record conflicts.

## 5. Current checkpoint — Phase 2 Sales Intelligence

**Immediate task:** perform one read-only verification of the saved Dograh `vaani_internal_inventory_lookup` configuration when the Supabase session pooler is available. Do not repeatedly retry a saturated pooler.

Verify:
- Tool exists and is Active.
- Method `GET`.
- URL exactly `http://host.docker.internal:8787/api/vaani/internal/machines?buyer_run_id={{buyer_run_id}}`
- Preset name exactly `buyer_run_id`, with no spaces.
- Type `string`; required `true`.
- Value template `{{initial_context.workflow_run_id}}`.
- LLM parameters empty/null.
- Tool is not attached to Workflow 3 until configuration is verified and a minimal integration plan is reviewed and explicitly approved.
- Never print secrets.

Historical evidence: Dograh Test Tool reportedly returned HTTP 200 and machine records for `buyer_run_id=1000085`, including a JCB 3DX. The UI showed the expected preset, but persisted DB configuration was not independently confirmed after Save because DB reads timed out. Earlier evidence showed a leading space in the preset name. Treat persistence as **unverified** until checked. If the DB check times out, record it and stop. Do not edit live DB rows, attach the tool, or edit/publish Workflow 3.

## 6. Reported architecture and integrations

Verify current state before consequential changes; the table below reflects reported architecture.

| Component | Reported purpose / constraint |
|---|---|
| Dograh API | Voice/workflow engine; previously `http://localhost:8000` |
| Dograh UI | Workflow UI; previously `http://localhost:3010` |
| Vaani dashboard/API | Node.js business API/dashboard; previously `http://localhost:8787` |
| Voice path | Browser/WebRTC → Dograh → Deepgram STT → Groq LLM → Rumik TTS |
| Backend | `dashboard/server.js`, `dashboard/lib/vaani-sales.js` and related modules |
| Workflow | Existing Dograh Workflow 3; historical definition/version IDs must be re-confirmed read-only |
| Local workflow JSON | `workflows/vaani-used-excavator-sales.json`; previous status reported prompt nodes and no tool nodes attached in the local file |
| Database | Supabase PostgreSQL session pooler is reported shared data store; local Docker PostgreSQL is stale/legacy and must not be assumed to be Dograh’s live DB |
| Redis | Docker service; potential shared state/rate-limiting option only after availability/configuration is verified |
| MinIO | Standalone Docker object storage |
| TTS customization | `rumik-overlay-local/`; preserve existing relay, Hindi number filtering, P1 TTS tag filtering, and Groq `max_tokens=150` unless a specifically approved change requires otherwise |
| Local TTS fallback | `USE_LOCAL_DEV_TTS=1` reportedly uses macOS Lekha engine |
| n8n | Planned automation for follow-ups, notifications, and reports; avoid duplicating business logic |
| RabbitMQ | Keep isolated; do not integrate into Vaani without an explicit requirement |
| Telephony | Real Vobiz/PSTN/outbound telephony is not verified as connected |
| WhatsApp | Real dispatch is not connected/verified; actions remain mock/pending unless fresh evidence proves otherwise |

Operational cautions:
- Supabase pooler reportedly has a 15-session limit and has returned `EMAXCONNSESSION`/max-client errors/timeouts. Avoid retry loops and unnecessary parallel DB connections.
- No verified VPS configuration was reported. Do not assume one exists.
- Do not recreate the API container using an unverified/missing Compose file.
- Do not run `deploy/02-build-rumik-overlay.sh`; handoff warns it is VPS-oriented and may select the wrong image/container.
- An image tag or snapshot is not automatically a verified rollback procedure.

## 7. Inventory and internal API

Reported inventory table: `public.vaani_machines`. Verify actual schema before DB work. Historical fields include `machine_id`, `brand`, `model`, `manufacturing_year`, `status`, `current_location`, `sourcing_cost_inr`, and `target_resale_inr`.

Never expose sourcing cost or internal financial fields to buyers or ordinary users.

Reported internal route: `GET /api/vaani/internal/machines`.
- Server-to-server authentication via `x-vaani-internal-secret`; never print, commit, or expose the secret to browser code.
- Positive integer `buyer_run_id`.
- Resolve buyer and organization server-side; clients must not supply `organization_id`.
- Fail closed for invalid/missing run ID, authorization/scope failure, or missing buyer.
- Success response shape `{ machines, count }`.
- Organization-scoped results; reported default statuses `in_sourcing_pipeline`, `certified_ready_in_yard`; reported limit 50.
- Do not return sourcing cost, target resale price, or other internal financial fields.
- Relevant implementation was reported in `dashboard/server.js` and `dashboard/lib/vaani-sales.js`, including `buildInternalMachinesQuery` and `getInternalMachines`; verify before edits.

Inventory behavior:
- When a buyer asks what is available, use the verified live inventory lookup if correctly integrated.
- Match exact requirements first; alternatives only when supported by real data.
- Exclude sold/unavailable machines according to verified status rules.
- On no match/tool failure, do not fabricate inventory; use a natural fallback and create a truthful follow-up only if supported.
- Test organization isolation and financial-field protection.

## 8. Phase 1 — Voice Foundation (reported DONE)

Previously reported: Dograh foundation, browser/WebRTC fake-mic E2E audio path, Deepgram STT, Rumik TTS, Groq integration, `max_tokens=150`, relay/TTS filters, local development fallback, existing authentication/workflow behavior.

Preserve these components; do not casually rewrite the voice path. Re-test Hindi/Hinglish quality and fallback behavior after relevant changes. Historical errors include Rumik Silk Cloud `INSUFFICIENT_BALANCE` and summary-path `ProviderError: no messages`; reproduce before claiming either remains active or is fixed.

## 9. Phase 2 — Sales Intelligence requirements

- Extract buyer requirements and seller machine/asking-price details.
- Preserve known data across retries; do not overwrite good values with empty or lower-confidence values.
- Maintain Buyer 360/Seller 360 context where implemented.
- Map matching inputs correctly, including buyer machine category and purchase location.
- Validate deterministic budget correction for explicit Hindi/Romanized amounts.
- Parse unambiguous Hindi/Romanized callback dates/times; do not invent appointments from ambiguous fragments.
- Callback backstop may fill a missing callback only; it must not overwrite a valid existing time.
- Inventory matching should handle exact/alternative/no-match, sold exclusion, and organization scope.
- Qualify leads from conversation evidence only.
- Keep internal API organization isolation and tool-configuration guards.

Historical tests: a focused group of 102/102 passing was reported at one point (98 dashboard pure tests plus 4 mocked LLM tests; suite counts may overlap). A broader `vaani-sales-dashboard.test.js` reportedly had 24 pass/4 fail related to missing `GROQ_API_KEY`/live HTTP assumptions. `VAANI_DATABASE_URL` was unset in that audit and DB tests were skipped. These are not current test results. Re-run relevant tests safely and report actual counts.

Phase 2 acceptance:
- [ ] Persisted tool configuration verified or explicitly documented unverified without unsafe retries.
- [ ] Exact parameter spelling/template and safe authentication.
- [ ] Inventory endpoint returns only scoped, permitted fields.
- [ ] Matching/fallback and extraction tests pass for current code.
- [ ] No secrets are printed or committed.
- [ ] Workflow 3 stays unchanged until verification and explicit approval.

## 10. Phase 3 — Sales Conversation Engine (later)

- Use extracted context to guide natural conversations.
- Ask only for missing information; avoid repetition.
- Keep turns short and conversational.
- Never reveal internal workflow or implementation language.
- Handle objections and interruptions naturally.
- Preserve no-negotiation/no-fabrication rules.
- Keep buyer/seller flows distinct without exposing internal classification.
- Use graceful, truthful fallback when integrations fail.

Acceptance: regression tests cover multiple facts in one turn, no repeated known questions, no internal narration/tool/schema leakage, and sensible continuation after interruption.

## 11. Phase 4 — Sales Actions (later)

Potential actions: human callback, WhatsApp inventory/details request, seller photo/video/RC request, yard visit, human valuation review.

Requirements:
- Distinguish `pending`, `mock`, `queued`, `sent`, `failed`, and `completed` based on actual integration semantics.
- Never mark mock as sent.
- Create follow-ups only if the task is actually persisted.
- Make retries idempotent.
- DNC/consent rules override retries.
- Real telephony or WhatsApp dispatch requires explicit owner approval and verified provider configuration.

Acceptance: tests prove mock/pending actions cannot appear completed; retries do not duplicate actions; logs do not expose secrets.

## 12. Phase 5 — CRM + Call Intelligence (later)

- Reliable call-completion ingestion.
- Transcript/summary handling where permitted.
- Structured extraction, lead qualification/status, and next action.
- Buyer/Seller 360 context.
- Idempotent retries using stable call identifiers.
- Organization-scoped data and authorization.
- Linked lead/follow-up/call outcomes.
- Accurate failed, missed, busy, no-answer, and callback-requested states.

Reported endpoint: `POST /api/v1/vaani/calls/complete`; verify its current contract before changing it. Reported relay: `dograh_vaani_relay.py`; verify actual location/implementation before use.

Acceptance: replayed events do not create duplicate records; malformed payloads fail safely; transcripts/PII are access-controlled; failures are observable and recoverable.

## 13. Phase 6 — Owner UI/UX (later)

Dashboard should make Home/Overview, Inventory, Buyers, Sellers, Leads, Calls, Follow-ups, messaging action state, and supported activity/KPIs easy to understand. Quick actions (Add Buyer/Seller/Machine, Call Buyer/Seller) must only be enabled where functionality is implemented and safe.

Requirements:
- Clear loading, empty, success, and error states.
- No invented counts or fake completion statuses.
- No internal cost, secrets, raw tokens, or unnecessary telemetry leaks.
- Backend authorization remains authoritative.
- Preserve existing useful UI behavior unless approved requirements require change.

## 14. Phase 7 — Latency + Reliability Hardening (later)

Measure STT/LLM/TTS and end-to-end latency, failure rates, retries/fallbacks, DB pool pressure, inventory API behavior, and call state transitions. Avoid Supabase retry storms. Use bounded retries/backoff where appropriate. Distinguish transient errors from permanent validation/auth errors. Preserve existing voice relay, P1 filter, and Groq token limit unless an approved change requires otherwise. Do not add infrastructure such as RabbitMQ without explicit approval.

## 15. Phase 8 — Production/Owner Readiness (final)

A working local demo alone is not production readiness.

Launch gates:
- [ ] Requirements reconciled with implementation.
- [ ] Buyer/seller journeys and fallback paths tested end-to-end.
- [ ] Authentication, sessions, authorization, organization isolation, and privileged-account protection reviewed.
- [ ] Rate limiting matches deployment topology and cannot be trivially bypassed across instances/restarts.
- [ ] Data persistence, concurrency, recovery, and backups verified.
- [ ] Paid status cannot be trusted from unverified manual state where payment verification is required.
- [ ] Secrets private and absent from Git/logs/responses.
- [ ] Inventory/internal financial-field boundaries tested.
- [ ] DNC/no-call and consent behavior verified.
- [ ] Call/message states truthfully distinguish mock/pending from sent/completed.
- [ ] Monitoring, runbooks, rollback/recovery, and operator workflows documented.
- [ ] Provider credentials, external integrations, legal/consent requirements, and live actions explicitly approved.
- [ ] Deployment target/configuration verified; no unverified VPS setup assumed.
- [ ] Relevant regression/integration results documented.
- [ ] Owner sign-off recorded.

### Known audit findings (verify before fixing)

These are reported findings, not a substitute for current-code review.

- **F-006 — In-memory/process-local rate limiting.** Reported in `dashboard/lib/core.js` and `dashboard/server.js`; a per-IP `Map` resets on restart and may not share limits across instances. Verify deployment topology and available shared state before choosing a fix.
- **F-007 — JSON persistence.** Reported in `dashboard/lib/core.js` (historically lines 154–270). Writes were reported to use temporary-file/rename and a serial write queue, so corruption is not proven. Determine exact entities, existing PostgreSQL ownership, concurrent access, recovery needs, and migration risk before proposing a data move.
- **F-008 — Manual paid status without provider verification/reference.** Reported from `audit_report.md` and `dashboard/server.js`. Verify endpoint/field, scope, roles, and whether it controls entitlements or financial actions. Do not assume a payment provider is integrated.
- **F-009 — Password-only privileged authentication.** Scrypt password hashing and opaque session tokens were reported in `dashboard/server.js`, but MFA/passkey was not present in the inspected code. Review current auth, roles, session expiry/cookie flags, rate limiting, recovery, and operational needs before choosing controls.

Prior order F-009 → F-006 → F-007 was provisional. Include F-008 in launch-risk assessment. Prioritize by verified impact; do not blindly migrate JSON or change auth/schema without review and tests.

## 16. Data model, privacy, and migrations

Inspect current schema and migration state before changes. Migration files have been reported, but their count/content/applied state must be re-confirmed in the target environment.

- Use parameterized SQL and validate inputs.
- Enforce tenant/customer scope server-side.
- Keep secrets in private environment/configuration, not browser bundles, Git, logs, screenshots, or prompts.
- Limit access to phone numbers, transcripts, and business records.
- Do not expose acquisition cost/internal target pricing to buyers or ordinary users.
- Avoid destructive schema/data changes.
- Before an approved migration: document impact, inspect data, verify recoverable backup, write rollback/recovery plan, and test on a safe non-production target.
- Never run `DROP`, `TRUNCATE`, Supabase reset, `docker compose down -v`, Docker volume deletion, or `docker system prune` as routine implementation.
- Never import local historical demo data into production without explicit approval and a reviewed plan.

## 17. Test strategy and evidence standards

Use the appropriate combination of:
1. Unit tests for parsers, extraction, matching, qualification, and state transitions.
2. API tests for authentication, authorization, validation, organization isolation, and failure cases.
3. Integration tests with mocks/stubs for call completion, retries, and follow-ups.
4. Workflow/tool configuration tests.
5. End-to-end buyer/seller scenarios in safe test mode.
6. Manual provider tests only with explicit approval and non-customer/test accounts.
7. Production smoke tests only after deployment authorization.

For every change, report exact files changed, tests run and pass/fail/skip counts, why tests failed/skipped, external credentials required, and remaining uncertainty. Do not claim the entire repository suite passes if only focused tests ran. Old test counts are not current evidence.

## 18. Demo and failure scenarios

### Buyer
Operator selects/creates buyer; a permitted test/demo call occurs through the currently supported channel; Vaani speaks naturally, remembers facts, performs verified scoped inventory lookup when integrated, never invents machines/prices, and records truthful lead/call/follow-up state. WhatsApp stays mock/pending unless real dispatch is integrated and approved.

### Seller
A permitted test/demo conversation captures machine details and asking price. No negotiation or purchase-price promise. Photo/RC requests remain pending/mock unless dispatch is confirmed. Lead and follow-up are shown only if persisted.

### Incoming
Buyer/seller intent is determined without exposing internal classification; the appropriate flow is followed and outcomes are recorded where integration exists.

### Failure tests
Inventory timeout/404/403/empty result; STT/LLM/TTS failure; Supabase pool saturation; call failed/no-answer/busy/callback requested; duplicate completion; DNC request; ambiguous data; unauthorized/cross-organization request.

## 19. Coding-agent implementation protocol

Before each task:
1. Read this PRD and current handoff/status documents.
2. Inspect `git status --short` and identify existing changes.
3. Confirm scope, files, risks, and tests.
4. Label observed facts versus assumptions/historical reports.
5. Propose minimal changes before risky work.

During work:
- Work in small reviewable units; do not rebuild working components unnecessarily.
- Do not modify unrelated code.
- Preserve all staged, unstaged, and untracked changes.
- Never reset/clean/stash/discard unknown changes.
- Do not delete/overwrite existing files, data, or workflows without explicit approval.
- Do not run migrations, restart services, rotate credentials, or alter production settings without approval.
- Do not edit/publish Workflow 3 until tool config is verified and a minimal plan is explicitly approved.
- Never reveal secrets.
- Use mocks/test data unless real-world actions are explicitly approved.

After work: run relevant tests, review diff for unrelated changes/secrets, report changed files/results/risks/gaps, and stop at approved scope.

## 20. Working-tree and recovery rules

Previous reports described a dirty working tree with many modified/untracked files (one recent count was 141; an older report recorded 20 modified tracked files and about 107 untracked files). These are historical counts; re-check before work.

Never:
- Run `git reset --hard`, `git clean`, or commands that discard user changes.
- Overwrite unrelated files.
- Remove Docker volumes or reset databases.
- Manually edit live DB rows to repair Dograh tool config.
- Print `.env`, `dashboard/.env`, API keys, tokens, or credentials.
- Treat workflow snapshots as a proven rollback unless restoration has been verified.
- Move local historical demo data into production.
- Recreate the Dograh API container from an unverified Compose file.

Keep legacy Org 2 available for audit unless a separately approved, evidence-backed change addresses it.

## 21. Current status — evidence labels

Update this section only with fresh evidence.

### Reported/implemented historically (re-test as appropriate)
- Voice Foundation marked done.
- Buyer/seller extraction and sales context improvements.
- Buyer/Seller 360 and deterministic inventory matching.
- Internal inventory API and organization-isolation tests.
- Callback parser/backstop and budget correction.
- Tool-configuration guard/tests.
- Focused test group reported 102/102 passing at one point.

### Partial/unverified
- Persisted Dograh tool configuration after Save.
- Whether inventory tool is attached to Workflow 3; handoff says evidence suggests it is not. Do not attach without approval.
- Live voice-call inventory lookup.
- Real Hindi voice quality in live calls.
- Mid-call inventory failure wording.
- Real outbound telephony/Vobiz.
- Real WhatsApp dispatch.
- Full database-backed tests; earlier audit said `VAANI_DATABASE_URL` was unset and DB tests were skipped.
- Overall repository suite; a broader suite previously had failures tied to missing API key/live HTTP assumptions.
- VPS deployment configuration and fully verified rollback path.

### Current tasks
1. One safe read-only verification of saved Dograh tool configuration when the pooler is available; stop if it times out.
2. Review and explicitly approve a minimal Workflow 3 integration plan before workflow edits/publishing.
3. Complete remaining agreed MVP work following the frozen roadmap, not by skipping phases.
4. Verify F-006 through F-009 against current code and original audit evidence.
5. Resolve launch blockers and prove acceptance criteria before production.

## 22. Do not silently add these items

Unless explicitly approved, do not connect real PSTN/Vobiz or launch a real campaign; dispatch real WhatsApp; create a new Dograh workflow instead of using Workflow 3; add GST or seller quantity/timeline extraction; integrate RabbitMQ; change auth/database schema or run migrations solely because an audit suggests it; change pricing policy; delete legacy organization/data; import local demo data into production; or claim an external integration is live without fresh verification.

## 23. MVP definition of done

- [ ] Natural speech; no workflow/instruction leakage.
- [ ] Conversation memory prevents repeated questions.
- [ ] Buyer and seller flows collect appropriate details.
- [ ] Inventory lookup verified and scoped where integrated.
- [ ] No negotiation or fabricated inventory/commitments.
- [ ] Lead and call outcomes persisted accurately.
- [ ] Follow-ups created only when actually persisted.
- [ ] Messaging/call states distinguish mock/pending from sent/completed.
- [ ] DNC/no-call behavior tested.
- [ ] Errors and provider/database failures have safe fallbacks.
- [ ] Dashboard shows real persisted results and protects internal fields.
- [ ] Relevant tests pass with exact results documented.
- [ ] Security and organization isolation reviewed.
- [ ] Production launch gates satisfied or owner has explicitly documented risk acceptance.
- [ ] Owner sign-off recorded.

## 24. Final product experience

A sales operator manages a buyer or seller in Vaani. Through an approved, supported calling channel, Vaani has a short natural Hindi/Hinglish conversation, understands requirements or machine details, consults verified inventory where integrated, records call/lead information, and presents a truthful next action to the human team. The dashboard becomes a reliable view of the customer story. No data, machine availability, message, call, or commitment is invented.

**This document is a requirements and delivery guide, not a claim that Vaani is complete or production-ready.**
