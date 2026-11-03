# Vaani UI Redesign Plan - Step 1

## Goal
Transform the existing Vaani Sales Command Center from a generic "SaaS/developer" aesthetic into a simple, clean, and industry-appropriate interface for a used-excavator and heavy equipment business. The new UI will feel rugged yet modern, employing a dark charcoal/graphite base with construction yellow/orange accents.

## Visual Direction & Theming
- **Base Background:** Dark charcoal/graphite (e.g., `#1e1e1e` or `#161616`) instead of generic white/blue.
- **Surface/Card Background:** Slightly lighter graphite (e.g., `#2a2a2a`) for subtle contrast.
- **Accent Color:** Construction Yellow/Orange (e.g., `#F9C000` or `#E58A00`) replacing the current SaaS blue/purple/gold.
- **Typography:** Bold, highly legible sans-serif for numbers/headers. No small, faint text.
- **Tone:** Direct, no-nonsense language. Elimination of technical jargon (e.g., avoiding terms like "payload", "endpoint", "ingestion").
- **Styling:** Simple tables, solid borders, industrial feel. Avoid excessive glassmorphism or floating soft shadows.

## View Structure Updates

### 1. Dashboard (Overview)
*Current State:* Technical KPI cards, generic charts.
*Proposed:*
- **Top Row KPIs:** Big, readable numbers for core business metrics: "Active Buyers", "Machines Available", "Follow-ups Due Today", "Calls Made".
- **Recent Activity Feed:** A simple ledger of what just happened (e.g., "Buyer X matched with Excavator Y", "Call with Seller Z completed").
- **Quick Actions:** Prominent buttons to "Add Buyer", "Add Machine", "Start Follow-ups".

### 2. Buyers
*Current State:* Data-heavy list with technical details.
*Proposed:*
- **List/Table:** Clean table showing Buyer Name, Phone, Requirement (e.g., "20 Ton Excavator"), and Urgency/Status.
- **Detail View:** When clicked, shows a robust card with their specific demand (make, model, tonnage) and matched inventory available to pitch them.
- **Action:** Prominent "Call Buyer" or "Match Machine" button.

### 3. Sellers
*Current State:* Standard CRM table.
*Proposed:*
- **List/Table:** Seller Name, Phone, Number of Machines Listed, and Status.
- **Detail View:** Shows the seller's fleet currently on the lot/platform and the date of last contact.
- **Action:** Prominent "Request Stock Update" or "Call Seller" button.

### 4. Inventory (Machines)
*Current State:* Raw data list of items.
*Proposed:*
- **Grid or Dense Table:** Clear visual hierarchy for Machine Type, Tonnage, Make/Model, Year, and Asking Price.
- **Status Indicators:** Simple tags like "Available", "Under Negotiation", "Sold".
- **Detail View:** Focus on machine specs and a list of Buyers who are currently looking for this exact spec.

### 5. Calls & Follow-ups
*Current State:* Separate technical views for call logs and task transitions.
*Proposed:*
- **Consolidated "Action Center":** A daily work-queue for the sales team.
- **Follow-ups Tab:** A checklist of people who need to be called today (missing photos, price negotiations, buyer check-ins).
- **Call History Tab:** A straightforward log of past AI/human calls with outcomes (e.g., "Seller confirmed 2 machines available") rather than raw transcripts.
- **Focus:** Move away from "Tasks" and "Transitions" to simple "To-Do" and "Done" states.

## Next Steps
This plan outlines the structural and aesthetic changes for Step 1. No backend, API, DB, or logic changes will be made. Once approved, we will begin modifying the CSS custom properties and HTML layout in `dashboard/public/vaani-sales.html` one view at a time.
