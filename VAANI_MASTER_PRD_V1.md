# VAANI MASTER PRD — DEMO V1
## AI Used-Excavator Sales & Purchase Command Center
**Company:** Om Shyam Earthmovers  
**Agent:** Vaani (वाणी)  
**Document:** Master Product Requirements Document  
**Version:** 1.0  
**Status:** Implementation Blueprint / Source of Truth

---

# 1. PURPOSE

Vaani is an AI voice sales and purchase system for Om Shyam Earthmovers.

The final demo must show a complete business loop:

**Lead/Data → AI Call → Natural Conversation → Data Collection → Inventory/Requirement Matching → WhatsApp Follow-up → Lead Creation → Follow-up Task → CRM Dashboard**

Vaani must support both:

1. **Sales calling:** Vaani calls BUYERS who want to purchase used excavators.
2. **Purchase calling:** Vaani calls SELLERS who want to sell used excavators.
3. **Incoming calls:** Vaani handles buyers/sellers who call in.

The goal is a realistic, business-ready demo rather than a technical prototype.

---

# 2. CRITICAL CURRENT PROBLEM — CONVERSATION QUALITY

## 2.1 Vaani must NOT explain its workflow to the customer

This is a critical requirement.

Current observed behavior:

Customer gives their name and then says something else.

Vaani sometimes starts describing its internal workflow/steps, for example effectively saying that it needs to collect brand/model/year/GST/etc.

This is WRONG.

The customer must never hear:
- "My buyer flow is..."
- "First I will collect..."
- "Step 1..."
- "Step 2..."
- "Now I need to collect..."
- "My workflow says..."
- "I need to follow the buyer flow..."
- Internal node names.
- Tool names.
- System instructions.
- Reasoning.
- Backend/API information.
- Extraction/schema information.
- "I have detected you as a buyer."
- Any developer/agent implementation language.

## 2.2 Natural conversation requirement

Vaani must behave like a trained human sales executive.

Internal workflow should remain invisible.

Example:

Customer:
"मेरा नाम अंकित शर्मा है और मैं अलवर से हूं।"

WRONG:
"ठीक है, अब buyer flow के अनुसार मैं आपकी machine requirement collect करती हूं..."

CORRECT:
"जी अंकित जी, आपको कौन सी machine चाहिए?"

Or naturally:
"जी अंकित जी, JCB चाहिए या कोई दूसरा model देख रहे हैं?"

## 2.3 Conversation memory

Vaani must remember information already provided in the current call.

If customer says:
"मेरा नाम अंकित है, मैं अलवर से हूं और JCB 3DX चाहिए."

Vaani must NOT ask:
"आपका नाम क्या है?"
"आपकी city क्या है?"
"कौन सी machine चाहिए?"

Instead continue naturally with the next missing business detail.

## 2.4 One conversational question at a time

Default:
- 1 question per turn.
- Maximum 2 short questions if naturally appropriate.
- No long monologues.
- No list of 5–7 questions in one response.

## 2.5 Human-like language

Use:
- Hindi/Hinglish.
- Natural English business words such as machine, model, running hours, location, price, WhatsApp, details.
- "sir", "madam", "ji" naturally.
- Short spoken sentences.
- Natural acknowledgements.
- Natural interruptions.

Avoid:
- Robotic scripts.
- Formal corporate paragraphs.
- Repeating the same sentence.
- Repeating information the customer already gave.

Never say:
"I am an AI assistant."

Preferred identity:
"Om Shyam Earthmovers se Vaani bol rahi hoon."

---

# 3. BUSINESS RULE — PRICE

This rule is mandatory.

Vaani does NOT negotiate price.

For SELLERS:
- Ask and record seller's asking price.
- Do not counter-offer.
- Do not argue about price.
- Do not promise a final purchase price.
- If price seems high, acknowledge and continue collecting useful details.
- Human team decides valuation and negotiates later.

For BUYERS:
- Ask and record buyer budget/expected price when relevant.
- Do not negotiate.
- Do not promise a final sale price unless the inventory data explicitly provides an approved price.

---

# 4. USERS

## 4.1 Buyer
Person looking to purchase a used excavator.

## 4.2 Seller
Person offering a used excavator for sale.

## 4.3 Sales Operator
Human team member managing leads, calls, inventory and follow-ups.

## 4.4 Admin
Person managing integrations, settings, security and system configuration.

---

