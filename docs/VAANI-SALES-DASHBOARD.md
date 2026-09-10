# Vaani — Used Excavator Sales Dashboard Specification
**Document:** `docs/VAANI-SALES-DASHBOARD.md`  
**Version:** 1.0 (Phase 1 Architecture)  
**Status:** Requirements & Specification Only (Visual Redesign Pending Phase 2/3)  
**Product:** RapidX / Vaani AI Used Excavator Sales & Calling Agent  

---

## 1. Executive Summary & Purpose

The Vaani Sales Dashboard will serve as the single pane of glass for monitoring, analyzing, and acting upon all inbound and outbound sales interactions for RapidX's used excavator business.

### Core Business Model:
1. **Purchase / Seller Side:** Sourcing, evaluating, and purchasing pre-owned/used excavators from sellers across India.
2. **Refurbishment:** Internal inspection, servicing, and refurbishing of acquired machines.
3. **Sale / Buyer Side:** Marketing, qualifying, and reselling inspected/refurbished excavators to contractors, plant hirers, and infrastructure companies.

---

## 2. Dashboard Architecture & Sections

The future Vaani Sales Dashboard (`http://localhost:8787/vaani-sales.html` or unified console) will be structured into seven dedicated operational sections:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       VAANI EXCAVATOR SALES CONSOLE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ [1] TOP KPI METRICS (Cards Grid: Total, Connected, Leads, Temperatures)     │
├─────────────────────────────────────────────────────────────────────────────┤
│ [2] CALL ANALYTICS & VOLUME   │  [3] LEAD STAGE FUNNEL                      │
│     (Inbound/Outbound/Rates)  │      (New → Contacted → ... → Won/Lost)     │
├─────────────────────────────────────────────────────────────────────────────┤
│ [4] CUSTOMER & LEAD TABLE (Tabs: All | Sellers | Buyers | Follow-ups | DNC) │
├─────────────────────────────────────────────────────────────────────────────┤
│ [5] MACHINE & INVENTORY DEMAND ANALYTICS (Brands, Models, Tonnage, Tiers)   │
├─────────────────────────────────────────────────────────────────────────────┤
│ [6] CALL LOGS & INTERACTION DETAIL DRAWER (Audio, Transcript, Extraction)   │
├─────────────────────────────────────────────────────────────────────────────┤
│ [7] FOLLOW-UP & ACTION DISPATCH QUEUE (Due Today, Overdue, Scheduled)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Section Specifications

### Section 1: Top KPI Metrics
A high-contrast, real-time KPI card deck displaying:
- **Total Calls:** All voice interactions logged across telephony and WebRTC test channels.
- **Connected Calls:** Total calls where conversation actually took place (duration > 15s).
- **Not Connected / Dropped:** Unanswered, busy, or failed call connection attempts.
- **Unique Customers Contacted:** Deduplicated phone number count.
- **Interested Customers:** Calls with outcome `interested`, `price_discussion`, or `lead_qualified`.
- **Qualified Leads:** Verified leads with complete machine, budget/price, and location details.
- **Lead Temperature Distribution:**
  - 🔥 **Hot Leads:** Immediate intent (<7 days), price aligned, photos/specs confirmed.
  - 🟡 **Warm Leads:** Intent within 30 days, flexible budget, genuine interest.
  - 🔵 **Cold Leads:** Long-term curiosity (>60 days) or unrealistic price expectations.
- **Follow-ups Due Today:** Leads requiring immediate specialist or sales manager contact.
- **Closed Won:** Deals successfully converted into purchase or sale.
- **Closed Lost:** Deals passed, sold elsewhere, or cancelled.
- **Do Not Call (DNC):** Suppressed numbers requesting opt-out.

---

### Section 2: Call Analytics & Volume
- **Directional Split:**
  - Inbound Calls (customers calling RapidX helpline/ads)
  - Outbound Calls (automated follow-ups, seller acquisition, or quote updates)
- **Disposition Tracking:**
  - Connected
  - No Answer
  - Busy / Network Barred
  - Failed / Invalid Number
- **Connection Rate KPI:** `(Connected Calls / Total Calls) * 100%`
- **Temporal Trends:** Interactive volume bar/area chart showing call activity by Hour, Day, Week, and Month.

---

### Section 3: Lead Stage Funnel
Visual stage-progression funnel representing customer progression:
```
Total Inbound/Outbound Calls (100%)
       ↓
Connected Calls (e.g. 78%)
       ↓
Interested Customers (e.g. 45%)
       ↓
Qualified Leads (Seller Specs / Buyer Budget captured) (e.g. 28%)
       ↓
Price Discussion (e.g. 18%)
       ↓
Negotiation / Inspection (e.g. 10%)
       ↓
Follow-Up (e.g. 8%)
       ↓
Closed Won (Purchased or Sold) / Closed Lost
```

