# VAANI FOLLOW-UP TEST PLAN
**Phase 6**

## Objectives
Ensure follow-up task generation, idempotency, timing calculations, and status transitions conform to the engine specifications while strictly maintaining multi-tenant boundaries.

## Core Scenarios

1. **Follow-up created after eligible call:** Simulate a processed lead and verify DB row creation in `vaani_follow_up_tasks`.
2. **No follow-up when no action required:** Validate `DISQUALIFIED` leads or DNC requests correctly yield 0 candidate tasks.
3. **SEND_PHOTOS creation:** Validate sellers missing `photos_agreed` trigger a `REQUEST_PHOTOS` task.
4. **SEND_RC creation:** Validate missing `rc_copy_agreed` with uncleared documents triggers `REQUEST_RC`.
5. **CALL_BACK creation:** Validate that when the AI extracts a callback request, a `CALL_BACK` task is created with a +2h due time.
6. **YARD_VISIT creation:** Validate buyers agreeing to a physical inspection trigger `YARD_VISIT` with an `URGENT` priority.
7. **DOCUMENT_COLLECTION creation:** Verify document requirements fallback properly to NOC/RC logic.
8. **Duplicate call processing (Idempotency):** Submitting the same `run_id` payload twice must not create duplicates if the task is `PENDING`/`IN_PROGRESS`.
9. **Complete task:** Validate the transition from `PENDING` -> `COMPLETED` successfully records `completed_by` and `completed_at`.
10. **Reschedule task:** Validate transition from `PENDING` -> `DUE` or updating `due_at` modifies the task correctly.
11. **Cancel task:** Validate transitioning to `CANCELLED` is accepted.
12. **Invalid task ID:** Updating a non-existent task must yield `404`.
13. **Invalid state transition:** Attempting to transition from `COMPLETED` to `PENDING` must yield `422`.
14. **Authentication failure:** Test endpoint with no token -> `401`.
15. **Tenant isolation:** Test with User from Org A attempting to access tasks from Org B -> `404/401`.
16. **Cross-tenant IDOR attempt:** Org A user sending Org B `task_id` in transition payload -> Must fail.
17. **Missing customer:** Validate creation gracefully uses `lead_id` fallback if `customer_id` is blank.
18. **Missing call:** Create task with no source call ID works appropriately.
19. **Unknown next_action:** Must gracefully skip unsupported task creation and rely on generic timeline.
20. **Existing CRM regression:** Ensure Lead 360 API still functions without crashing due to new DB tables.
