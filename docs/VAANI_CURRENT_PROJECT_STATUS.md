# Vaani — Current Project Status & Recovery Document

> Single source of context for continuing Vaani across chat conversations and model changes.
> Created: 2026-10-13. Documentation-only task — nothing was changed to produce this file.
> How to read it: **Verified** = observed in this audit window. **Historical** = claimed in older
> reports, not re-proven here. **Assumed** = reasonable but unchecked. **Unknown** = explicitly not verified.

---

## 1. Project purpose and business model

Vaani (वाणी) is a Hindi/Hinglish AI voice agent for RapidX's **used-excavator sales business**.
It has two sides: **sellers** (fleet owners/contractors wanting to sell machines — Vaani captures brand,
model, year, hours, condition, location, asking price) and **buyers** (contractors wanting certified used
machines — Vaani captures requirement, budget, location, timeline, then matches them against live inventory).
Hot leads go to a human owner; follow-ups, evidence (photos/RC), and yard visits move deals forward.
Beginner mental model: ears (Deepgram hears) → brain (Groq thinks) → voice (Rumik speaks), all orchestrated
by the Dograh engine, with a Node dashboard as the CRM screen.

## 2. Verified architecture and component purposes

| Component | Path | Purpose (plain language) |
|---|---|---|
| Dashboard backend + CRM UI | `dashboard/` (`server.js`, `lib/vaani-sales.js`, `public/vaani-sales.html`) | The app you open in a browser: sales APIs, buyer/seller/machine/follow-up data, matching engine, lead ingestion |
| Voice engine | `dograh/` (Python API, port 8000; console port 3010) | Runs phone/WebRTC calls, workflows, LLM speech pipeline; Vaani's call script lives here |
| Call script | `workflows/vaani-used-excavator-sales.json` | 7 nodes: greeting → seller or buyer track → objections → handoff → goodbye. Prompts only; no tool nodes attached |
| Voice customization layer | `rumik-overlay-local/` | Adds Rumik TTS + Hindi number filter + P1 TTS tag filter + Groq `max_tokens=150` on top of stock Dograh |
| Database | PostgreSQL (`workflow_runs`, `workflows`, `vaani_machines`, matches, follow-ups, DNC registry) | Shared store both Dograh and dashboard read; leads exposed via `vaani_excavator_sales_leads` view |
| Internal inventory API | `GET /api/vaani/internal/machines` (dashboard) | Buyer-scoped machine lookup for the voice engine: secret header + server-resolved buyer org, fail-closed |
| Draft tool spec (NOT live) | `docs/vaani-internal-inventory-tool.json` | Review-only config for a future disabled-by-default voice tool. No tool row or credential exists |
| Deploy helpers | `deploy/`, `scripts/`, `prompts/` | VPS scripts (unused locally), workflow publisher, voice prompt texts |
| Migrations | `migrations/` (001–004) | Tenant isolation, WhatsApp evidence tables, buyer matches, user profiles |

## 3. Runtime services and health (verified 2026-10-13)

| Service | Container / process | State (verified) |
|---|---|---|
| Voice API | `dograh-local-api-1` (`local/dograh-api:rumik-v1-p41`) | Up 7 days, healthy; `/api/v1/health` → 200 |
| Console UI | `dograh-local-ui-1` | Up 2 days; `/` → 307 login redirect (normal) |
| Postgres / Redis / MinIO | `dograh-local-postgres-1`, `dograh-local-redis-1`, `minio` | Up 12 days, all healthy |
| Dashboard backend | Node PID 18036, port 8787 | Listening; `/api/health` → 200 |
| n8n / RabbitMQ | `vaani-n8n`, `rabbitmq` | Stopped (dormant by design) |

Image safety: running image `529c56b91157` == backup tag `rumik-v1-pre-step2` (same ID, verified). No container was stopped, rebuilt, or recreated during the audit window.

## 4. Frozen eight-phase roadmap (do not rename or reorder)

1. Phase 1: Voice Foundation — DONE.
2. Phase 2: Sales Intelligence — CURRENT.
3. Phase 3: Sales Conversation Engine.
4. Phase 4: Sales Actions.
5. Phase 5: CRM + Call Intelligence.
6. Phase 6: Owner UI/UX.
7. Phase 7: Latency + Reliability Hardening.
8. Phase 8: Production/Owner Readiness.

**Recorded conflicts (not reconciled):** older docs use their own numbering — `VAANI-PHASE-4F/5/6/7/8A` reports,
`implementation-audit/plan.md` Phases 1–7 (repair/CRUD/matching/deals/follow-ups/security/WhatsApp), PRD §30
Phases 0–9 (Foundation → Demo & Hardening), and `phase_2_report.md` calling LLM-extraction "Phase 2".
These predate the frozen list above; where they disagree, this document governs.

## 5. Completed features (with evidence)

