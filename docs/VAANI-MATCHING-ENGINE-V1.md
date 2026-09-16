# VAANI MATCHING ENGINE V1

## Overview
Matching must be **DETERMINISTIC**. The LLM never selects the machine. It normalizes language, and the backend performs constraint matching.

## Result Types
- `EXACT_MATCH`: Machine satisfies all provided constraints natively.
- `ALTERNATIVE_MATCH`: Machine fails 1-2 minor constraints but lies within acceptable alternative mapping (e.g. adjacent tonnage class, +/- 1 year tolerance).
- `NO_MATCH`: No machine meets the requirements or alternative thresholds.

## Matching Rules
1. **Brand**:
   - EXACT: `inventory.brand === buyer.brand`
   - ALTERNATIVE: (CONFIGURABLE / HUMAN-DEFINED) - e.g., if buyer wants JCB, allow Hyundai if within business logic mapping. Otherwise NO_MATCH.
2. **Model**:
   - EXACT: `inventory.model === buyer.model`
   - ALTERNATIVE: Mapped by `vaani-extractor.js` taxonomy (e.g., adjacent model in same tonnage class).
3. **Model Year**:
   - EXACT: `inventory.manufacturing_year` falls within `model_year_min` and `model_year_max`.
   - ALTERNATIVE: +/- 1 year (CONFIGURABLE / HUMAN-DEFINED).
4. **Running Hours**:
   - EXACT: `inventory.hour_meter_reading <= buyer.running_hours_max`.
   - ALTERNATIVE: None.
5. **Budget**:
   - EXACT: `inventory.target_resale_inr <= buyer.budget_max_inr`.
   - ALTERNATIVE: Up to 10% higher than budget (CONFIGURABLE / HUMAN-DEFINED).
6. **Application & Terrain**:
   - EXACT: Machine `application_history` maps to buyer intended application.
   - ALTERNATIVE: `mixed` history can satisfy `soil` requirements.
7. **GST Requirement**:
   - EXACT: Machine billing matches buyer GST requirement.
8. **Location/Yard**:
   - Handled as a sorting heuristic rather than strict filter unless Buyer strictly declines inter-state transport.
9. **Availability/Status**:
   - Must be `certified_ready_in_yard` or `in_sourcing_pipeline`. Reserved/Sold machines always yield NO_MATCH.

## Matching Priority (Sorting)
Candidate machines are filtered and sorted using rule-based priorities rather than opaque scoring:
1. Active/available inventory
2. Machine category / tonnage class compatibility
3. Canonical brand
4. Canonical model
5. Year compatibility
6. Budget compatibility
7. Running hours compatibility
8. Application/terrain compatibility
9. GST compatibility
10. Location relevance

## Match Evidence
Every returned match must include deterministic reasons for matching.
Example:
- `canonical model matched`
- `year satisfies requirement`
- `price satisfies budget`
- `availability confirmed`
Unknown fields (e.g. unknown hours) yield: `UNKNOWN / REQUIRES_VERIFICATION`.

## Alternative Matching
Do not invent arbitrary substitutions. Return NO_MATCH or REQUIRE_HUMAN_REVIEW if no documented data defines a valid alternative (e.g., substituting JCB for Hyundai is strictly prohibited unless defined by Om Shyam Earthmovers policy).
