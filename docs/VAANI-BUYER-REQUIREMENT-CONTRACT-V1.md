# VAANI BUYER REQUIREMENT CONTRACT V1

## Overview
This document defines the strictly typed, normalized buyer requirement extracted by the LLM and processed by the Vaani Sales Brain. It prevents LLM hallucinations and establishes the constraints used to match buyers to inventory.

## Fields & Normalization

| Field | Type | Nullable | Normalization / Allowed Values | Exact Match Behavior | Evidence Required |
| --- | --- | --- | --- | --- | --- |
| `machine_brand` | `string` | Yes | Canonical brand (e.g., "Tata Hitachi", "JCB") via `vaani-extractor.js`. | If specified, must exact match `inventory.brand` or alternative mapping. | Must be explicitly stated by buyer. |
| `machine_model` | `string` | Yes | Canonical model (e.g., "EX 200 LC"). | If specified, must exact match `inventory.model` or alternative mapping. | Must be explicitly stated by buyer. |
| `model_year_min` | `integer` | Yes | e.g. `2018`. Derived from stated year (e.g., "2018 model chahiye"). | `inventory.manufacturing_year >= model_year_min` | Explicit requirement. |
| `model_year_max` | `integer` | Yes | e.g. `2024`. Derived if buyer says "2018 se 2024 ke beech". | `inventory.manufacturing_year <= model_year_max` | Explicit requirement. |
| `budget_max_inr` | `bigint` | Yes | Converted to INR scale (e.g., 25L -> `2500000`). | `inventory.target_resale_inr <= budget_max_inr` (plus tolerance if configurable) | Explicitly stated price limit. |
| `application` | `string` | Yes | `soil`, `rock`, `mixed`. Normalized from unstructured intent. | Checked against machine's historical `application_history`. | If stated. |
| `gst_required` | `boolean` | Yes | `true`, `false`. | Filter inventory requiring GST if `false`? (Depends on business logic) | If buyer says "net rate" vs "bill pe". |
| `location_preference`| `string` | Yes | Normalized city/state string. | Used for location proximity ranking/filtering. | Explicit preference. |

## Unknown Information Constraint
Missing information **must remain NULL**. The LLM must not guess budgets based on models or assume years based on budgets. If a buyer says "koi 200 ki machine dikhao", `brand` = `NULL`, `model` = `NULL` (or alias normalized if possible), `budget` = `NULL`.
