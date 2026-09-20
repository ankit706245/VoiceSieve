# Vaani Demo Readiness QA & Plan

## A. Current end-to-end flow
The demo targets a non-technical business owner, aiming to show how Vaani automates the heavy-equipment CRM (Buyer/Seller matchmaking, AI Calling, WhatsApp evidence, and Follow-up tasks).
1. **Owner login**: Access via `app.html` which redirects to the main `vaani-sales.html` CRM interface.
2. **Buyer/Seller list**: Displayed via main navigation tabs in `vaani-sales.html`.
3. **Lead 360 Drawer**: Slide-over panel containing specific details for a selected buyer/seller.
4. **AI Demo Calling**: Initiated via "Call Buyer (Demo)" or "Call Seller (Demo)" buttons in the Lead 360 drawer.
5. **Transcript/Extraction**: Populated post-call in the "Calls & Transcript" and "What Vaani Learned" tabs.
6. **Matching**: Automated matches shown in the "Matches" tab for buyers.
7. **WhatsApp Simulation**: Demonstrated in the "WhatsApp Demo" tab where outbound evidence requests and inbound simulated media uploads can be triggered.
8. **Follow-ups & Handoff**: Auto-completed tasks displayed in the "Follow-ups" view and "Next Action Engine" banner.

## B. Working components
- **Phase 5 Buyer Matching**: Working successfully.
- **Phase 6 Follow-ups**: Working, auto-completes on evidence receipt.
- **Phase 7 Seller AI Calling**: Integrated and functional.
- **Phase 8A WhatsApp Demo/Simulation**: Fully integrated into the timeline, providing inbound/outbound mock communication.
- **CRM/Lead 360**: Working and displaying aggregated data (timeline, transcripts, tasks, matching).
- **Authentication**: JWT-based session state (`core.js`) successfully protects endpoints.

## C. Broken/missing components
- Seamless end-to-end chaining: A user might need to click manually to advance statuses instead of the system elegantly explaining the flow.
- "Live Mode" calls and real WhatsApp integrations are intentionally mocked (Phase 8A). We must ensure no "Live" buttons are accidentally clickable or confusing during the demo.

## D. Demo UX issues (Technical Terms Exposed)
Business users should not see backend/technical terminology.
- **WhatsApp Demo Tab**: Exposes badges like `"Webhook Simulation"` and text like `"Trigger synthetic inbound media into the existing WhatsApp webhook pipeline"`. These are highly technical concepts.
- **Matching Tab**: The `"Force Run Matching"` button sounds technical; it should be phrased as "Find Matching Inventory".
- **Authentication/Login**: Might display generic RapidX branding instead of a cohesive Shyam Earthmovers/Vaani branded experience for the client.
- **Error States/Loading**: JSON structure or raw API error strings might occasionally leak into toasts/banners (e.g. `{'error': 'Unauthorized', 'authenticated': False}`).

## E. Minimum fixes
1. **Remove Technical Jargon**: 
   - Rename "Webhook Simulation" badge in `vaani-sales.html` to something business-friendly like "Customer App Simulation".
   - Reword the "synthetic inbound media... webhook pipeline" description to plain English ("Simulate a customer sending documents directly via WhatsApp").
   - Rename "Force Run Matching" to "Find Matching Inventory".
2. **Lock/Hide Non-Demo Features**: Disable or hide buttons related to real telephony ("Live Call Dograh") or real WhatsApp integration to prevent accidental clicks during the demo.
3. **Streamline Auth Branding**: Ensure the login redirect message and UI accurately reflect the Vaani CRM context, avoiding developer-centric terms.

## F. Test plan
1. Log in via the standard auth flow as a demo user.
2. Navigate the Buyer/Seller lists and open the Lead 360 drawer.
3. Run a Seller Demo Call and verify the transcript and AI extraction populate without raw JSON errors.
4. Run the WhatsApp Demo flow (Request Photos -> Send Photos) and verify Follow-up tasks auto-complete.
5. Review all on-screen text in the active tabs for developer/technical jargon (API, Webhook, JSON, Node).
6. Verify the Timeline chronologically reflects all actions logically.

## G. Exact files likely to change
- `dashboard/public/vaani-sales.html` (UI text updates, disabling non-demo buttons)
- `dashboard/public/app.html` / `app.js` (Login branding adjustments if necessary)
- `dashboard/lib/vaani-sales.js` or `dashboard/server.js` (Only if API error handling leaks raw JSON to the frontend)

## H. Regression risks
- Changing button IDs or removing elements in `vaani-sales.html` might break existing event listeners. Fixes must be limited to text-content and CSS display states.
- Hiding/disabling "Live" features must not interfere with the logic of the simulated endpoints established in Phase 8A.
