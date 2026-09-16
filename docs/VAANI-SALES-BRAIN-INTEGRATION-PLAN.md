# VAANI SALES BRAIN V1 — PRODUCTION INTEGRATION PLAN

Technical execution plan for safely deploying Sales Brain V1 into production after audit and evaluation approval.

---

## Target Component Changes

| Target File / Workflow | Exact Reason | Expected Behavior | Regression Risk | Verification Test | Rollback Method |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Dograh Workflow 3** ( table ID 3 ) | Update node prompts (, ,  buyer/seller) with human sales intelligence. | Natural Hinglish, structured qualification, grounded objection handling, zero workflow narration. | Low (Guarded by prompt sandbox) |  (20 tests) | SQL UPDATE restoring previous JSON snapshot. |
| **Extraction Engine** () | Integrate  and 23-field schema mapping into . | Standardized machine entity resolution, 100% null preservation for missing fields. | Low (Pure data transformation) |  (10 scenarios) | Revert Git diff on . |
| **CRM Summary Engine** () | Display normalized machine model, buyer intent signals, and WhatsApp next actions in . | Clear visualization of call insights & evidence request tasks. | Low (UI visualization only) |  web UI load check | Revert Git diff on . |

---

## Rollback Procedure
In the event of any regression:
1. Execute  to restore previous  backup.
2. Restart .
3. Verify 20/20 regression tests pass via .
