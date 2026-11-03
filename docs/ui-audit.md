# Vaani CRM UI Audit (read-only, 2026-10-01)

Scope: `dashboard/public/vaani-sales.html` + embedded JS/CSS, API contracts in
`dashboard/server.js`, existing UI tests. No code edited for this audit (one
ops action: restarted the dashboard process, which was found stopped).
No data written or deleted. Browser automation unavailable (no desktop browser
connected), so browser-console/runtime claims are marked NOT VERIFIED unless
proven via the null-honest DOM harness described below.

Verification method: static element/handler inventory (every id referenced in
JS checked against ids present in HTML), API contract cross-check, plus a Node
DOM harness that returns null exactly for missing ids and executes the real
boot path with mocked fetch (ok + 403 modes).

## 1. Inventory verdicts

PASS (renders + wired): sidebar nav (href switcher), dashboard KPIs, buyers /
sellers / inventory / calls / follow-ups tables, Add Buyer/Seller/Machine
modals + saves, Lead Details drawer open/close/backdrop/Escape (backdrop
element + guards added in working tree), follow-up Complete via transition
API, search input + `/api/vaani/sales/search`, logout, toasts + banners.
FAIL (broken/dead/false): Import buttons claim "Import successful" without
uploading anything (never call the real `/api/vaani/import/*` routes);
DNC data fetched but never rendered (no `renderDnc`, no DNC section);
activities timeline element never populated (no renderer);
`followups.upcoming` counted but never listed; `initNavigation`
(`.nav-tab`/`data-view`) and drawer-tab bindings target non-existent elements
(dead code, harmless); `renderAudioPlayer`/`renderTranscript` are called but
undefined (typeof-guarded in working tree).
NOT VERIFIED (needs real browser): console errors, actual click behavior,
drawer tab switching (no tab UI exists), audio/transcript rendering.

## 2. Action -> API map (all existing endpoints, auth + org scoped)

View/openDrawer -> GET leads/:id; Call buyer/seller -> POST outbound/*
(live 502 while Dograh localhost:8000 is down; honest toast); Complete ->
POST tasks/transition + refresh; saves -> POST buyers/sellers/machines with
safe 409/400/500 mapping; search -> GET sales/search. All onclick handlers
resolve to defined functions.

## 3. Field/status display

Buyers: budget via robust rupee parser (commas/Lakh/Crore), explicit 0 kept,
null shows unavailable. Sellers/inventory/calls/follow-ups: real `status`,
`unit.status`, `Not available` price, UNKNOWN temperature fallback, seller
name joined org-scoped, manual price mirrored to cost+resale. No fabricated
values found.

## 4. Drawer

Opens (backdrop fixed), closes via X/backdrop/Escape, sequence token blocks
stale-buyer overwrite, missing sections skipped without throwing. Tabs have
no clickable UI (bindings inert). Lead360 body renders supported sections;
unsupported ones stay hidden.

## 5. Errors/loading/empty states

Per-section load isolation + stale-response guard; 401 overlay+redirect,
403 access-denied banner, named toasts otherwise (code-verified, browser
NOT VERIFIED). Empty states exist per table. No loading spinners (minor).

## 6. Tests (actual runs this audit)

- `vaani-sales-add-lead.test.js`: 14/14 PASS (zero-write).
- `vaani-sales-dashboard.test.js`: 16/28 PASS; 12 Classification FAILS are
  environmental (file never loads VAANI_DATABASE_URL, so its live-DB writes
  fail at the docker transport before touching data). The HTTP-endpoint test
  FAILS whenever no server runs on 8787 (it needs a live server; also mints
  a local session row) — passed again once the server was restarted.
- `dashboard/test_frontend.py`: obsolete (targets non-existent Next.js-style
  routes) — not runnable, do not use.
- Server was found STOPPED at audit start (dashboard fully unreachable);
  restarted with the established `node dashboard/server.js` (PID 41474,
  health 200). Background shells dying with their session is a deployment
  fragility: recommend a process manager (no change made).

## 7. Prioritized fixes (blockers first)

1. Import buttons fabricate success (FAIL, data-integrity): wire to real
   import APIs or remove the fake toast. 2. DNC + activities dead data:
   render or stop fetching. 3. Upcoming follow-ups unlisted. 4. Remove dead
   nav-tab/drawer-tab code paths to prevent recurrence. 5. Loading spinners
   (minor). 6. `test_frontend.py` obsolete (delete or rewrite).