# 5. CORE PRODUCT MODULES

1. AI Voice Agent
2. Buyer Sales Calling
3. Seller Purchase Calling
4. Incoming Calling
5. Live Inventory
6. Lead Generation
7. Lead Qualification
8. Follow-up Management
9. WhatsApp Automation
10. CRM Dashboard
11. n8n Automation
12. Call History & Transcripts
13. Analytics/KPIs
14. Admin/Settings

---

# 6. TECHNOLOGY ARCHITECTURE

## Voice
Dograh:
- WebRTC
- STT
- LLM
- TTS orchestration

Rumik:
- Hindi/Hinglish TTS voice.

## Backend
Vaani Express / Node.js backend:
- Business APIs
- Inventory
- Leads
- Calls
- Follow-ups
- Internal integrations

## Database
PostgreSQL:
- Machines
- Leads
- Calls
- Follow-ups
- Relevant workflow/run data

## Automation
n8n:
- Follow-ups
- Lead processing
- Notifications
- Future campaigns

## Messaging
WhatsApp:
- Inventory details
- Machine photos
- Seller photo/RC requests
- Follow-up messages

## Do not integrate RabbitMQ into Vaani unless explicitly required later.
RabbitMQ remains isolated for now.

---

# 7. CURRENT INVENTORY

Known existing inventory storage:

Table:
`public.vaani_machines`

Known fields:
- machine_id
- brand
- model
- manufacturing_year
- status
- current_location
- sourcing_cost_inr
- target_resale_inr

Vaani must NOT expose internal financial fields such as:
- sourcing_cost_inr
- target_resale_inr

Customer-facing inventory should expose only appropriate sales information.

---

# 8. INVENTORY API

Existing API:
`GET /api/vaani/sales/machines`

Current limitation:
It requires frontend session authentication.

Required architecture:

Create a secure internal server-to-server inventory route for Dograh/Vaani.

Example:
`GET /api/vaani/internal/machines`

Optional filters:
- brand
- model
- status

Required returned fields:
- machine_id
- brand
- model
- manufacturing_year
- status
- current_location

Authentication:
- Internal secret from environment variable.
- Header such as `X-Vaani-Internal-Secret`.
- Never hardcode secret.
- Never print secret.
- Never expose secret to browser.

---

# 9. BUYER SALES FLOW

## Goal
Vaani calls a buyer and helps match the buyer to available machines.

### Flow

1. Greeting.
2. Understand purchase intent.
3. Collect machine brand/model.
4. Collect year requirement if relevant.
5. Collect GST preference if relevant.
6. Collect location.
7. Collect budget if relevant.
8. Live inventory lookup.
9. Tell buyer relevant available machines naturally.
10. Confirm WhatsApp.
11. Collect missing name/city if needed.
12. Offer/send photos/details on WhatsApp.
13. Create/update lead.
14. Create follow-up.
15. Close politely.

### Important
If buyer asks:
"Kaunsi machines available hain?"

Vaani must attempt live inventory lookup.

It must NOT simply repeat:
"Main system mein check karke WhatsApp par bhej dungi"
when the live tool is available.

If the tool fails:
- Do not expose technical failure.
- Say naturally:
"Ji, main details WhatsApp par share karwa deti hoon, team aapko confirm kar degi."

---

# 10. SELLER PURCHASE FLOW

## Goal
Vaani calls a seller who may have a used excavator for sale.

### Flow

1. Greeting.
2. Explain purpose naturally.
3. Confirm machine.
4. Brand.
5. Model.
6. Manufacturing year.
7. Running hours.
8. Location.
9. Application/history:
   - soil
   - stone/quarry
   - other
10. Seller asking price.
11. Ask for WhatsApp.
12. Request machine photos.
13. Request RC/documents where appropriate.
14. Create seller lead.
15. Create follow-up.
16. Human team reviews and calls back.

### Price rule
No negotiation.

---

# 11. OUTBOUND CALLING

Vaani must support calls initiated from supplied lead data.

## 11.1 Buyer outbound

Input example:
- name
- phone
- city
- machine requirement
- budget
- source

Action:
**Sales Call**

Vaani calls buyer.

Example opening:
"Namaste Ankit ji, Om Shyam Earthmovers se Vaani bol rahi hoon. Aapne excavator ke liye enquiry ki thi, usi ke regarding call kiya hai."

Then continue naturally.

## 11.2 Seller outbound

