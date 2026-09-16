# VAANI PHASE 5 AUDIT REPORT
**Topic: Buyer → Inventory Intelligent Matching**

## 1. Current Matching Capabilities
- **Existing Logic**: In `dashboard/lib/vaani-sales.js` (lines 508-581), there is a highly rudimentary matching loop: `brandMatch && budgetMatch`.
- **Missing Capabilities**: 
  - No handling of Model Year requirements.
  - No handling of Running Hours.
  - No distinction between EXACT and ALTERNATIVE matches.
  - No evidence generation for why a match was successful.
  - No persistence of matched relationships in the CRM database.
  - No normalization bounds around acceptable budget tolerances.

## 2. Contracts Defined
- **Buyer Requirement Contract**: Documented in `VAANI-BUYER-REQUIREMENT-CONTRACT-V1.md`. Establishes strict typing and behavior for fields (e.g. `model_year_min`, `budget_max_inr`). Ensures missing information remains NULL, preventing LLM hallucinations.
- **Inventory Contract**: Documented in `VAANI-INVENTORY-MATCHING-CONTRACT-V1.md`. Specifies matchable fields (Brand, Model, Year, Hours, Application, Status) vs. sensitive fields (Cost, Target Resale) that are explicitly blocked from exposure.

## 3. Matching Rules & Evidence Design
- Documented in `VAANI-MATCHING-ENGINE-V1.md`.
- **Match Types**: `EXACT_MATCH`, `ALTERNATIVE_MATCH`, `NO_MATCH`.
- **Evidence Generation**: The matching engine returns a structured JSON payload describing exact constraints met (e.g. `canonical model matched`, `year satisfies requirement`). 
- **Alternative Matching**: Limits alternatives to strictly defined business logic (e.g. adjacent tonnage class, +/- 1 year). Disallows arbitrary substitutions.

## 4. CRM & Database Design
- **New Table Required**: `vaani_buyer_machine_matches` is needed because currently `workflow_runs` only links one `source_lead_run_id` to one `machine_id` during seller ingestion. Buyer requirements are many-to-many.
- **Design Documented**: Covered in the Implementation Plan.

## 5. API & Dograh Integration
- **API Design**: `POST /api/vaani/buyers/:id/matches`.
- **Integration**: Dograh Workflow 3 will invoke this endpoint via the `check_live_inventory` tool when the buyer asks for machine availability. The LLM acts solely as a conduit to format the backend's deterministic response.

## 6. Security Design
- All APIs will enforce tenant isolation using the repaired `resolveOrganizationId(ctx)` logic.
- Sensitive inventory financial data (`sourcing_cost_inr`, `target_resale_inr`) will be filtered out before returning results to the LLM or frontend.

## 7. Risks & Open Questions
- **Risk**: Strict matching might return 0 results too often if tolerances are too tight.
- **Risk**: `check_live_inventory` tool implementation inside Dograh might need parameter adjustment to fit the new API signature.
- **Open Question**: Should alternate machine matching (e.g. suggesting Hyundai when JCB is requested) be active by default, or strictly disabled unless explicitly approved by the business owner?

## 8. Exact Implementation Sequence
1. Database migration: Create `vaani_buyer_machine_matches`.
2. Core backend matching engine: Build logic in `dashboard/lib/vaani-sales.js`.
3. API routing: Implement `POST /api/vaani/buyers/:id/matches` in `dashboard/server.js`.
4. Extractor updates: Enhance `dashboard/lib/vaani-extractor.js`.
5. Run matching tests: `test_phase_g_buyer_matching.py`.
6. UI Updates: Add matches tab to Lead 360 in `vaani-sales.html`.

---
PHASE 5 DESIGN/AUDIT COMPLETE — NO PRODUCTION CHANGES MADE
