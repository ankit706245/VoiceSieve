# VAANI FOLLOW-UP CONTRACT V1
**Phase 6 - Follow-Up Automation**

## Overview
This document defines the normalized object structure for the Follow-Up Engine. The structure guarantees predictable behavior when AI-extracted intents map to deterministic backend CRM follow-ups.

## Normalized Follow-up Object

### Core Schema

- `task_id` (String, NOT NULL)
  - **Source:** Generated programmatically during insertion (`task_${orgId}_${runId}_${task_type}`).
  - **Lifecycle:** Static after creation. Used for idempotency.
  
- `organization_id` (Integer, NOT NULL)
  - **Source:** Inherited from the call run context.
  - **Lifecycle:** Immutable. Used for hard tenant isolation.

- `lead_id` (String, NOT NULL)
  - **Source:** Caller reference (`lead_${runId}`).

- `customer_id` (String, NULLABLE)
  - **Source:** The customer's phone number or reference.

- `task_type` (String, NOT NULL)
  - **Allowed Values:** `CALL_BACK`, `REQUEST_PHOTOS`, `REQUEST_METER_PHOTO`, `REQUEST_RUNNING_VIDEO`, `REQUEST_RC`, `REQUEST_NOC`, `VERIFY_MACHINE`, `MATCH_BUYER`, `FOLLOW_UP_BUYER`, `PRICE_NEGOTIATION`, `SCHEDULE_INSPECTION`, `YARD_VISIT`, `NEGOTIATION_FOLLOW_UP`
  - **Source:** Deterministic map from AI `next_action` or `ev_readiness` state.

- `title` (String, NOT NULL)
  - **Source:** Templated string based on the task type and customer context.

- `description` (String, NULLABLE)
  - **Source:** Business logic contextualization of the task.

- `priority` (String, NOT NULL, DEFAULT 'MEDIUM')
  - **Allowed Values:** `URGENT`, `HIGH`, `MEDIUM`, `LOW`
  - **Source:** Priority engine evaluating temperature (`HOT/WARM`), task_type, and timeline.

- `status` (String, NOT NULL, DEFAULT 'PENDING')
  - **Allowed Values:** `PENDING`, `DUE`, `IN_PROGRESS`, `COMPLETED`, `SKIPPED`, `CANCELLED`
  - **Lifecycle:** Mutated via explicit transition requests.

- `assigned_to` (String, NULLABLE)
  - **Source:** Static mapping based on the `task_type` (e.g. "Yard Technical Evaluator").

- `due_at` (Timestamp, NULLABLE)
  - **Source:** Deterministic calculation using `purchase_timeline` or fallback durations (e.g., 2 hours for `CALL_BACK`, 24 hours for `REQUEST_PHOTOS`, 48 hours default).

- `source_call_id` (Integer, NULLABLE)
  - **Source:** `run_id` of the workflow run that triggered the task.

- `reason` (String, NULLABLE)
  - **Source:** Explanatory field derived from AI extraction or missing evidence triggers.

- `metadata` (JSONB, DEFAULT '{}')
  - **Source:** Relevant call parameters (`lead_temp`, `price_raw`, `qualification_state`).

- `created_at` (Timestamp, NOT NULL, DEFAULT CURRENT_TIMESTAMP)
- `completed_at` (Timestamp, NULLABLE)
- `completed_by` (String, NULLABLE)