Input example:
- name
- phone
- city
- machine
- source

Action:
**Purchase Call**

Vaani calls seller.

Example:
"Namaste ji, Om Shyam Earthmovers se Vaani bol rahi hoon. Aapki machine ke regarding baat karni thi."

Then continue naturally.

## 11.3 Call states

- queued
- calling
- connected
- completed
- no_answer
- busy
- failed
- callback_requested
- not_interested

## 11.4 Retry

Retry rules must be configurable.

Do not repeatedly call a customer who has clearly requested no calls.

---

# 12. LEAD GENERATION

Every meaningful completed call should produce structured lead information.

## Buyer Lead

Fields may include:
- lead_id
- customer_name
- phone
- city
- intent = BUY
- brand
- model
- required_year
- budget
- GST preference
- WhatsApp availability
- qualification
- next_action
- call_id
- created_at

## Seller Lead

Fields may include:
- lead_id
- customer_name
- phone
- city
- intent = SELL
- brand
- model
- manufacturing_year
- running_hours
- application_history
- asking_price
- WhatsApp availability
- qualification
- next_action
- call_id
- created_at

---

# 13. LEAD QUALIFICATION

## HOT
Strong intent + useful details + next action agreed.

## WARM
Interested but needs callback/details/time.

## COLD
Not interested or very low intent.

Qualification must be based on actual conversation data, not invented assumptions.

---

# 14. FOLLOW-UP

Possible next actions:
- WhatsApp photos
- WhatsApp inventory
- Request seller RC
- Request seller machine photos
- Human callback
- Yard visit
- Price/valuation review by human
- Future follow-up

Follow-up must contain:
- lead
- action
- due time/date where applicable
- status
- owner where applicable

---

# 15. WHATSAPP

## Buyer
After qualifying:
- send relevant machine details
- send photos where available
- send yard/location information when appropriate

## Seller
Request:
- machine photos
- RC/document images
- machine video if required

## Demo
Mock/simulated WhatsApp provider is acceptable for Demo V1.

Real Meta WhatsApp Cloud API can be connected after the demo workflow is stable.

---

# 16. CALL TRANSCRIPT & EXTRACTION

After call:
- retain transcript where permitted
- extract structured fields
- determine BUY/SELL/NOT_INTERESTED
- qualify lead
- determine next action
- create follow-up

Existing endpoint:
`POST /api/v1/vaani/calls/complete`

Call completion must be idempotent using a call identifier.

---

# 17. POST-CALL RELAY

Required architecture:

Dograh call
→ post-call extraction
→ relay
→ Vaani calls-complete API
→ lead/follow-up database

Required relay:
`dograh_vaani_relay.py`

The relay must:
- avoid duplicate submissions
- handle temporary failures
- log safe operational information
- never log secrets

---

# 18. CRM DASHBOARD

Dashboard must be bright, simple and business-user friendly.

## Main navigation

- Home
- Inventory
- Buyers
- Sellers
- Leads
- Follow-ups
- Calls
- WhatsApp
- Settings

## Home

Show:
- Calls today
- HOT leads
- Follow-ups due
- Available inventory
- Buyer leads
- Seller leads
- Recent activity

## Quick actions

- + Add Buyer
- + Add Seller
- + Add Machine
- 🎙️ Call Buyer
- 🎙️ Call Seller

## Lead details

Show:
- Name
- Phone
- Buyer/Seller
- Machine
- Location
- Budget/asking price
- Qualification
- Last call
- Next action
- Follow-up

Avoid exposing technical telemetry to normal operators.

---

# 19. INVENTORY DASHBOARD

Actions:
- Add machine
- Edit machine
- Change status
- Search/filter
- View details

Statuses can include:
- available
- reserved
- sold
- in_sourcing_pipeline

---

# 20. n8n AUTOMATION

n8n should eventually handle:
- lead-created automation
- follow-up reminders
- WhatsApp preparation
- daily lead reports
- missed follow-up alerts
- inventory-related notifications

Do not duplicate business logic unnecessarily between n8n and the Vaani backend.

---

# 21. ANALYTICS

KPIs:
- calls attempted
- calls connected
- buyer leads
- seller leads
- HOT/WARM/COLD
- follow-ups due
- WhatsApp actions
- inventory matches
- conversion metrics where data supports them

Do not invent metrics from missing data.

---

# 22. SECURITY