- Deterministic buyer↔inventory matching (exact/alternative/none, sold-exclusion, org-scoped) — Verified, 20/20 tests.
- Lead-qualification completeness without invention — Verified, 12/12 tests.
- Sales-brain no-prediction guards (deterministic, read-only, no leakage) — Verified, 24/24 tests.
- Matching-inputs + requirement extraction — Verified, 26/26 tests.
- Internal inventory API isolation (secret auth, buyer-anchored org scope, fail-closed 400/403/404/500) — Verified, 11/11 tests.
- Tool-config guards (draft, unattached, zero LLM args, no secrets) — Verified, 5/5 tests.
- Mocked LLM extraction contract (buyer→MATCH_BUYER, seller→photos, DNC→no-follow-up, malformed→safe error) — Verified, 4/4 tests.
- Voice customizations present in code (Rumik `--no-deps`, Hindi filter, XML-tag filter, Groq 150 tokens) — Verified present, quality by ear Unknown.
- Historical (not re-proven): 10/10 Sales-Brain evaluation, 11/11 extraction tests, one live dummy-user WebRTC call.

## 6. Partially implemented features and known bugs

- **Inventory-through-voice: PARTIAL, not live.** API + draft spec + secret docs exist; no credential/tool row created, nothing attached to Workflow 3 (do not claim otherwise). Mid-call lookups 404 before buyer classification — voice must use the check-and-WhatsApp fallback (wording unverified live).
- **Outbound calling: NOT verified working.** Routes exist; no live placement demonstrated in the audit window (do not claim otherwise).
- **WhatsApp sending: NOT implemented** (mock-only by design; do not claim otherwise).
- **Missing APIs:** temperature-mutation, update/archive, deal entity, reservation/sold guards, list pagination.
- **Assumed gaps:** live Hindi pronunciation quality, SaaS URL reachability, Supabase-pooler parity with local DB.

## 7. Tests: passed, not run, environment-blocked

- Passed 2026-10-13 (no DB/network, local only): 98 dashboard pure tests + 4 mocked-LLM tests = **102/102, 0 fail**.
- Not run (out of scope for read-only tasks): Python/Dograh suites, browser/manual call tests.
- Environment-blocked (skipped, not failures): `lib/vaani-phase23.test.js` needs `VAANI_DATABASE_URL` (unset); any Supabase/live-DB suite (access forbidden during audits); live-network/credential tests.

## 8. Working-tree state (no secrets listed)

- 20 tracked files modified (dashboard sales code/UI/tests, prompts, overlay `Dockerfile` + `service_factory.py`, build script, workflow JSON 2-line diff, `.env.example` secret-documentation block with empty value, `tts_current.py`, `scripts/deploy_workflow.py`).
- ~106 untracked items (new libs/tests including `braivex-auth.js`, `supadb.js`, mocked-LLM suite, internal-API + tool-config suites, helper scripts, audit notes, this document's siblings).
- Secret files exist (`.env`, `dashboard/.env`, both `0600`, gitignored) — values never read, printed, or committed. Nothing is staged; nothing was reset, cleaned, or discarded.

## 9. Backups and their limitations

- Image backup tag `rumik-v1-pre-step2` (same ID as live) — protects against bad rebuilds. Limitation: redeploy from it has never been executed.
- `docs/workflow_3_backup_pre_phase4f.json` + `docs/pre_phase4f_db_counts.json` — read-only snapshots. Limitation: restore procedure unverified.
- **Hard limitation:** original Compose files (`/tmp/dograh-local/`) are missing, so container recreation is reconstruct-only. No `*.sql`/`*.dump` database backups found — DB-level restore is unverified. Treat "we can roll back" as Unknown until a restore is rehearsed.

## 10. Safety rules and prohibited destructive actions

Read-only audits only: never edit/create files except the single tasked artifact; never install packages or switch models/providers; never write to Supabase or any database; never run migrations; never modify/publish Workflow 3, credentials, tool rows, env files, or containers; never rebuild/restart/recreate containers; never run destructive Docker/Git/DB commands (`rm`, `reset --hard`, `clean -fd`, volume/prune, `DROP/DELETE`); never print or commit secrets; never claim draft/not-verified work as live. Preserve all uncommitted work. Stop and wait for approval after each step.

## 11. Current next step and definition of done

**Next step:** operator provisions per-org `VAANI_INTERNAL_API_SECRET` values + dashboard env + matching Dograh org-scoped credentials (checklist already prepared, setup NOT begun).
**Done means:** direct endpoint checks return 403/400/404/200 as specified; tool `/test` preview shows masked secret + correct 200 body for a fixture buyer; tool row stays `draft` and unattached; Workflow 3 byte-identical; no secret in git, logs, or prompts. Then — and only then — plan the voice-attachment step as its own approved task.

## 12. How to reuse this document in a new conversation or model

Paste this file first, then state your phase and step (e.g. "Phase 2 — Sales Intelligence. Next: secret provisioning checklist. Read-only until I approve."). Ask the model to re-verify two facts before acting (image ID match, Workflow 3 untouched via `git status`) — if either fails, stop. Keep each task to one file-group, demand pass/fail counts for tests, and never let a new session "tidy up" uncommitted work it doesn't understand. This file's Verified/Historical/Assumed/Unknown labels are the antidote to confident guessing: make the model cite which label each claim carries.
