# Vaani — AI Used Excavator Sales & Calling Agent Architecture
**Document:** `docs/VAANI-SALES-ARCHITECTURE.md`  
**Version:** 1.0 (Phase 1 Architecture & Foundation)  
**Product:** RapidX  
**Agent Name:** Vaani (वाणी)  
**Status:** Architecture Complete • Foundation Only • Phase 1 Stop Condition  

---

## 1. Product Definition & Business Model

**RapidX** is an AI voice solutions provider operating **Vaani (वाणी)**, an intelligent Hindi/Hinglish calling agent purpose-built for the **used heavy equipment and excavator industry**.

### Core Business Operations:
1. **Sourcing / Purchase Side (Sellers):**
   - Sourcing pre-owned and used hydraulic excavators directly from fleet owners, contractors, mining operators, and equipment brokers across India.
   - Capturing machine condition, operating hours, manufacturing year, expected selling price, documentation status, and inspection availability.
2. **Refurbishment & Quality Inspection:**
   - RapidX evaluates, tests, inspects, and refurbishes acquired machines to high operational standards.
3. **Distribution / Sale Side (Buyers):**
   - Marketing certified used and refurbished excavators to construction companies, civil contractors, quarry operators, and rental operators.
   - Capturing requirement specifics (brand, model, tonnage class, budget bracket, geographic deployment, and purchase timeline).

---

## 2. Component Preservation & Transformation Strategy

The transformation preserves the existing verified local infrastructure without rewriting working components:

| Component | Current State (Phase 5) | Transformation Strategy | Phase 1 Action |
|---|---|---|---|
| **Dograh Engine (Port 8000/3010)** | Orchestrates WebRTC & SIP call sessions with FastRTC/Pipecat | **Preserved** — Core voice runner remains unmodified. | Intact |
| **PostgreSQL Database** | Stores `workflow_runs`, Dograh tables, and n8n data | **Preserved & Extended** — Existing `vaani_customer_leads` remains intact; excavator fields will extend schema in Phase 2. | Intact (Read-only) |
| **Local Speech Stack** | Deepgram STT, Groq/Qwen LLM, Rumik TTS (Emma Hindi) | **Preserved** — Same low-latency voice pipeline will be utilized. | Intact |
| **n8n Automation Engine** | HWM cursor + 5-branch outcome switch (`localhost:5678`) | **Preserved & Extended** — HWM logic preserved; branches will be expanded to new sales outcomes. | Intact (Dormant schedule) |
| **Local Dashboard Server** | Node.js server on port 8787 with `vaani.html` | **Preserved & Extended** — Receptionist dashboard preserved; new sales routes will be added. | Intact (Listening on 8787) |
| **Voice Persona & Prompts** | Business receptionist prompt (`vaani-hindi-receptionist.json`) | **Replaced Later** — Excavator sales prompts will be authored after human call analysis. | Preserved in checkpoint |
| **Knowledge Base** | Salon/receptionist facts (`docs/VAANI-KNOWLEDGE-BASE.md`) | **Replaced Later** — Phased transition into excavator technical & commercial KB. | Transition plan defined |

---

## 3. New Sales Data Model (Structured Extraction)

### 3.1 Seller Data Model (Machine Sourcing / Purchase)
When a caller or lead wants to sell a machine, Vaani extracts the following structured fields:

```json
{
  "customer_name": "Ramesh Patel",
  "callback_number": "+919876543210",
  "customer_type": "seller",
  "machine_brand": "Tata Hitachi",
  "machine_model": "EX 200LC",
  "machine_year": 2018,
  "running_hours": 6400,
  "machine_condition": "Good working condition, undercarriage 70%, pump unhampered",
  "machine_location": "Surat, Gujarat",
  "ownership_status": "Single owner, original buyer",
  "document_status": "RC available, RTO NOC clear, road tax valid, hypothecation cleared",
  "expected_selling_price": "₹28,50,000",
  "photos_available": true,
  "video_available": true,
  "seller_intent": "high_immediate",
  "lead_temperature": "HOT",
  "conversation_outcome": "price_discussion",
  "next_action": "Request WhatsApp machine walkaround video and dispatch local inspection engineer",
  "follow_up_required": true,
  "follow_up_date": "2026-09-11T10:00:00+05:30",
  "notes": "Owner completed highway contract and wants to liquidate machine within 10 days."
}
```

