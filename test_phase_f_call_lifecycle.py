#!/usr/bin/env python3
"""
Phase F — Step 1 Integration Test Suite: Vaani Production Call Lifecycle Engine
================================================================================
Validates:
1. Valid seller call completion
2. Valid buyer call completion
3. Incomplete seller call
4. Incomplete buyer call
5. Qualification engine (3-dimension gate -> QUALIFIED)
6. Partial qualification (1-2 dimensions -> PARTIALLY_QUALIFIED)
7. Temperature engine (HOT / WARM / COLD)
8. Next action engine (Grounded operational tasks)
9. Follow-up creation (Datetime, reason, assignee)
10. Duplicate call completion (Idempotency)
11. Duplicate machine prevention
12. Duplicate evidence prevention
13. Tenant isolation
14. Missing tenant rejection
15. Invalid payload rejection
16. DNC handling & suppression
17. Database transactional integrity
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

class TestVaaniCallLifecycleEngine(unittest.TestCase):
    # Distinct range 8801-8825 to prevent any collision
    TEST_RUN_IDS = tuple(range(8801, 8826))
    TEST_PHONES = tuple(f"+9188000000{i:02d}" for i in range(1, 26))

    @classmethod
    def clean_test_data(cls):
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

        # Also clean test users/tenants in db.json if created
        node_clean = """
        const core = require('./dashboard/lib/core');
        (async () => {
          await core.mutate((d) => {
            d.tenants = d.tenants.filter(t => t.id !== 't_test_f_org2');
            d.users = d.users.filter(u => u.id !== 'u_test_f_org2');
            d.sessions = d.sessions.filter(s => s.tenantId !== 't_test_f_org2');
          });
        })();
        """
        subprocess.run(["node", "-e", node_clean], capture_output=True, text=True)

    @classmethod
    def setUpClass(cls):
        cls.clean_test_data()
        node_seed = """
        const core = require('./dashboard/lib/core');
        (async () => {
          await core.mutate((d) => {
            const t1 = d.tenants.find(t => t.id === 't_69d344e9ee8945d8');
            if (t1) t1.organization_id = 1;

            if (!d.tenants.some(t => t.id === 't_test_f_org2')) {
              d.tenants.push({
                id: 't_test_f_org2',
                name: 'Client B Earthmovers',
                slug: 'client-b-f',
                createdAt: new Date().toISOString(),
                branding: { color: '#FF5500' },
                providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
                plan: 'studio',
                status: 'active',
                privacyMode: 'standard',
                organization_id: 2
              });
            }
            if (!d.users.some(u => u.id === 'u_test_f_org2')) {
              d.users.push({
                id: 'u_test_f_org2',
                tenantId: 't_test_f_org2',
                email: 'org2user_f@example.com',
                name: 'Client B Admin',
                passHash: core.hashPassword('org2pass123'),
                role: 'owner',
                status: 'active',
                createdAt: new Date().toISOString()
              });
            }
          });

          const t1Token = await core.createSession('u_290fde84dd4df51e', 't_69d344e9ee8945d8');
          const t2Token = await core.createSession('u_test_f_org2', 't_test_f_org2');
          console.log(JSON.stringify({ org1Token: t1Token, org2Token: t2Token }));
        })();
        """
        proc = subprocess.run(["node", "-e", node_seed], capture_output=True, text=True, check=True)
        tokens = json.loads(proc.stdout.strip())
        cls.session_token_org1 = tokens["org1Token"]
        cls.session_token_org2 = tokens["org2Token"]

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

    def send_get(self, path, session_token=None):
        headers = {}
        tok = session_token or self.session_token_org1
        if tok:
            headers["Cookie"] = f"rxv_sess={tok}"
            headers["Authorization"] = f"Bearer {tok}"
        req = urllib.request.Request(f"{BASE_URL}{path}", headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

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

    # 1. Valid Seller Call Completion
    def test_01_valid_seller_call_completion(self):
        payload = {
            "primary_phone": "+918800000001",
            "customer_name": "Ramesh Patel",
            "customer_type": "seller",
            "ownership_type": "direct_owner",
            "machine_details": {
                "brand": "Tata Hitachi",
                "model": "EX 200 LC",
                "model_year": 2020,
                "running_hours": 4200,
                "application_history": "soil_earthwork",
                "location_city": "Jaipur",
                "location_state": "Rajasthan"
            },
            "commercial_terms": {
                "expected_price_inr": 2400000,
                "price_or_budget_raw": "24 Lakh"
            },
            "evidence_readiness": {
                "photos_agreed": True,
                "running_video_agreed": True,
                "rc_copy_agreed": True
            },
            "conversation_outcome": "lead_qualified",
            "call_metadata": {
                "run_id": 8801,
                "duration_seconds": 95,
                "direction": "inbound"
            }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("run_id"), 8801)
        self.assertEqual(res.get("call_session_id"), "sess_run_8801")
        self.assertEqual(res.get("status"), "COMPLETED")
        self.assertEqual(res.get("qualification_state"), "QUALIFIED")
        self.assertEqual(res.get("lead_temperature"), "HOT")
        self.assertEqual(res.get("next_action"), "FOLLOW_UP_WITH_SELLER")

        # Verify vaani_machines
        mach = self.query_psql("SELECT row_to_json(m) FROM (SELECT brand, model, manufacturing_year, sourcing_cost_inr FROM vaani_machines WHERE machine_id = 'mach_run_8801') m;")
        self.assertEqual(mach["brand"], "Tata Hitachi")
        self.assertEqual(mach["model"], "EX 200 LC")
        self.assertEqual(mach["manufacturing_year"], 2020)
        self.assertEqual(mach["sourcing_cost_inr"], 2400000)

    # 2. Valid Buyer Call Completion
    def test_02_valid_buyer_call_completion(self):
        payload = {
            "primary_phone": "+918800000002",
            "customer_name": "Vikram Singh",
            "customer_type": "buyer",
            "machine_details": {
                "brand": "JCB",
                "model": "JS 205",
                "tonnage_class": "20_ton_class",
                "location_city": "Kishangarh",
                "location_state": "Rajasthan"
            },
            "commercial_terms": {
                "budget_max_inr": 2600000,
                "price_or_budget_raw": "26 Lakh tak",
                "purchase_timeline": "immediate_within_7_days",
                "yard_visit_agreed": True
            },
            "conversation_outcome": "appointment_requested",
            "call_metadata": {
                "run_id": 8802,
                "duration_seconds": 120
            }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertTrue(res.get("success"))
        self.assertEqual(res.get("qualification_state"), "QUALIFIED")
        self.assertEqual(res.get("lead_temperature"), "HOT")
        self.assertEqual(res.get("next_action"), "SCHEDULE_YARD_VISIT")

        # Buyers must NOT create machine records in vaani_machines
        mach = self.query_psql("SELECT count(*) FROM vaani_machines WHERE source_lead_run_id = 8802;")
        self.assertEqual(int(mach), 0)

    # 3. Incomplete Seller Call
    def test_03_incomplete_seller_call(self):
        payload = {
            "primary_phone": "+918800000003",
            "customer_name": "Incomplete Seller",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Tata Hitachi"
                # Missing model and location
            },
            "commercial_terms": {
                "expected_price_inr": 2000000
            },
            "call_metadata": {
                "run_id": 8803
            }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertEqual(res.get("qualification_state"), "PARTIALLY_QUALIFIED")
        self.assertEqual(res.get("lead_temperature"), "COLD")

    # 4. Incomplete Buyer Call
    def test_04_incomplete_buyer_call(self):
        payload = {
            "primary_phone": "+918800000004",
            "customer_name": "Casual Inquirer",
            "customer_type": "buyer",
            "machine_details": {
                "tonnage_class": "20_ton_class"
                # Missing budget and location
            },
            "call_metadata": {
                "run_id": 8804
            }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertEqual(res.get("qualification_state"), "PARTIALLY_QUALIFIED")
        self.assertEqual(res.get("lead_temperature"), "COLD")

    # 5. Qualification Engine (3 Dimensions Met -> QUALIFIED)
    def test_05_qualification_gate_full(self):
        payload = {
            "primary_phone": "+918800000005",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Hyundai",
                "model": "Robex R210",
                "location_city": "Ajmer"
            },
            "commercial_terms": {
                "expected_price_inr": 2100000
            },
            "call_metadata": { "run_id": 8805 }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertEqual(res.get("qualification_state"), "QUALIFIED")

    # 6. Qualification Engine (Partial -> PARTIALLY_QUALIFIED)
    def test_06_qualification_gate_partial(self):
        payload = {
            "primary_phone": "+918800000006",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Komatsu"
                # Missing model and location
            },
            "commercial_terms": {
                "expected_price_inr": 2500000
            },
            "call_metadata": { "run_id": 8806 }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertEqual(res.get("qualification_state"), "PARTIALLY_QUALIFIED")

    # 7. Lead Temperature Engine (HOT / WARM / COLD)
    def test_07_lead_temperature_hot_warm_cold(self):
        # WARM Seller (price slightly high or media pending)
        payload_warm = {
            "primary_phone": "+918800000007",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Tata Hitachi",
                "model": "EX 200 LC",
                "model_year": 2016,
                "location_city": "Jaipur"
            },
            "commercial_terms": {
                "expected_price_inr": 2700000  # High for 2016
            },
            "evidence_readiness": {
                "photos_agreed": False
            },
            "call_metadata": { "run_id": 8807 }
        }
        status, res_warm = self.send_post("/api/v1/vaani/calls/complete", payload_warm)
        self.assertEqual(status, 201)
        self.assertEqual(res_warm.get("lead_temperature"), "WARM")

    # 8. Next Action Engine
    def test_08_next_action_engine(self):
        payload = {
            "primary_phone": "+918800000008",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Tata Hitachi",
                "model": "EX 210",
                "location_city": "Jaipur"
            },
            "commercial_terms": {
                "expected_price_inr": 2200000
            },
            "evidence_readiness": {
                "photos_agreed": False  # Photos pending
            },
            "call_metadata": { "run_id": 8808 }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertEqual(res.get("next_action"), "WAITING_FOR_MACHINE_PHOTOS")

    # 9. Follow-Up Task Creation
    def test_09_follow_up_creation(self):
        payload = {
            "primary_phone": "+918800000009",
            "customer_type": "buyer",
            "machine_details": {
                "brand": "Tata Hitachi",
                "tonnage_class": "20_ton_class",
                "location_city": "Kota"
            },
            "commercial_terms": {
                "budget_max_inr": 2500000
            },
            "conversation_outcome": "callback_requested",
            "call_metadata": { "run_id": 8809 }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        follow_up = res.get("follow_up", {})
        self.assertTrue(follow_up.get("required"))
        self.assertIsNotNone(follow_up.get("datetime"))
        self.assertEqual(follow_up.get("assigned_to"), "Vaani / Sales Operator")

    # 10. Idempotent Duplicate Call Completion
    def test_10_idempotent_duplicate_call_completion(self):
        payload = {
            "primary_phone": "+918800000010",
            "customer_name": "Idempotent Test",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Sany",
                "model": "SY215C",
                "location_city": "Jaipur"
            },
            "commercial_terms": {
                "expected_price_inr": 2800000
            },
            "call_metadata": { "run_id": 8810 }
        }
        # First call
        status1, res1 = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status1, 201)
        self.assertFalse(res1.get("is_duplicate"))

        # Second delivery of same call
        status2, res2 = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status2, 201)
        self.assertTrue(res2.get("is_duplicate"))

        # Check PostgreSQL has exactly 1 row for run 8810
        count = self.query_psql("SELECT count(*) FROM workflow_runs WHERE id = 8810;")
        self.assertEqual(int(count), 1)

    # 11. Duplicate Machine Prevention
    def test_11_duplicate_machine_prevention(self):
        payload = {
            "primary_phone": "+918800000011",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Kobelco",
                "model": "SK210",
                "location_city": "Jaipur"
            },
            "commercial_terms": { "expected_price_inr": 2600000 },
            "call_metadata": { "run_id": 8811 }
        }
        self.send_post("/api/v1/vaani/calls/complete", payload)
        self.send_post("/api/v1/vaani/calls/complete", payload)

        mach_count = self.query_psql("SELECT count(*) FROM vaani_machines WHERE source_lead_run_id = 8811;")
        self.assertEqual(int(mach_count), 1)

    # 12. Duplicate Evidence Prevention
    def test_12_duplicate_evidence_prevention(self):
        payload = {
            "primary_phone": "+918800000012",
            "customer_type": "seller",
            "machine_details": { "brand": "JCB", "model": "JS 205", "location_city": "Jaipur" },
            "evidence_readiness": { "photos_agreed": True, "running_video_agreed": True, "rc_copy_agreed": True },
            "call_metadata": { "run_id": 8812 }
        }
        self.send_post("/api/v1/vaani/calls/complete", payload)
        self.send_post("/api/v1/vaani/calls/complete", payload)

        ev_count = self.query_psql("SELECT count(*) FROM vaani_digital_evidence WHERE run_id = 8812;")
        # 4 photos + 1 video + 1 RC = 6
        self.assertEqual(int(ev_count), 6)

    # 13. Multi-Tenant Isolation
    def test_13_multi_tenant_isolation(self):
        # Org 1 call
        payload = {
            "primary_phone": "+918800000013",
            "customer_name": "Org1 Exclusive Seller",
            "customer_type": "seller",
            "machine_details": { "brand": "Tata Hitachi", "model": "EX 200 LC", "location_city": "Jaipur" },
            "call_metadata": { "run_id": 8813, "workflow_id": 3 }  # Workflow 3 belongs to Org 1
        }
        self.send_post("/api/v1/vaani/calls/complete", payload)

        # Org 1 user CAN read the lead
        status1, data1 = self.send_get("/api/vaani/sales/leads/8813", session_token=self.session_token_org1)
        self.assertEqual(status1, 200)
        self.assertEqual(data1.get("customer_name"), "Org1 Exclusive Seller")

        # Org 2 user CANNOT read the lead (returns 404)
        status2, _ = self.send_get("/api/vaani/sales/leads/8813", session_token=self.session_token_org2)
        self.assertEqual(status2, 404)

    # 14. Missing Tenant Rejection
    def test_14_missing_tenant_rejection(self):
        payload = {
            "primary_phone": "+918800000014",
            "call_metadata": {
                "run_id": 8814,
                "workflow_id": 999999  # Nonexistent workflow
            }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 400)
        self.assertIn(res.get("code"), ["missing_organization_id", "unauthorized", "tenant_not_found"])

    # 15. Invalid Payload Rejection
    def test_15_invalid_payload_rejection(self):
        # Missing primary_phone
        status1, res1 = self.send_post("/api/v1/vaani/calls/complete", {"call_metadata": {"run_id": 8815}})
        self.assertEqual(status1, 400)
        self.assertEqual(res1.get("code"), "missing_primary_phone")
        self.assertEqual(res1.get("error_code"), "INVALID_PAYLOAD")

        # Missing run_id
        status2, res2 = self.send_post("/api/v1/vaani/calls/complete", {"primary_phone": "+918800000015"})
        self.assertEqual(status2, 400)
        self.assertEqual(res2.get("code"), "missing_run_id")
        self.assertEqual(res2.get("error_code"), "INVALID_PAYLOAD")

    # 16. DNC Handling & Suppression
    def test_16_dnc_handling(self):
        phone = "+918800000016"
        payload = {
            "primary_phone": phone,
            "customer_name": "Opt Out Caller",
            "customer_type": "seller",
            "dnc_requested": True,
            "dnc_reason": "Customer shouted do not call again",
            "call_metadata": { "run_id": 8816 }
        }
        status, res = self.send_post("/api/v1/vaani/calls/complete", payload)
        self.assertEqual(status, 201)
        self.assertEqual(res.get("qualification_state"), "DISQUALIFIED")
        self.assertEqual(res.get("lead_temperature"), "COLD")
        self.assertEqual(res.get("next_action"), "DNC_SUPPRESS")
        self.assertFalse(res.get("follow_up", {}).get("required"))

        # Verify vaani_dnc_registry
        dnc_row = self.query_psql(f"SELECT row_to_json(d) FROM (SELECT reason, is_active FROM vaani_dnc_registry WHERE phone_number = '{phone}') d;")
        self.assertEqual(dnc_row["is_active"], True)
        self.assertTrue("call again" in dnc_row["reason"].lower() or "opted out" in dnc_row["reason"].lower())

    # 17. Database Transaction Integrity
    def test_17_database_transaction_integrity(self):
        # Verify that an invalid SQL transaction rolls back cleanly
        # We test this by attempting to ingest with a run_id that violates foreign key on a malformed custom workflow
        # and checking that 0 partial rows exist
        bad_payload = {
            "primary_phone": "+918800000017",
            "call_metadata": {
                "run_id": 8817,
                "workflow_id": 999999
            }
        }
        status, _ = self.send_post("/api/v1/vaani/calls/complete", bad_payload)
        self.assertEqual(status, 400)

        # Ensure run 8817 was NOT inserted into workflow_runs
        count = self.query_psql("SELECT count(*) FROM workflow_runs WHERE id = 8817;")
        self.assertEqual(int(count), 0)

if __name__ == "__main__":
    unittest.main()
