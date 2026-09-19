# VAANI FOLLOW-UP ENGINE V1
**Phase 6 - Design**

## Architecture Overview
The Follow-Up Engine acts as an asynchronous processor triggered after call completion, translating AI conversational context into actionable CRM lifecycle events.

### Components

1. **Extraction Normalization**
   - Receives variables (such as `next_action`, `lead_temp`, `ev_readiness`) from the completed transcript.
   
2. **Task Evaluator (`buildCandidateTasks`)**
   - Applies deterministic rules to map variables to `TASK_TYPES`.
   - Rejects tasks for `DISQUALIFIED` and `DNC`.
   
3. **Priority & Timing Dispatcher**
   - Assigns priority based on `customer_type` and urgency logic (e.g. `URGENT` for Hot immediate visits).
   - Resolves `due_at` from extracted datetime or defaults based on SLA (e.g., +2 hours for Callbacks).

4. **Storage Layer (`vaani_follow_up_tasks`)**
   - Multi-tenant isolated storage.
   - Idempotent inserts via `task_id` predictable composition (`task_{org}_{run}_{type}`).

5. **API & UI Layer**
   - `/api/vaani/sales/follow-ups`: Serves partitioned lists (`due_today`, `overdue`, `upcoming`).
   - `/api/vaani/sales/tasks/transition`: Handles lifecycle changes according to state machine rules.

## Deterministic Rules
- **No LLM Task Generation**: The LLM *only* extracts intent. The backend maps to hard-coded `TASK_TYPES`.
- **Tenant Scope**: All DB queries inherently filter on `organization_id = $1`.
- **Idempotency**: Repeated webhooks will gracefully ignore already pending tasks.