### 3.2 Buyer Data Model (Equipment Sales / Procurement)
When a prospect is looking to purchase a used or refurbished machine:

```json
{
  "customer_name": "Suresh Builders & Infra",
  "callback_number": "+919823456789",
  "customer_type": "buyer",
  "required_machine_brand": "JCB or Tata Hitachi",
  "required_machine_model": "JS 205 / EX 210",
  "required_machine_category": "Tracked Hydraulic Excavator (20-Ton Class)",
  "budget": "₹24,00,000 to ₹27,00,000",
  "purchase_location": "Indore, Madhya Pradesh",
  "purchase_timeline": "Within 2 weeks",
  "new_or_used": "used",
  "refurbished_interest": true,
  "buyer_intent": "high_budget_ready",
  "lead_temperature": "HOT",
  "conversation_outcome": "lead_qualified",
  "next_action": "Share verified inventory options with inspection reports via WhatsApp",
  "follow_up_required": true,
  "follow_up_date": "2026-09-10T16:00:00+05:30",
  "notes": "Contractor needs 20-ton machine immediately for rural road excavation work."
}
```

---

## 4. Lead Stages & Lifecycle Funnel

A prospect progresses through distinct lifecycle gates. A lead must never be marked `QUALIFIED` unless machine specifics, budget/price expectations, and location are explicitly gathered.

```
                  ┌────────────────┐
                  │      NEW       │  Initial lead creation from campaign/inbound
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │   CONTACTED    │  Outbound dial initiated or inbound received
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │   CONNECTED    │  Caller answered and engaged in conversation
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │   INTERESTED   │  Expresses intent to sell or buy equipment
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │   QUALIFIED    │  Machine model, year/hours, budget & location captured
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │PRICE_DISCUSSION│  Price range or expected price explicitly communicated
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │   FOLLOW_UP    │  Specialist callback, machine inspection, or catalog dispatch
                  └───────┬────────┘
                          │
                  ┌───────▼────────┐
                  │  NEGOTIATION   │  Formal price matching, site visit, or token deposit
                  └───────┬────────┘
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
     ┌───────────────┐         ┌───────────────┐
     │  CLOSED_WON   │         │  CLOSED_LOST  │
     │(Deal Closed)  │         │(Passed/Sold)  │
     └───────────────┘         └───────────────┘

                 [ DO_NOT_CALL ] (Parallel Terminal State)
                 Triggered on opt-out, refusal, or DND demand.
```

---

## 5. Standardized Call Outcomes

To ensure backward compatibility with Phase 5D/5E and seamless forward expansion:

| Outcome Code | Meaning | Lead Stage Transition | Downstream Action |
|---|---|---|---|
| `inquiry` | General questions on company, services, or process | `CONNECTED` | Logged in inquiry ledger |
| `interested` | Expresses general intent but missing key parameters | `INTERESTED` | Schedule discovery follow-up |
| `lead_qualified` | Complete machine specifications & requirement captured | `QUALIFIED` | Dispatch to sales queue |
| `price_discussion` | Specific machine price discussed or counter-quoted | `PRICE_DISCUSSION` | Senior commercial review |
| `negotiation` | Active counter-offer under negotiation | `NEGOTIATION` | Sales manager action |
| `callback_requested` | Caller specifically requests human callback | `FOLLOW_UP` | Push high-priority callback task |
| `appointment_requested` | Yard visit or physical machine inspection booked | `FOLLOW_UP` | Field inspector dispatch |
| `closed_won` | Agreement finalized (token received or machine bought) | `CLOSED_WON` | Invoicing / Logistics |
| `closed_lost` | Customer purchased elsewhere, machine sold, or dropped | `CLOSED_LOST` | Archive & review reason |
| `no_answer` | Call unanswered after ringing | `CONTACTED` | Re-queue for next dial cycle |
| `busy` | Number busy / line engaged | `CONTACTED` | Exponential backoff redial |
| `wrong_number` | Number disconnected or wrong person reached | `CLOSED_LOST` | Mark invalid |
| `opt_out` | Caller demands not to be called or removed | `DO_NOT_CALL` | **Immediate suppression** |

