#!/usr/bin/env python3
"""
Phase D — Integration Test Suite: Vaani Call Ingestion & PostgreSQL Persistence
================================================================================
Validates:
1. POST /api/v1/vaani/calls/complete and POST /api/vaani/calls/complete ingestion
2. Input payload validation and rejection of malformed requests
3. Persistence in PostgreSQL:
   - workflow_runs.gathered_context
   - public.vaani_excavator_sales_leads view
   - public.vaani_machines table (inventory creation/deduplication)
   - public.vaani_digital_evidence table (promised media tracking)
   - public.vaani_dnc_registry (when dnc_requested=true)
4. Read-back verification via GET /api/vaani/sales/leads/:id?demo=0
"""

import unittest
import urllib.request
import urllib.error
import json
import subprocess
import os

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

class TestVaaniCallIngestion(unittest.TestCase):
    TEST_RUN_IDS = (9991, 9992, 9993)
    TEST_PHONES = ("+919999900001", "+919999900002", "+919999900099")

    @classmethod
    def clean_test_data(cls):
        """Safely cleans up only the temporary test records created by this test suite."""
        run_ids_csv = ",".join(str(i) for i in cls.TEST_RUN_IDS)
        phones_csv = ",".join(f"'{p}'" for p in cls.TEST_PHONES)
        mach_ids_csv = ",".join(f"'mach_run_{i}'" for i in cls.TEST_RUN_IDS)
        sql = f"""
        DELETE FROM vaani_digital_evidence WHERE run_id IN ({run_ids_csv});
        DELETE FROM vaani_machines WHERE source_lead_run_id IN ({run_ids_csv}) OR machine_id IN ({mach_ids_csv});
        DELETE FROM vaani_dnc_registry WHERE run_id IN ({run_ids_csv}) OR phone_number IN ({phones_csv});
        DELETE FROM workflow_runs WHERE id IN ({run_ids_csv});
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
            capture_output=True,
            text=True
        )

    @classmethod
    def setUpClass(cls):
        cls.clean_test_data()
        cls.session_token = cls.obtain_session_token()

    @classmethod
    def obtain_session_token(cls):
        cmd = ["node", "-e", "const core = require('./dashboard/lib/core'); (async () => { const tok = await core.createSession(core.db().users[0].id, core.db().users[0].tenantId); console.log(tok); })();"]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return proc.stdout.strip()

    @classmethod
    def tearDownClass(cls):
        cls.clean_test_data()

    def send_post(self, path, payload, token=None):
        headers = {"Content-Type": "application/json"}
        auth_token = token if token is not None else get_ingestion_secret()
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
        req = urllib.request.Request(
            f"{BASE_URL}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers
        )
        try:
            with urllib.request.urlopen(req) as resp:
                status = resp.status
                body = json.loads(resp.read().decode("utf-8"))
                return status, body
        except urllib.error.HTTPError as e:
            body = json.loads(e.read().decode("utf-8"))
            return e.code, body

    def send_get(self, path):
        headers = {}
        if getattr(self, "session_token", None):
            headers["Authorization"] = f"Bearer {self.session_token}"
        req = urllib.request.Request(f"{BASE_URL}{path}", headers=headers)
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))

    def query_psql(self, sql):
        proc = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A"],
            input=sql,
            text=True,
            capture_output=True,
            check=True
        )
        out = proc.stdout.strip()
        return json.loads(out) if out.startswith("{") or out.startswith("[") else out

    def test_01_payload_validation_errors(self):
        """Rejects malformed payloads with missing phone or run_id."""
        # Missing primary_phone
        status, res = self.send_post("/api/v1/vaani/calls/complete", {
            "customer_type": "seller",
            "call_metadata": {"run_id": 9990}
        })
        self.assertEqual(status, 400)
        self.assertEqual(res.get("code"), "missing_primary_phone")

        # Missing run_id
        status, res = self.send_post("/api/v1/vaani/calls/complete", {
            "primary_phone": "+919999900000"
        })
        self.assertEqual(status, 400)
        self.assertEqual(res.get("code"), "missing_run_id")

    def test_02_ingest_seller_call_complete(self):
        """Ingests a verified seller conversation and checks 201 response."""
        seller_payload = {
            "lead_id": "test_lead_phased_9991",
            "customer_name": "Test Seller Ramesh (Phase D Test)",
            "primary_phone": "+919999900001",
            "whatsapp_phone": "+919999900001",
            "customer_type": "seller",
            "ownership_type": "direct_owner",
            "machine_details": {
                "brand": "Tata Hitachi",
                "model": "EX 200 LC",
                "model_year": 2020,
                "running_hours": 4500,
                "tonnage_class": "20_ton_class",
                "application_history": "soil_earthwork",
                "machine_condition_summary": "Single owner soil work, well maintained",
                "location_city": "Jaipur",
                "location_state": "Rajasthan",
                "document_status": "all_clear_noc_ready"
            },
            "commercial_terms": {
                "expected_price_inr": 2400000,
                "budget_max_inr": None,
                "price_or_budget_raw": "24 Lakh",
                "purchase_timeline": "not_applicable",
                "yard_visit_agreed": False,
                "yard_visit_schedule": None
            },
            "evidence_readiness": {
                "photos_agreed": True,
                "running_video_agreed": True,
                "rc_copy_agreed": True,
                "evidence_status": "promised"
            },
            "lead_temperature": "WARM",
            "qualification_state": "QUALIFIED",
            "conversation_outcome": "lead_qualified",
            "next_action": "Schedule technical inspection and verify WhatsApp evidence",
            "follow_up_required": True,
            "follow_up_datetime": "2026-09-15T10:00:00Z",
            "call_notes": "Phase D test run seller lead",
            "dnc_requested": False,
            "call_metadata": {
                "run_id": 9991,
                "duration_seconds": 65
            }
        }

        # Test canonical endpoint: POST /api/v1/vaani/calls/complete
        status, res = self.send_post("/api/v1/vaani/calls/complete", seller_payload)
        self.assertEqual(status, 201)
        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("lead_id"), "test_lead_phased_9991")
        self.assertEqual(res.get("run_id"), 9991)

        # Test alias endpoint compatibility: POST /api/vaani/calls/complete
        seller_payload["call_metadata"]["run_id"] = 9992
        seller_payload["lead_id"] = "test_lead_phased_9992"
        seller_payload["primary_phone"] = "+919999900002"
        status2, res2 = self.send_post("/api/vaani/calls/complete", seller_payload)
        self.assertEqual(status2, 201)
        self.assertTrue(res2.get("success"))
        self.assertEqual(res2.get("run_id"), 9992)

    def test_03_verify_postgresql_persistence(self):
        """Verifies direct relational and view state in PostgreSQL for run 9991."""
        # 1. Check workflow_runs.gathered_context
        wf_sql = "SELECT row_to_json(r) FROM (SELECT id, mode, state, is_completed, (gathered_context->'extracted_variables'->>'customer_type') as customer_type FROM workflow_runs WHERE id = 9991) r;"
        wf_row = self.query_psql(wf_sql)
        self.assertEqual(wf_row["id"], 9991)
        self.assertEqual(wf_row["state"], "completed")
        self.assertEqual(wf_row["customer_type"], "seller")

        # 2. Check vaani_excavator_sales_leads view
        view_sql = """
        SELECT row_to_json(v) FROM (
          SELECT run_id, caller_name, callback_number, customer_type, machine_brand,
                 machine_model, model_year, running_hours, expected_selling_price_inr,
                 lead_temperature, qualification_state, next_action
          FROM vaani_excavator_sales_leads
          WHERE run_id = 9991
        ) v;
        """
        lead_row = self.query_psql(view_sql)
        self.assertEqual(lead_row["run_id"], 9991)
        self.assertEqual(lead_row["machine_brand"], "Tata Hitachi")
        self.assertEqual(lead_row["machine_model"], "EX 200 LC")
        self.assertEqual(lead_row["model_year"], 2020)
        self.assertEqual(lead_row["running_hours"], 4500)
        self.assertEqual(lead_row["expected_selling_price_inr"], 2400000)
        self.assertEqual(lead_row["qualification_state"], "QUALIFIED")
        self.assertEqual(lead_row["lead_temperature"], "WARM")

        # 3. Check vaani_machines record
        mach_sql = """
        SELECT row_to_json(m) FROM (
          SELECT machine_id, source_lead_run_id, brand, model, manufacturing_year,
                 hour_meter_reading, sourcing_cost_inr, status
          FROM vaani_machines
          WHERE source_lead_run_id = 9991
        ) m;
        """
        mach_row = self.query_psql(mach_sql)
        self.assertEqual(mach_row["machine_id"], "mach_run_9991")
        self.assertEqual(mach_row["brand"], "Tata Hitachi")
        self.assertEqual(mach_row["model"], "EX 200 LC")
        self.assertEqual(mach_row["manufacturing_year"], 2020)
        self.assertEqual(mach_row["sourcing_cost_inr"], 2400000)
        self.assertEqual(mach_row["status"], "in_sourcing_pipeline")

        # 4. Check vaani_digital_evidence tracking records
        ev_sql = "SELECT json_agg(media_type) FROM vaani_digital_evidence WHERE run_id = 9991;"
        ev_types = self.query_psql(ev_sql)
        self.assertIn("photo_boom", ev_types)
        self.assertIn("photo_undercarriage", ev_types)
        self.assertIn("photo_meter", ev_types)
        self.assertIn("video_running_30s", ev_types)
        self.assertIn("doc_rc", ev_types)

    def test_04_verify_lead360_api_readback(self):
        """Verifies GET /api/vaani/sales/leads/:id?demo=0 retrieves real DB data."""
        status, data = self.send_get("/api/vaani/sales/leads/9991?demo=0")
        self.assertEqual(status, 200)
        self.assertFalse(data["is_demo"])
        self.assertEqual(data["customer_name"], "Test Seller Ramesh (Phase D Test)")
        self.assertEqual(data["customer_type"], "seller")
        self.assertEqual(data["lead_temperature"], "WARM")
        self.assertEqual(data["qualification_state"], "QUALIFIED")
        self.assertEqual(data["raw_lead"]["expected_selling_price_inr"], 2400000)
        self.assertEqual(data["raw_lead"]["machine_brand"], "Tata Hitachi")
        self.assertEqual(data["raw_lead"]["machine_model"], "EX 200 LC")
        self.assertEqual(data["next_action"], "Schedule technical inspection and verify WhatsApp evidence")

        # Verify relational machine is attached
        self.assertIsNotNone(data.get("relational_machine"))
        self.assertEqual(data["relational_machine"]["machine_id"], "mach_run_9991")
        self.assertEqual(data["relational_machine"]["sourcing_cost_inr"], 2400000)

        # Verify evidence checklist includes tracked items
        checklist = data.get("evidence_checklist", [])
        boom_item = next((item for item in checklist if item["key"] == "boom_photo"), None)
        self.assertIsNotNone(boom_item)
        self.assertEqual(boom_item["status"], "received")

    def test_05_verify_dnc_registry_persistence(self):
        """Verifies opt-out call writes to vaani_dnc_registry and flags lead."""
        dnc_payload = {
            "lead_id": "test_lead_phased_9993_dnc",
            "customer_name": "Test DNC Caller",
            "primary_phone": "+919999900099",
            "customer_type": "seller",
            "dnc_requested": True,
            "dnc_reason": "Requested number removal on first turn",
            "lead_temperature": "COLD",
            "qualification_state": "DISQUALIFIED",
            "call_metadata": {"run_id": 9993}
        }
        status, _ = self.send_post("/api/v1/vaani/calls/complete", dnc_payload)
        self.assertEqual(status, 201)

        dnc_sql = "SELECT row_to_json(d) FROM (SELECT phone_number, reason, is_active FROM vaani_dnc_registry WHERE phone_number = '+919999900099') d;"
        dnc_row = self.query_psql(dnc_sql)
        self.assertEqual(dnc_row["phone_number"], "+919999900099")
        self.assertTrue(dnc_row["is_active"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
