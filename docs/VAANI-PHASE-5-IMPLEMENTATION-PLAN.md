# VAANI PHASE 5 IMPLEMENTATION PLAN

## 1. Files to Modify
- `dashboard/lib/vaani-sales.js`: Implement the deterministic matching logic, removing the rudimentary `brandMatch && budgetMatch` logic currently used.
- `dashboard/lib/vaani-extractor.js`: Ensure normalization accurately maps colloquial buyer requirements to the contract fields.
- `dashboard/server.js`: Add API endpoints for the matching engine.

## 2. New Files
- `test_phase_g_buyer_matching.py`: Automation script covering the 20 test cases defined in the Test Plan.

## 3. Database Changes
- Add table `vaani_buyer_machine_matches`:
  - `id` (PK)
  - `organization_id` (FK to organizations)
  - `source_lead_run_id` (FK to workflow_runs)
  - `inventory_machine_id` (FK to vaani_machines)
  - `match_type` (EXACT_MATCH, ALTERNATIVE_MATCH, NO_MATCH)
  - `evidence_json` (JSONB)
  - `created_at`

## 4. API Changes
- New Endpoint: `POST /api/vaani/buyers/:id/matches`
  - Input: Buyer Requirement JSON
  - Output: List of matched machines and evidence.
  - Action: Invokes matching engine, saves to DB, returns results without sensitive fields.

## 5. Dograh Changes
- No structural changes to Dograh Workflow 3. The `check_live_inventory` tool integration will be mapped to call `POST /api/vaani/buyers/:id/matches` when a buyer asks about specific machines.

## 6. UI Changes
- No structural redesign. 
- Introduce a "Matches" tab or section inside the Lead 360 view (`/vaani-sales.html`) to display the deterministic matches saved in `vaani_buyer_machine_matches`.

## 7. Security Changes
- Ensure `POST /api/vaani/buyers/:id/matches` resolves `orgId` via `resolveOrganizationId(ctx)`.
- Explicitly delete `sourcing_cost_inr` and `target_resale_inr` from any matching API response.

## 8. Tests
- Execute `test_phase_g_buyer_matching.py`.
- Re-run `test_phase_e_backend_auth.py` and `test_phase_f_extraction.py` to guarantee no regressions.

## 9. Rollback Plan
- Drop `vaani_buyer_machine_matches` table.
- Revert `dashboard/lib/vaani-sales.js` and `dashboard/server.js` from Git history.

## 10. Deployment Considerations
- Database migration script for `vaani_buyer_machine_matches`.
- Restart Node.js backend.
- Ensure all tests pass in staging before production rollout.