### Backward Compatibility with Phase 5D/5E:
- Existing Phase 5D/5E n8n automation currently routes:
  1. `callback_requested`
  2. `appointment_requested`
  3. `lead_qualified`
  4. `opt_out`
  5. `default` (handles `inquiry`, `user_hangup`, `end_call`)
- When Phase 2 introduces `price_discussion`, `negotiation`, `interested`, `closed_won`, and `closed_lost`, they will map gracefully:
  - During transition: Any new outcome not yet in the switch automatically hits the `default` fallback, ensuring zero dropped leads.
  - In Phase 2: Dedicated downstream branches for `price_discussion` and `negotiation` will be added to the n8n switch immediately following the preserved `Update High-Water Mark` node.

---

## 6. Conversational Call Flows

### 6.1 Seller Call Flow (Machine Sourcing)

```
[1. Warm Opening]
  "नमस्ते! मैं RapidX से वाणी बात कर रही हूँ। क्या आप अपनी पुरानी मशीन या एक्सकेवेटर बेचने के बारे में बात कर रहे हैं?"
           ↓
[2. Confirm Reason]
  Seller confirms machine availability for sale.
           ↓
[3. Brand & Model]
  "आपकी मशीन कौन से ब्रांड और मॉडल की है? (जैसे Tata Hitachi EX 200, JCB JS 205 या Hyundai?)"
           ↓
[4. Model Year & Operating Hours]
  "यह मशीन कौन से साल का मॉडल है, और अब तक मीटर पर कितने घंटे चल चुकी है?"
           ↓
[5. Mechanical & Undercarriage Condition]
  "मशीन की करंट कंडीशन कैसी है? इंजन, मेन पंप और अंडरकैरिज (चेन-ट्रैक) का क्या हाल है?"
           ↓
[6. Machine Location]
  "मशीन इस समय किस लोकेशन (शहर/ज़िले) में खड़ी है, जहाँ हमारी टीम इंस्पेक्शन कर सके?"
           ↓
[7. Ownership & Documents Status]
  "मशीन की आरसी और लोन के कागजात क्लियर हैं? क्या एनओसी (NOC) उपलब्ध है?"
           ↓
[8. Expected Price]
  "आप इस मशीन के लिए क्या कीमत (Expected Price) की उम्मीद कर रहे हैं?"
           ↓
[9. Photos / Video Availability]
  "क्या मशीन की ताज़ा फोटो या वर्किंग वीडियो आपके पास व्हाट्सएप पर उपलब्ध हैं?"
           ↓
[10. Lead Scoring & Intent Evaluation]
  Agent determines temperature: HOT (immediate ready price), WARM (negotiable), COLD (inflated).
           ↓
[11. Next Action & Professional Close]
  "बहुत बढ़िया, मैंने सारी डिटेल्स नोट कर ली हैं। हमारे टेक्निकल वैल्यूअर जल्द ही आपसे संपर्क करके इंस्पेक्शन तय करेंगे। धन्यवाद!"
```

---

### 6.2 Buyer Call Flow (Machine Sales)

