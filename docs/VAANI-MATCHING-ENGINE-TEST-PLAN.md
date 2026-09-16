# VAANI MATCHING ENGINE TEST PLAN

## Test Cases

1. **Exact match**: Buyer provides brand, model, year, and budget. An exact available machine is returned.
2. **No exact match**: Buyer requests a specific rare model not in inventory. Returns `NO_MATCH` and no alternative.
3. **Budget mismatch**: Machine exists, but its `target_resale_inr` is far above buyer's `budget_max_inr`. Returns `NO_MATCH`.
4. **Year mismatch**: Buyer needs 2024+, only 2018 available. Returns `NO_MATCH`.
5. **Model mismatch**: Buyer requests PC 210, only PC 130 available. Returns `NO_MATCH` or `ALTERNATIVE_MATCH` if tonnage classes are defined as alternatives.
6. **Brand mismatch**: Buyer requests Hyundai 210, only Sany 210 available. Returns `ALTERNATIVE_MATCH` based on business rules.
7. **Unknown year**: Buyer gives no year preference. Machine matches on brand/model. Year marked as `UNKNOWN / REQUIRES_VERIFICATION`.
8. **Unknown budget**: Buyer gives no budget. Machine matches. Budget marked as `UNKNOWN / REQUIRES_VERIFICATION`.
9. **Unknown hours**: Buyer gives no hours. Machine matches. Hours marked as `UNKNOWN / REQUIRES_VERIFICATION`.
10. **Unavailable machine**: Exact match exists but status is `sold` or `reserved`. Returns `NO_MATCH`.
11. **GST requirement**: Buyer needs GST bill, machine is not available with GST bill. Returns `NO_MATCH`.
12. **Tenant isolation**: Org 1 buyer is never matched with Org 2 inventory. 403/Empty array returned.
13. **Sensitive fields**: Response JSON must explicitly exclude `sourcing_cost_inr` and `target_resale_inr`.
14. **Duplicate match**: Same machine is not returned twice for the same requirement.
15. **Buyer with no requirement**: Null inputs handled gracefully. Returns generic recommendations or asks for clarification.
16. **Multiple matching machines**: Ensures sorting prioritizes best fit.
17. **Ambiguous model name**: Buyer says "200 machine". Normalizer maps it to multiple `20-ton` class machines. Returns alternative matches.
18. **Normalized alias**: Buyer says "Tata Hitachi". Normalizer resolves to correct brand and exact matches.
19. **Invalid buyer ID**: Attempting to query matches for non-existent buyer returns 404.
20. **Authentication failure**: Unauthenticated access returns 401 Unauthorized.
