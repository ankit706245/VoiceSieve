#!/usr/bin/env python3
"""
Phase F — Step 2 Test Suite:
Vaani Natural Hindi/Hinglish Sales Conversation -> Structured Sales Data Engine
================================================================================
Validates all 11 specifications:
1. Existing Extraction Schema compliance
2. Standardized Extraction Pipeline
3. Seller Extraction (Customer, Machine, Application, Condition, Location, Documents, Commercial, Evidence)
4. Buyer Extraction (Requirements, Budget, Urgency, Yard visit; zero machine inventory created)
5. Hindi/Hinglish normalization (Devanagari numerals, lakh, lac, L, ghante, mitti, breaker)
6. Canonical Machine Model normalization & unknown model preservation
7. Safe Value Normalization (Year 2005-2026, Hours 0-50,000, Price in INR, Phone E.164)
8. Source and Confidence tracking (HIGH, MEDIUM, LOW; LOW blocks critical qualification)
9. Conflict Resolution & Self-Correction ("2020... nahi nahi 2019", "25 lakh... actually 24 lakh")
10. Missing Information Engine (CAPTURED, MISSING, AMBIGUOUS sets)
11. Targeted Follow-Up Question Generation
12. Compliance & DNC Override
13. API & Ingestion Webhook Integration (POST /api/v1/vaani/extract & POST /api/v1/vaani/calls/complete)
"""

import json
import os
import subprocess
import unittest
import urllib.request
import urllib.error

BASE_URL = "http://localhost:8787"

def get_ingestion_secret():
    secret = os.getenv("VAANI_INGESTION_SECRET", "")
    if not secret and os.path.exists(".env"):
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VAANI_INGESTION_SECRET="):
                    secret = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    return secret

SECRET_KEY = get_ingestion_secret()


def call_extract_api(payload):
    req = urllib.request.Request(
        f"{BASE_URL}/api/v1/vaani/extract",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SECRET_KEY}"
        }
    )
    with urllib.request.urlopen(req) as resp:
        return resp.getcode(), json.loads(resp.read().decode("utf-8"))


def call_ingest_api(payload):
    req = urllib.request.Request(
        f"{BASE_URL}/api/v1/vaani/calls/complete",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {SECRET_KEY}"
        }
    )
    with urllib.request.urlopen(req) as resp:
        return resp.getcode(), json.loads(resp.read().decode("utf-8"))


class TestVaaniExtractionEngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clean_test_data()

    @classmethod
    def tearDownClass(cls):
        cls.clean_test_data()

    @classmethod
    def clean_test_data(cls):
        sql = """
        DELETE FROM vaani_digital_evidence WHERE run_id IN (900201, 900202);
        DELETE FROM vaani_machines WHERE source_lead_run_id IN (900201, 900202) OR machine_id IN ('mach_run_900201', 'mach_run_900202');
        DELETE FROM vaani_dnc_registry WHERE run_id IN (900201, 900202);
        DELETE FROM workflow_runs WHERE id IN (900201, 900202);
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres"],
            input=sql.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )

    def test_01_seller_complete_turn_extraction(self):
        """Seller gives machine details across conversation turns."""
        turns = [
            {"speaker": "agent", "text": "Namaste, Shyam Earthmover se Vaani bol rahi hoon. Aapko machine bechni hai ya leni hai?"},
            {"speaker": "caller", "text": "Ji mere paas Tata 200 hai bechne ke liye."},
            {"speaker": "agent", "text": "Tata 200 kaunse saal ka model hai sir?"},
            {"speaker": "caller", "text": "2019 model hai, 6500 ghante chali hai."},
            {"speaker": "agent", "text": "Machine mitti ke kaam mein chali hai ya breaker pe?"},
            {"speaker": "caller", "text": "Sirf mitti ka kaam hai, pump aur engine original sealed hai."},
            {"speaker": "agent", "text": "Abhi machine kaunse shahar mein khadi hai?"},
            {"speaker": "caller", "text": "Satara mein khadi hai, finance clear hai NOC mil jayegi."},
            {"speaker": "agent", "text": "Expected selling price kitna hai sir?"},
            {"speaker": "caller", "text": "24 lakh mein denge final."},
            {"speaker": "agent", "text": "Aap WhatsApp par photos bhejenge?"},
            {"speaker": "caller", "text": "Haan photos WhatsApp kar deta hoon aur 30 second ka running video bhi bhej dunga."}
        ]

        code, res = call_extract_api({"transcript": turns})
        self.assertEqual(code, 200)

        ext = res["extracted"]
        self.assertEqual(ext["customer_type"], "seller")
        self.assertEqual(ext["machine_details"]["brand"], "Tata Hitachi")
        self.assertEqual(ext["machine_details"]["model"], "EX 200 LC")
        self.assertEqual(ext["machine_details"]["model_year"], 2019)
        self.assertEqual(ext["machine_details"]["running_hours"], 6500)
        self.assertEqual(ext["machine_details"]["application_history"], "soil_earthwork")
        self.assertEqual(ext["machine_details"]["location_city"], "Satara")
        self.assertEqual(ext["machine_details"]["location_state"], "Maharashtra")
        self.assertEqual(ext["machine_details"]["document_status"], "all_clear_noc_ready")
        self.assertEqual(ext["commercial_terms"]["expected_price_inr"], 2400000)
        self.assertTrue(ext["evidence_readiness"]["photos_agreed"])
        self.assertTrue(ext["evidence_readiness"]["running_video_agreed"])
        self.assertEqual(ext["condition_details"]["engine"], "original_sealed")

        # Qualification & temperature
        self.assertEqual(res["qualification_state"], "QUALIFIED")
        self.assertEqual(res["lead_temperature"], "HOT")
        self.assertEqual(res["conversation_outcome"], "lead_qualified")

    def test_02_buyer_extraction_and_urgency(self):
        """Buyer requirement with budget, timeline, and yard visit."""
        turns = [
            {"speaker": "agent", "text": "Namaste, main Vaani bol rahi hoon. Aapko excavator machine purchase karni hai?"},
            {"speaker": "caller", "text": "Haan mujhe 20 ton ki Tata chahiye road work ke liye urgent."},
            {"speaker": "agent", "text": "Aapka budget kitna hai sir?"},
            {"speaker": "caller", "text": "25 se 28 lakh tak ka budget hai, Jaipur yard aake dekhunga."}
        ]

        code, res = call_extract_api({"transcript": turns})
        self.assertEqual(code, 200)

        ext = res["extracted"]
        self.assertEqual(ext["customer_type"], "buyer")
        self.assertEqual(ext["machine_details"]["tonnage_class"], "20_ton_class")
        self.assertEqual(ext["commercial_terms"]["budget_max_inr"], 2800000)
        self.assertEqual(ext["commercial_terms"]["budget_min_inr"], 2500000)
        self.assertEqual(ext["commercial_terms"]["purchase_timeline"], "immediate_within_7_days")
        self.assertTrue(ext["commercial_terms"]["yard_visit_agreed"])

        # Buyer Hot qualification
        self.assertEqual(res["lead_temperature"], "HOT")
        self.assertEqual(res["next_action"], "SCHEDULE_YARD_VISIT")

    def test_03_hindi_numerals_and_price_variations(self):
        """Supports lakh, lac, L, Devanagari numerals, and हजार without guessing bare numbers."""
        test_phrases = [
            ("24.5 lakh", 2450000),
            ("24.5 L", 2450000),
            ("24 लाख", 2400000),
            ("२४ लाख", 2400000),
            ("२४.५ लाख", 2450000),
            ("50 हजार", 50000),
            ("1.5 crore", 15000000),
        ]

        for phrase, expected_inr in test_phrases:
            turns = [{"speaker": "caller", "text": f"bechna hai rate {phrase} hai"}]
            code, res = call_extract_api({"transcript": turns})
            self.assertEqual(code, 200)
            self.assertEqual(res["extracted"]["commercial_terms"]["expected_price_inr"], expected_inr, f"Failed for {phrase}")

        # Ambiguous numbers without units must NOT be guessed as price
        turns_ambiguous = [{"speaker": "caller", "text": "hum 24 mein soch rahe hain"}]
        code, res = call_extract_api({"transcript": turns_ambiguous})
        self.assertEqual(code, 200)
        self.assertIsNone(res["extracted"]["commercial_terms"]["expected_price_inr"])

    def test_04_canonical_machine_model_normalization(self):
        """Preserves canonical machine taxonomy and aliases without guessing unknown models."""
        mappings = [
            ("Tata 200 bechni hai", "Tata Hitachi", "EX 200 LC", "20_ton_class"),
            ("EX 210 LC hai", "Tata Hitachi", "EX 210 LC", "21_ton_class"),
            ("EX 215 LC bechna hai", "Tata Hitachi", "EX 215 LC", "21_ton_class"),
            ("EX 225 LC hai", "Tata Hitachi", "EX 225 LC", "21_ton_class"),
            ("ZAXIS 370 LCH khadi hai", "Tata Hitachi", "ZAXIS 370 LCH", "30_plus_ton_class"),
            ("JCB 205 hai", "JCB", "JS 205", "20_ton_class"),
            ("JCB 215 excavator", "JCB", "JS 215 / JS 220", "21_ton_class"),
            ("Hyundai 210 hai", "Hyundai", "Robex R210-7", "21_ton_class"),
            ("Komatsu 210 hai", "Komatsu", "PC 210-10M0", "21_ton_class"),
            ("Kobelco 210", "Kobelco", "SK 210 SuperX", "21_ton_class"),
            ("Sany 215 hai", "Sany", "SY 215C", "21_ton_class"),
            ("Poclain machine hai", "Other", "Generic Hydraulic Excavator", "any"),
        ]

        for phrase, exp_brand, exp_model, exp_tonnage in mappings:
            turns = [{"speaker": "caller", "text": f"mere paas {phrase}"}]
            code, res = call_extract_api({"transcript": turns})
            self.assertEqual(code, 200)
            self.assertEqual(res["extracted"]["machine_details"]["brand"], exp_brand)
            self.assertEqual(res["extracted"]["machine_details"]["model"], exp_model)
            self.assertEqual(res["extracted"]["machine_details"]["tonnage_class"], exp_tonnage)

        # Unknown model: preserve raw, model null
        turns_unknown = [{"speaker": "caller", "text": "mere paas Caterpillar 320D hai"}]
        code, res = call_extract_api({"transcript": turns_unknown})
        self.assertEqual(code, 200)
        self.assertEqual(res["extracted"]["machine_details"]["brand"], "Caterpillar")
        self.assertIsNone(res["extracted"]["machine_details"]["model"])

    def test_05_conflict_resolution_and_self_correction(self):
        """Customer corrects themselves: latest explicit statement wins."""
        # 1. Year self-correction inside single turn
        turns1 = [{"speaker": "caller", "text": "2020 model hai... nahi nahi, 2019 model hai."}]
        code, res1 = call_extract_api({"transcript": turns1})
        self.assertEqual(code, 200)
        self.assertEqual(res1["extracted"]["machine_details"]["model_year"], 2019)
        self.assertTrue(len(res1["correction_history"]) >= 1)

        # 2. Price self-correction across multiple turns
        turns2 = [
            {"speaker": "caller", "text": "25 lakh mein denge."},
            {"speaker": "caller", "text": "Actually nahi nahi, 24 lakh final rate hai."}
        ]
        code, res2 = call_extract_api({"transcript": turns2})
        self.assertEqual(code, 200)
        self.assertEqual(res2["extracted"]["commercial_terms"]["expected_price_inr"], 2400000)
        self.assertTrue(len(res2["correction_history"]) >= 1)

    def test_06_source_provenance_and_confidence(self):
        """Every field has provenance and confidence tag."""
        turns = [
            {"speaker": "caller", "text": "Tata 200 hai 2019 model Satara mein khadi hai 24 lakh mein denge"}
        ]
        code, res = call_extract_api({"transcript": turns})
        self.assertEqual(code, 200)

        prov = res["provenance"]
        self.assertIn("machine_details.brand", prov)
        self.assertEqual(prov["machine_details.brand"]["confidence"], "HIGH")
        self.assertIn("commercial_terms.expected_price_inr", prov)
        self.assertEqual(prov["commercial_terms.expected_price_inr"]["confidence"], "HIGH")

    def test_07_missing_information_and_follow_up_generator(self):
        """Identifies captured vs missing dimensions and generates authentic follow-up question."""
        # Only model known
        turns1 = [{"speaker": "caller", "text": "Tata 200 bechni hai"}]
        code, res1 = call_extract_api({"transcript": turns1})
        self.assertEqual(code, 200)

        missing1 = res1["missing_info"]["missing"]
        captured1 = res1["missing_info"]["captured"]
        self.assertIn("model", captured1)
        self.assertIn("year", missing1)
        self.assertIn("city", missing1)
        self.assertIn("asking_price", missing1)

        # Highest priority missing dimension is year
        self.assertIn("kaunse saal ka model hai", res1["follow_up_question"])

        # Ambiguous location (Kishangarh without district)
        turns2 = [{"speaker": "caller", "text": "Tata 200 hai 2019 model Kishangarh mein khadi hai"}]
        code, res2 = call_extract_api({"transcript": turns2})
        self.assertEqual(code, 200)
        self.assertIn("location_city", res2["missing_info"]["ambiguous"])
        self.assertIn("Ajmer highway wala hai ya Alwar wala", res2["follow_up_question"])

    def test_08_dnc_compliance_override(self):
        """Compliance trigger immediately marks DNC and DISQUALIFIED."""
        turns = [
            {"speaker": "caller", "text": "Dobara phone mat karna number hatao hamara"}
        ]
        code, res = call_extract_api({"transcript": turns})
        self.assertEqual(code, 200)
        self.assertTrue(res["extracted"]["dnc_requested"])
        self.assertEqual(res["qualification_state"], "DISQUALIFIED")
        self.assertEqual(res["next_action"], "DNC_SUPPRESS")
        self.assertIn("दोबारा संपर्क नहीं करेंगे", res["follow_up_question"])

    def test_09_ingestion_with_transcript_persistence(self):
        """Ingests call with transcript into PostgreSQL, verifying extraction_audit and no fake inventory for buyers."""
        buyer_run_id = 900201
        buyer_payload = {
            "primary_phone": "+919876543299",
            "call_metadata": {
                "run_id": buyer_run_id,
                "duration_seconds": 90,
                "direction": "inbound"
            },
            "transcript": [
                {"speaker": "agent", "text": "Namaste, Shyam Earthmover se Vaani bol rahi hoon."},
                {"speaker": "caller", "text": "Mujhe 20 ton ki Tata 200 chahiye Jaipur delivery ke liye. Budget 26 lakh hai."}
            ]
        }

        code, res = call_ingest_api(buyer_payload)
        self.assertEqual(code, 201)
        self.assertEqual(res["run_id"], buyer_run_id)

        # Verify PostgreSQL: buyer should NOT have created a machine record in vaani_machines
        db_check = subprocess.check_output([
            "docker", "exec", "dograh-local-postgres-1",
            "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
            f"SELECT count(*) FROM vaani_machines WHERE source_lead_run_id = {buyer_run_id};"
        ]).decode("utf-8").strip()
        self.assertEqual(int(db_check), 0, "Buyer lead should not create machine inventory!")

        # Seller lead SHOULD create a machine record
        seller_run_id = 900202
        seller_payload = {
            "primary_phone": "+919876543298",
            "call_metadata": {
                "run_id": seller_run_id,
                "duration_seconds": 110,
                "direction": "inbound"
            },
            "transcript": [
                {"speaker": "agent", "text": "Namaste, Vaani bol rahi hoon."},
                {"speaker": "caller", "text": "Tata 200 bechni hai 2019 model Satara mein khadi hai 24 lakh mein denge. Mitti mein chali hai."}
            ]
        }

        code_s, res_s = call_ingest_api(seller_payload)
        self.assertEqual(code_s, 201)

        db_check_s = subprocess.check_output([
            "docker", "exec", "dograh-local-postgres-1",
            "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
            f"SELECT count(*) FROM vaani_machines WHERE source_lead_run_id = {seller_run_id};"
        ]).decode("utf-8").strip()
        self.assertEqual(int(db_check_s), 1, "Seller lead should create machine inventory!")

        # Verify gathered_context has extraction_audit
        audit_check = subprocess.check_output([
            "docker", "exec", "dograh-local-postgres-1",
            "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
            f"SELECT (gathered_context -> 'extraction_audit') IS NOT NULL FROM workflow_runs WHERE id = {seller_run_id};"
        ]).decode("utf-8").strip()
        self.assertEqual(audit_check, "t", "workflow_runs must contain extraction_audit")

    def test_10_prompt_exact_phrases_verification(self):
        """Verifies the exact phrases specified in Section 5 of the prompt."""
        exact_checks = [
            ("20 ton ki Tata chahiye", lambda ext: ext["machine_details"]["tonnage_class"] == "20_ton_class"),
            ("2020 model hai", lambda ext: ext["machine_details"]["model_year"] == 2020),
            ("4500 ghante chali hai", lambda ext: ext["machine_details"]["running_hours"] == 4500),
            ("mitti ka kaam hai", lambda ext: ext["machine_details"]["application_history"] == "soil_earthwork"),
            ("breaker mein chalayi hai", lambda ext: ext["machine_details"]["application_history"] == "rock_breaker"),
            ("24 lakh mein denge", lambda ext: ext["commercial_terms"]["expected_price_inr"] == 2400000),
            ("Jaipur mein khadi hai", lambda ext: ext["machine_details"]["location_city"] == "Jaipur"),
            ("photos WhatsApp kar deta hoon", lambda ext: ext["evidence_readiness"]["photos_agreed"] is True),
            ("RC bhej dunga", lambda ext: ext["evidence_readiness"]["rc_copy_agreed"] is True),
            ("finance nahi hai", lambda ext: ext["machine_details"]["document_status"] == "all_clear_noc_ready"),
        ]

        for phrase, condition in exact_checks:
            code, res = call_extract_api({"transcript": [{"speaker": "caller", "text": phrase}]})
            self.assertEqual(code, 200, f"Call failed for '{phrase}'")
            self.assertTrue(condition(res["extracted"]), f"Condition failed for exact prompt phrase: '{phrase}'")

    def test_11_value_guardrails_rejections(self):
        """Rejects impossible years, invalid hours, and low confidence qualification."""
        # 1. Reject future or impossible year
        turns_future = [{"speaker": "caller", "text": "2035 model hai"}]
        code, res = call_extract_api({"transcript": turns_future})
        self.assertEqual(code, 200)
        self.assertIsNone(res["extracted"]["machine_details"]["model_year"])

        # 2. Reject impossible hours (>50,000)
        turns_hours = [{"speaker": "caller", "text": "95000 ghante chali hai"}]
        code, res = call_extract_api({"transcript": turns_hours})
        self.assertEqual(code, 200)
        self.assertIsNone(res["extracted"]["machine_details"]["running_hours"])

        # 3. Low-confidence location does NOT satisfy critical qualification gate
        turns_low_conf = [
            {"speaker": "caller", "text": "Tata 200 hai 2019 model Kishangarh mein khadi hai 24 lakh mein denge"}
        ]
        code, res = call_extract_api({"transcript": turns_low_conf})
        self.assertEqual(code, 200)
        # Location is ambiguous so geographic dimension is LOW confidence -> cannot be QUALIFIED
        self.assertEqual(res["qualification_state"], "PARTIALLY_QUALIFIED")
        self.assertIn("location_city", res["missing_info"]["ambiguous"])


if __name__ == "__main__":
    unittest.main()