```
[1. Warm Opening]
  "नमस्ते! RapidX में आपका स्वागत है, मैं वाणी हूँ। क्या आप सेकंड-हैंड या रीफर्बिश्ड एक्सकेवेटर की तलाश कर रहे हैं?"
           ↓
[2. Requirement & Application]
  "आपको किस तरह के काम के लिए मशीन चाहिए — जैसे रोड वर्क, माइनिंग या जनरल कंस्ट्रक्शन?"
           ↓
[3. Machine Category & Preferred Brand]
  "आपकी पसंद कौन से ब्रांड और टन क्लास में है? (जैसे 20-टन में Tata Hitachi, JCB या Komatsu?)"
           ↓
[4. Used vs. Refurbished Preference]
  "क्या आप डायरेक्ट यूज्ड मशीन चाहते हैं या कंपनी द्वारा पूरी तरह रीफर्बिश और टेस्टेड मशीन पसंद करेंगे?"
           ↓
[5. Budget Bracket]
  "आपका लगभग कितना बजट निर्धारित है?"
           ↓
[6. Site / Deployment Location]
  "मशीन को किस लोकेशन या राज्य में चलाना है?"
           ↓
[7. Purchase Timeline]
  "आपको मशीन की डिलीवरी कितने दिनों में चाहिए — तुरंत (1 हफ्ते में) या इस महीने के अंत तक?"
           ↓
[8. Qualification & Availability Grounding]
  [CRITICAL GUARDRAIL: Do NOT claim machine is in yard unless database verifies it.]
  "हमारे यार्ड में इस कैटेगरी के ऑप्शन्स उपलब्ध रहते हैं। मैं आपकी सटीक रिक्वायरमेंट नोट कर रही हूँ।"
           ↓
[9. Next Action & Professional Close]
  "मैं हमारी सेल्स टीम को आपकी रिक्वायरमेंट भेज रही हूँ, जो आपको फोटो और इंस्पेक्शन रिपोर्ट के साथ व्हाट्सएप पर संपर्क करेंगे। धन्यवाद!"
```

---

## 7. Explainable Lead Scoring Model

Leads are scored systematically based on verifiable operational signals:

| Score Category | Score Criteria (Explainable Rule) | Typical Next Action |
|---|---|---|
| 🔥 **HOT** | - Machine brand & model verified.<br>- Year & running hours captured.<br>- Expected price/budget within realistic market tolerance.<br>- Location known.<br>- Timeline < 15 days or immediate.<br>- Photos/Video available or ready for inspection. | High-priority instant sales manager alert (SMS/WhatsApp/CRM dispatch). |
| 🟡 **WARM** | - Genuine buyer or seller intent.<br>- Model or budget specified, but flexible or pending confirmation.<br>- Timeline within 15–45 days.<br>- Documents or inspection require scheduling. | Nurture sequence; specialist follow-up within 24–48 hours. |
| 🔵 **COLD** | - High-level exploratory curiosity only.<br>- Unrealistic price expectations (e.g. asking 50% above market).<br>- Timeline > 60 days.<br>- Unwilling to share location or phone number. | Periodic digital catalog broadcast; no high-touch phone calls. |
| 🚫 **DO_NOT_CALL** | - Explicit opt-out requested ("don't call me", "remove my number").<br>- Abusive or hostile response.<br>- Wrong number confirmed twice. | **Instant suppression** in database & exclusion from all dialers. |

---

## 8. Machine Master Data & Normalization Schema

The Indian used excavator market revolves around standardized tonnage segments and model nomenclatures.

```json
{
  "machine_master_schema": {
    "brand": "Tata Hitachi",
    "model": "EX 200",
    "category": "Tracked Hydraulic Excavator",
    "tonnage_class": "20-Ton",
    "aliases": ["EX200", "EX 200LC", "EX 200 Super", "Tata 200", "Hitachi 200"]
  }
}
```

### Representative Brand & Model Reference in Indian Market:
- **Tata Hitachi:** EX 200, EX 210, EX 130, Zaxis 220, Zaxis 140
- **JCB:** JS 205, JS 215, JS 140, JS 81, 3DX (Backhoe reference)
- **Hyundai:** Robex R210, R215, R140, Smart Plus
- **Komatsu:** PC 200, PC 210
- **Kobelco:** SK 210, SK 220
- **Sany:** SY 215, SY 140
- **Caterpillar / CAT:** 320D, 320, 320NG
- **Volvo:** EC 210, EC 200

