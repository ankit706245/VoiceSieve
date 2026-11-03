# VAANI AGENT RULES — NON-NEGOTIABLE

These rules govern any AI coding agent (including OpenCode) working in the Vaani repository. They supplement, and do not replace, the Master PRD.

## 1. Authority and priority
1. Follow the approved Master PRD, approved task scope, and these rules.
2. Do not invent product requirements, business rules, architecture decisions, or acceptance criteria.
3. If instructions conflict, are ambiguous, or required evidence is missing, stop before making the disputed change. Explain the conflict and ask for explicit approval.
4. Do not treat a suggestion, assumption, TODO, old note, or historical status report as authorization.

## 2. Scope control
1. Work only on the task explicitly requested and approved.
2. Do not make unrelated refactors, cleanup, dependency upgrades, formatting sweeps, or “nice-to-have” changes.
3. Do not change existing behavior unless the task requires it and the change is approved.
4. If you discover an adjacent issue, report it separately; do not fix it automatically.
5. Before editing, state the intended files, the purpose of each change, and the checks you plan to run. If this exceeds the approved scope, ask first.

## 3. Protect existing work
1. Inspect `git status` and relevant diffs before modifying files.
2. Preserve all pre-existing staged, unstaged, and untracked changes. Do not assume they belong to you.
3. Never run destructive Git commands such as `git reset --hard`, `git clean`, or commands that discard or overwrite user work.
4. Do not stash, revert, amend, rebase, force-push, or overwrite existing work unless explicitly approved for that exact action.
5. Do not delete or replace files merely because they appear unused, duplicated, outdated, or generated. Explain and request approval first.
6. Do not overwrite the Master PRD V1 or V2. Create a separate version or proposed patch when an update is approved.

## 4. Database and data safety
1. Never reset, drop, truncate, bulk-delete, or manually rewrite database data without explicit approval for the exact operation.
2. Never run a migration against a shared, staging, or production database without explicit approval and a reviewed migration plan.
3. Do not modify database records manually just to make a test or integration appear to work.
4. Do not expose credentials, connection strings, tokens, customer data, or secrets in logs, reports, screenshots, or chat.
5. If database access times out or fails, stop repeated retries after a reasonable attempt; report the evidence and do not claim the database state is verified.
6. Prefer read-only inspection first. Clearly distinguish verified facts from assumptions and historical reports.

## 5. Credentials, security, and access
1. Never print or commit `.env` values, API keys, passwords, tokens, internal secrets, or private customer information.
2. Do not weaken authentication, authorization, tenant/org scoping, rate limits, or validation to get a test to pass.
3. Do not create privileged users, bypass login, disable security controls, or change permissions without explicit approval.
4. Use only approved credentials and documented access paths. If credentials are missing, report that; do not invent or search for exposed credentials.

## 6. Workflows, integrations, and external actions
1. Do not publish, activate, or materially edit a live Dograh workflow without explicit approval.
2. Do not place real calls, send WhatsApp/SMS/email messages, contact customers, create campaigns, charge money, or trigger other external side effects without explicit approval for that action.
3. Do not claim an action happened unless tool/system evidence confirms it. Clearly label simulations, mocks, and planned work.
4. Do not change external service settings or rotate credentials without explicit approval.
5. For the saved Dograh inventory tool, verify its configuration read-only first. Do not attach it to Workflow 3 or publish the workflow until the configuration is verified and approval is given.

## 7. Code changes and dependencies
1. Make the smallest change that satisfies the approved task.
2. Do not replace a working component, change frameworks, alter architecture, or add dependencies without explaining why and obtaining approval when the change is material.
3. Do not run deployment/build scripts with uncertain side effects until their behavior and impact have been reviewed.
4. Preserve known Vaani-specific safeguards and fallbacks unless a task explicitly authorizes changing them, including the relay, P1 TTS filter, Hindi number filter, Groq `max_tokens=150`, and `USE_LOCAL_DEV_TTS=1` local macOS Lekha fallback.
5. Do not assume a local database, service, or container reflects the current authoritative environment without verifying it.

## 8. Testing and verification
1. Read relevant tests and implementation before changing code.
2. Run focused tests appropriate to the approved task, when safe and possible.
3. Never alter or weaken tests solely to make the result pass.
4. Report exact commands run and their actual outcomes. Separate passed, failed, skipped, and not-run checks.
5. Do not claim “all tests pass,” “verified,” or “production-ready” without current evidence supporting that exact claim.
6. If tests require live credentials, external services, network access, or unavailable databases, state the limitation instead of fabricating a result.

## 9. Required workflow for every task
1. Restate the requested outcome and boundaries.
2. Inspect repository state and relevant documentation before editing.
3. Identify uncertainties, risks, and planned file changes.
4. If the task is read-only, do not edit files.
5. If a material decision, destructive action, external side effect, or scope expansion is needed, stop and ask for explicit approval.
6. Make only approved changes.
7. Review the final diff for unintended changes and secret exposure.
8. Run appropriate checks and report the evidence.
9. Summarize: files changed, behavior changed, tests/checks, remaining risks, and anything not verified.

## 10. Stop conditions
Stop without making the disputed change and ask the user if:
- requirements conflict or are unclear;
- the proposed change exceeds the approved scope;
- data loss or user-work loss is possible;
- a production/shared database or live workflow may be affected;
- authentication/security controls would be weakened;
- a real customer or external system may be contacted;
- secrets or sensitive data may be exposed;
- verification fails and the next step would require guessing.

## 11. Required final report
For each task, report:
- **Outcome:** completed, partially completed, or blocked;
- **Files changed:** exact paths;
- **Changes made:** concise list;
- **Verification:** commands/checks and actual results;
- **Not verified:** what could not be confirmed;
- **Risks/next step:** any approval or action needed.

## 12. Important Vaani guardrails
- Vaani handles used construction machines. Never invent inventory, machine specifications, prices, availability, or commitments.
- Do not negotiate prices or promise terms unless an approved requirement explicitly allows it.
- Do not claim a call, WhatsApp, or other message was sent unless confirmed by system evidence.
- Do not add GST extraction, seller quantity/timeline extraction, or other out-of-scope features without approval.
- Treat previously reported test counts, infrastructure status, and audit findings as historical until reverified.
- Do not repeatedly retry a timed-out database pooler. Report the timeout and leave persisted state unverified.
- Do not run `deploy/02-build-rumik-overlay.sh`, recreate the Dograh API from unverified compose configuration, remove Docker volumes, or prune Docker resources without explicit review and approval.

## 13. How to use these rules
- Keep this file at `docs/AGENT_RULES.md` in the Vaani repository.
- Keep the approved Master PRD at `docs/VAANI-MASTER-PRD-V2.md`.
- At the start of each task, tell the agent to read both files and follow them.
- These rules are a safety layer, not a substitute for reviewing actual repository state and tool permissions.
