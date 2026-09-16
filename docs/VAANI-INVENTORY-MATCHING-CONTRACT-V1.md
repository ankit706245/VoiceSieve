# VAANI INVENTORY MATCHING CONTRACT V1

## Overview
This document defines how the `vaani_machines` table translates into fields that the Sales Brain uses for matching versus those meant only for display, ensuring internal financial and sourcing data remains isolated.

## 1. Matchable Fields
These fields are used actively in the matching criteria constraint solver.

- `brand`: Machine manufacturer (e.g. "Tata Hitachi", "JCB").
- `model`: Canonical model name (e.g. "EX 210 LC").
- `manufacturing_year`: Defines if the machine meets buyer age requirement.
- `hour_meter_reading`: Can be matched if buyer requests low-usage machines.
- `application_history`: For mapping terrain/usage capabilities (soil, rock).
- `status`: Only machines in specific status states (e.g., `certified_ready_in_yard`, `in_sourcing_pipeline`) are eligible for matching.
- `current_location`: Used to filter or sort based on geographic proximity.

## 2. Display-Only Fields
These fields are passed to the Vaani Seller/Buyer conversation contexts but do NOT constrain the core match logic, merely providing context for human-like narration.

- `machine_id`: The system tracking reference.
- `created_at` / `updated_at`: Operational timestamps.

## 3. Sensitive / Internal Fields (NEVER EXPOSED)
These fields MUST NEVER be included in conversational prompts or returned to the LLM during matching.

- `sourcing_cost_inr`: Original purchase cost of the machine.
- `target_resale_inr`: Internal target price (Vaani only ever uses "Asking Price", never reveals the bottom line `target_resale_inr`). *Note: In some legacy logic, this was used as a crude budget match limit, but it must NOT be directly exposed to the buyer via the LLM.*
- `source_lead_run_id`: The seller that provided the machine (privacy boundary).