> [!IMPORTANT]
> Real company machine availability and pricing will be strictly grounded in official inventory databases. The AI will never invent machine availability.

---

## 9. Knowledge Base Transformation Plan

Transformation of `docs/VAANI-KNOWLEDGE-BASE.md`:
- **Retain:**
  - Company identity (RapidX)
  - Agent persona (Vaani: warm, natural Hindi/Hinglish, 1–2 sentence brevity)
  - Barging-in behavior and speech acoustics
  - Privacy, safety, and strict opt-out / DND handling
  - Negative guardrails regarding financial credentials (no UPI, OTP, or passwords)
- **Transform / Replace:**
  - Replace salon appointment booking with **Machine Physical Inspection / Yard Visit Scheduling**.
  - Replace generic business reception with **Used Excavator Buying & Selling Protocols**.
  - Replace per-minute software pricing with commercial clarity: Vaani discusses equipment pricing parameters, not arbitrary software rates during sales calls.
- **Strict Fact Partitioning:**
  - **Verified Facts:** Company identity, agent capability, inspection scheduling protocol, opt-out protocol.
  - **Information Pending Confirmation:** Current active stock list, exact yard addresses across states, refurbishment warranty terms.
  - **Negative Guardrails:** Never state a machine is available without database lookup; never confirm a purchase price autonomously; never guarantee inspection outcomes.

---

## 10. Human Calling Data — Analysis Pending

> ### ⚠️ HUMAN CALLING DATA — ANALYSIS PENDING
> The company has provided **18 real human sales WhatsApp call recordings** in the directory:
> `/Users/ankitsharma/Desktop/call recordingi /`
>
> **Status:** Pending Transcription and Analysis.
>
> **Protocol:**
> 1. No conversational prompts, colloquial Hindi expressions, or negotiation phrasing shall be invented or assumed.
> 2. In Phase 2, a dedicated transcription pipeline will extract:
>    - Real customer opening language and greetings
>    - Natural order of technical questions asked by experienced human evaluators
>    - Common seller objections (e.g., reluctance to quote price first)
>    - Common buyer concerns (e.g., meter tampering, pump health, undercarriage life)
>    - Closing signals and colloquial Hindi/Hinglish negotiation phrasing.

---

## 11. Safety, Governance & Compliance

1. **Zero Hallucination Guardrail:** Vaani must never claim a specific excavator is available, in stock, or reserved unless validated by an official inventory database query.
2. **Autonomous Commitment Guardrail:** Vaani cannot finalize binding commercial contracts, issue formal purchase orders, or promise payment on a live call.
3. **DO_NOT_CALL Suppression:** Automatic, irreversible suppression on any caller opt-out phrase.
4. **Data Isolation:** All customer records remain inside local PostgreSQL (`dograh-local-postgres-1`) with zero unauthorized external transmissions.
5. **Read-Only Verification:** Phase 1 makes zero schema or data mutations to existing working pipelines.

---

## 12. Current Phase 1 Status vs Future Roadmap

- **Phase 1 (Current):** System Audit, Safe Git Checkpoint (`fd44270`), Architecture Definition, Sales Data Model, Funnel & Lifecycle, Outcome Standardization, Human Data Protocol, Dashboard Specification. **(COMPLETE)**
- **Phase 2 (Next Recommended):** Human Call Audio Transcription & Analysis, Excavator Prompt Design, Machine Master Normalization.
- **Phase 3:** PostgreSQL Lead Schema Migration & View Update (`public.vaani_excavator_leads`).
- **Phase 4:** n8n Workflow Expansion to New Outcomes (`price_discussion`, `negotiation`).
- **Phase 5:** Sales Dashboard Implementation & Analytics Visualization.