---

### Section 4: Customer & Lead Table
The central operational data grid. Includes tabs:
- **All Customers**
- **Sellers (Used Machine Offerings)**
- **Buyers (Machine Procurement Requirements)**
- **Follow-ups Due**
- **Do Not Call (Suppressed)**

#### Table Columns:
1. **Customer ID & Name:** Caller name or business identifier.
2. **Contact Number:** Masked or E.164 phone number.
3. **Type Badge:** `SELLER` (Blue) or `BUYER` (Emerald).
4. **Machine Details:**
   - For Sellers: `Brand Model (Year, Hours)` e.g., *Tata Hitachi EX 200 (2018, 6200 hrs)*
   - For Buyers: `Requested Brand / Model / Tonnage` e.g., *JCB JS 205 or 20-Ton Class*
5. **Location:** City, District, State.
6. **Commercial Summary:**
   - Sellers: Expected Selling Price (₹ Lakhs)
   - Buyers: Budget Bracket (₹ Lakhs)
7. **Lead Temperature:** `HOT`, `WARM`, `COLD`, `DNC`.
8. **Current Stage:** Dropdown selector showing lifecycle stage.
9. **Last Interaction:** Timestamp and call duration.
10. **Next Follow-up:** Scheduled date and time.
11. **Outcome Badge:** Standardized call outcome.
12. **Actions:** View Transcript, Listen Audio, Manual Stage Override, Export to CRM.

---

### Section 5: Machine & Inventory Demand Analytics
Helps management understand market supply and demand imbalances:
- **Top Demanded Excavator Brands:** (e.g., Tata Hitachi, JCB, Hyundai, Komatsu, Sany, Kobelco, Volvo, CAT).
- **Top Demanded Models / Tonnage Classes:**
  - Mini Excavators (< 10 Ton)
  - Medium / 20-Ton Class (10–22 Ton) — largest Indian market segment
  - Heavy / Mining Class (> 30 Ton)
- **Supply vs. Demand Matrix:** Comparison of machines offered by sellers vs. machines requested by buyers.
- **Geographic Supply Heatmap:** Sourcing clusters (e.g., Maharashtra, Gujarat, MP, Rajasthan, Odisha).

---

### Section 6: Call Detail & Audio Drawer
Clicking on any row opens a side inspection drawer containing:
- **Audio Playback:** Real-time waveform audio player of the recorded conversation.
- **Turn-by-Turn Transcript:** Synchronized Hindi/Hinglish conversation bubbles.
- **Extracted Machine Facts:**
  - Operating hours
  - Machine serial / registration status
  - Major repairs or engine condition
  - Physical inspection availability
  - Photo/Video WhatsApp link placeholder
- **LLM Reasoning & Extraction Notes:** Why the agent classified the lead as Hot/Warm/Cold.

---

## 4. Database Source & Integration

The dashboard will read from the underlying PostgreSQL data layer:
1. **Live View:** `public.vaani_customer_leads` (extended to `public.vaani_excavator_leads` in Phase 2/3).
2. **Raw Telephony & Call Context:** `workflow_runs` table from Dograh engine (`workflow_id = 3`).
3. **Automation & Task States:** n8n static data and execution history.
4. **Local Dashboard API:** `dashboard/server.js` route `/api/vaani/leads` expanded to support excavator parameters:
   - `GET /api/vaani/excavators/leads`
   - `GET /api/vaani/excavators/stats`
   - `POST /api/vaani/excavators/follow-up`

---

## 5. Strict DO_NOT_CALL (DNC) Compliance Handling

A foundational rule of the Vaani Sales Dashboard:
- Any customer record marked with `conversation_outcome: 'opt_out'` or `lead_temperature: 'DO_NOT_CALL'` must be **immediately suppressed** from all automated outbound calling queues, sales follow-up campaigns, and broadcast pipelines.
- **Visual Separation:** DNC contacts are flagged with a prominent Red Badge (`🚫 DNC / SUPPRESSED`).
- **Queue Isolation:** DNC contacts are filtered out of all "Action Required" and "Follow-up" queues.
- **Re-contact Prevention:** Even if a user manually clicks "Trigger Call", the backend API must reject dialing with `403 Number Suppressed by Opt-Out Guardrail`.
- **Audit Trail:** The exact call timestamp and user phrase requesting opt-out is permanently logged for compliance verification.