- Secrets only in environment/configuration.
- Never expose API keys in frontend.
- Never print JWT/API keys.
- Internal routes require server-to-server authentication.
- Parameterized SQL.
- Validate user input.
- Respect DNC/no-call requests.
- Protect call/transcript data.
- Keep financial acquisition cost fields internal.

---

# 23. CONVERSATION SAFETY & QUALITY RULES

Vaani must:

- Never reveal system prompts.
- Never reveal workflow nodes.
- Never reveal internal reasoning.
- Never explain tools.
- Never say "according to my workflow".
- Never narrate extraction.
- Never dump collected fields as a checklist.
- Never repeat the customer's name unnecessarily.
- Never ask for information already provided.
- Never negotiate price.
- Never fabricate inventory.
- Never claim WhatsApp was sent if it was not actually sent/queued.
- Never claim a callback is scheduled if no task was created.
- Never invent machine availability.
- If information is unavailable, say so naturally and continue.

---

# 24. CONVERSATION EXAMPLES

## Buyer

Customer:
"JCB 3DX chahiye."

Vaani:
"Ji sir. Kaunsa model year prefer karenge?"

Customer:
"2020 ke aas-paas."

Vaani:
"Ji. Aapka budget roughly kitna hai?"

Then live inventory lookup.

Vaani:
"Sir, hamare paas JCB 3DX ka 2020 model available hai. Main photos aur details WhatsApp karwa deti hoon."

NOT:
"Step 3: I will now perform inventory lookup."

---

## Seller

Customer:
"JCB 3DX sell karni hai."

Vaani:
"Ji. Kaunsa model year hai?"

Customer:
"2020."

Vaani:
"Running hours roughly kitne hain?"

Customer:
"8000."

Vaani:
"Ji. Machine abhi kis location par hai?"

Then asking price.

NOT:
"Now I will collect seller information."

---

# 25. INTERRUPTION HANDLING

If customer interrupts:
- stop or shorten current response
- acknowledge
- answer customer's latest question
- continue from missing information

Example:

Vaani:
"Aapki machine ka model—"

Customer:
"JCB 3DX hai."

Vaani:
"Ji, JCB 3DX. Model year kya hai?"

---

# 26. OUT-OF-SCOPE

If technical question is beyond Vaani's authority:

"Sir, technical details ke liye main aapko senior team se connect karwa deti hoon."

Do not invent technical specifications.

---

# 27. NOT INTERESTED

If customer says not interested:

"Ji bilkul, koi dikkat nahi. Dhanyawad."

Do not continue selling aggressively.

Record appropriate status.

---

# 28. DEMO DATA ENTRY

Dashboard must allow adding:

## Buyer
- Name
- Phone
- City
- Required machine
- Budget
- Notes

## Seller
- Name
- Phone
- City
- Machine
- Year
- Hours
- Asking price
- Notes

Then provide:
**Call Now**

---

# 29. COMPLETE DEMO

## Demo A — Buyer

1. Add buyer.
2. Click Call Buyer.
3. Vaani calls.
4. Buyer speaks.
5. Vaani understands naturally.
6. Inventory lookup happens.
7. Vaani provides available option.
8. WhatsApp follow-up is created/sent.
9. Lead is generated.
10. Follow-up appears in dashboard.

## Demo B — Seller

1. Add seller.
2. Click Call Seller.
3. Vaani calls.
4. Seller gives machine details.
5. Vaani collects asking price.
6. Vaani requests photos/RC.
7. Seller lead generated.
8. Follow-up created.
9. Dashboard updated.

## Demo C — Incoming

1. Customer calls Vaani.
2. Buyer/seller intent detected.
3. Appropriate flow.
4. Lead generated.
5. Follow-up created.

---

# 30. PHASE ROADMAP

## Phase 0 — Foundation
Status: largely complete.

Includes:
- Dograh
- Workflow 3
- Rumik
- PostgreSQL
- Vaani backend
- Existing lead/follow-up foundation

## Phase 1 — Conversation Quality
Priority:
- Fix workflow leakage.
- Remove internal workflow narration.
- Improve memory.
- Improve natural responses.
- One-question-at-a-time behavior.
- Interruption handling.
- Regression test buyer/seller calls.

## Phase 2 — Live Inventory
- Secure internal API.
- Dograh inventory tool.
- Buyer inventory lookup.
- Exact/alternative matching.
- Fallback behavior.
- Test live voice inventory.

