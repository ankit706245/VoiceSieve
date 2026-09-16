# VAANI SALES BRAIN V1 — EVALUATION REPORT

Automated evaluation executed against 10 real human sales call scenarios ().

---

## 1. Executive Summary

- **Total Test Cases Executed**: 10
- **Passed**: 10
- **Failed**: 0
- **Pass Rate**: 100.0%
- **Hallucination Prevention**: 100% (Zero missing values guessed; nulls preserved)
- **Machine Normalization Accuracy**: 100%

---

## 2. Test Case Breakdown

| ID | Scenario | Field Extraction | Machine Normalization | Intent Signal | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **EVAL-01** | Buyer requesting 2024/2025 JS 215 with GST in Jaipur | PASS | PASS (JCB JS215) | HIGH (BUY) | **PASS** |
| **EVAL-02** | Seller offering 2x Komatsu PC210 2019 in Singrauli | PASS | PASS (Komatsu PC210) | HIGH (SELL) | **PASS** |
| **EVAL-03** | Seller offering Tata 370 2019 model (Asking 35L) | PASS | PASS (Tata Hitachi Zaxis 370) | MODERATE (SELL) | **PASS** |
| **EVAL-04** | Buyer inquiry for Sany SY215 2024 in Jaipur yard | PASS | PASS (Sany SY215) | HIGH (BUY) | **PASS** |
| **EVAL-05** | Seller offering Cat 320 2020/21 in Bikaner (Asking 35L) | PASS | PASS (Caterpillar CAT 320) | MODERATE (SELL) | **PASS** |
| **EVAL-06** | Buyer requesting Hyundai 215 2023 in Kuchaman | PASS | PASS (Hyundai R215) | HIGH (BUY) | **PASS** |
| **EVAL-07** | Seller offering Kobelco SK210 in Satara (Asking 25L - High Price) | PASS | PASS (Kobelco SK210) | LOW (SELL - Price Objection) | **PASS** |
| **EVAL-08** | Outbound check call - No machine available | PASS | PASS (Null preserved) | NONE (NOT_INTERESTED) | **PASS** |
| **EVAL-09** | Buyer from Jaisalmer (Dhanraj) seeking multi-brand | PASS | PASS (Multi-Brand) | HIGH (BUY) | **PASS** |
| **EVAL-10** | Seller offering Tata 200 2024 in Karauli (Asking 33L) | PASS | PASS (Tata Hitachi EX200) | HIGH (SELL) | **PASS** |

---

## 3. Discovered Limitations & Remediation

1. **Brand Variant Discrepancy**: "Tata 370" refers to Tata Hitachi Zaxis 370. Mapped canonically in .
2. **Missing Hour-Meter Handling**: When sellers report "meter kharab", hours must be recorded as estimated integer with objection flag .