## Phase 3 — Outbound Calling
- Buyer call creation.
- Seller call creation.
- Call queue.
- Calling status.
- Result handling.
- Retry/DNC logic.

## Phase 4 — Lead Engine
- Post-call extraction.
- Relay.
- Lead creation.
- Qualification.
- Follow-up generation.
- Idempotency.

## Phase 5 — CRM Dashboard
- Buyer management.
- Seller management.
- Inventory management.
- Leads.
- Calls.
- Follow-ups.
- Simple business UI.

## Phase 6 — WhatsApp
- Buyer inventory sharing.
- Seller media request.
- Mock provider demo.
- Meta Cloud API later.

## Phase 7 — n8n
- Follow-up automations.
- Notifications.
- Reports.
- Workflow triggers.

## Phase 8 — Analytics
- KPIs.
- Funnel.
- Call performance.
- Lead performance.

## Phase 9 — Full Demo & Hardening
- End-to-end buyer test.
- End-to-end seller test.
- Incoming test.
- Failed-call test.
- Inventory failure test.
- WhatsApp test.
- Lead/dashboard verification.
- Security review.
- Demo cleanup.

---

# 31. IMPLEMENTATION RULE FOR ANTIGRAVITY

This PRD is the source of truth.

Before every implementation phase:

1. Read this PRD.
2. Inspect existing implementation.
3. Do not rebuild working components.
4. Change only the required scope.
5. Backup important DB/workflow data before destructive changes.
6. Make one phase at a time.
7. Run tests.
8. Report exactly what changed.
9. Stop after the requested phase.

Never make unrelated "improvements" during a phase.

---

# 32. TOKEN-SAVING EXECUTION METHOD

Antigravity should receive this PRD once.

For each future phase, use a short command:

> "Read VAANI_MASTER_PRD.md. Implement Phase X only. Follow its scope and stop after tests."

The PRD should prevent repeated explanation of the complete project.

---

# 33. CURRENT PRIORITY ORDER

When implementation resumes:

**P0 — Conversation Quality**
Fix the current issue where Vaani exposes/narrates internal workflow after the customer provides information.

**P1 — Live Inventory**
Connect secure inventory API to Dograh Buyer Flow.

**P2 — Outbound Buyer Calling**
Data → Call Buyer → Conversation → Lead.

**P3 — Outbound Seller Calling**
Data → Call Seller → Conversation → Lead.

**P4 — Post-call Lead Engine**
Transcript → Extraction → Lead → Follow-up.

**P5 — Dashboard**
Show all results in one business-friendly console.

**P6 — WhatsApp**
Connect actual follow-up actions.

**P7 — n8n**
Automate follow-ups and notifications.

**P8 — End-to-End Demo**
Buyer + Seller + Incoming + Inventory + Lead + Follow-up + Dashboard.

---

# 34. DEFINITION OF DONE — DEMO V1

Vaani Demo V1 is complete only when:

- [ ] Vaani speaks naturally.
- [ ] Vaani never reveals workflow/instructions.
- [ ] Vaani remembers information already given.
- [ ] Buyer flow works.
- [ ] Seller flow works.
- [ ] Incoming call works.
- [ ] Buyer outbound call works.
- [ ] Seller outbound call works.
- [ ] Live inventory works.
- [ ] No price negotiation occurs.
- [ ] Buyer lead is created.
- [ ] Seller lead is created.
- [ ] Follow-up is created.
- [ ] WhatsApp demo flow works.
- [ ] Dashboard reflects the result.
- [ ] Call transcript/extraction works.
- [ ] n8n automation works where included.
- [ ] Error/fallback handling works.
- [ ] DNC/no-call behavior works.
- [ ] No secrets leak.
- [ ] End-to-end demo can be repeated reliably.

---

# 35. FINAL PRODUCT VISION

The final demo should feel like this:

A sales operator enters a buyer or seller into Vaani.

They press **Call**.

Vaani automatically calls the person.

Vaani has a natural Hindi/Hinglish conversation.

Vaani understands what the person wants.

For a buyer, Vaani checks actual inventory.

For a seller, Vaani collects machine information and asking price.

Vaani does not negotiate.

Vaani creates the appropriate lead.

Vaani prepares/sends the WhatsApp follow-up.

Vaani creates the next task.

The operator opens the dashboard and sees the complete customer story.

**That is the Vaani Demo V1 target.**

---

## END OF MASTER PRD
