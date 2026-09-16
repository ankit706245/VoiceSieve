#!/usr/bin/env python3
"""
Phase F — Step 3 Integration Test Suite: Vaani Follow-Up & Sales Automation Engine
==================================================================================
Validates:
1. Seller missing photos -> REQUEST_PHOTOS task
2. Seller missing video & RC -> REQUEST_RUNNING_VIDEO & REQUEST_RC tasks
3. Seller all evidence promised -> VERIFY_MACHINE candidate
4. Qualified buyer -> MATCH_BUYER task
5. Buyer yard visit agreed -> YARD_VISIT task assigned to Devendra
6. Partially qualified buyer -> FOLLOW_UP_BUYER task
7. DNC caller -> ZERO follow-up tasks created
8. Deduplication engine -> Repeated ingestion creates NO duplicate open tasks
9. Priority engine -> Deterministic URGENT / HIGH / MEDIUM / LOW mapping
10. Timing engine -> Preserves caller time, sensible defaults for evidence/buyer
11. State machine -> Valid transitions (PENDING -> IN_PROGRESS -> COMPLETED, SKIPPED, CANCELLED)
12. State machine -> Rejection of invalid/terminal transitions (COMPLETED -> IN_PROGRESS rejected with 422)
13. Evidence received event -> Resolves corresponding evidence task in vaani_digital_evidence
14. Evidence received event -> Automatically triggers VERIFY_MACHINE when photos + video are received
15. Lead 360 timeline -> Contains FOLLOW_UP_CREATED and FOLLOW_UP_COMPLETED events
16. Multi-tenant isolation -> Client A cannot query or mutate Client B tasks (404/not found)
17. Backward compatibility -> /api/vaani/sales/follow-ups and /api/vaani/sales/follow-up/status work seamlessly
"""

import unittest
import urllib.request
import urllib.error
import json
import subprocess
import os
import time

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

class TestVaaniFollowUpAutomationEngine(unittest.TestCase):
    # Distinct range 8901-8935 to avoid any collision
    TEST_RUN_IDS = tuple(range(8901, 8936))
    TEST_PHONES = tuple(f"+9189000000{i:02d}" for i in range(1, 36))

    @classmethod
    def clean_test_data(cls):
        run_ids_csv = ",".join(str(i) for i in cls.TEST_RUN_IDS)
        phones_csv = ",".join(f"'{p}'" for p in cls.TEST_PHONES)
        mach_ids_csv = ",".join(f"'mach_run_{i}'" for i in cls.TEST_RUN_IDS)
        sql = f"""
        DELETE FROM public.vaani_follow_up_tasks WHERE source_call_id IN ({run_ids_csv});
        DELETE FROM public.vaani_digital_evidence WHERE run_id IN ({run_ids_csv});
        DELETE FROM public.vaani_machines WHERE source_lead_run_id IN ({run_ids_csv}) OR machine_id IN ({mach_ids_csv});
        DELETE FROM public.vaani_dnc_registry WHERE run_id IN ({run_ids_csv}) OR phone_number IN ({phones_csv});
        DELETE FROM public.workflow_runs WHERE id IN ({run_ids_csv});
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
            capture_output=True,
            text=True
        )

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
        res = subprocess.run(["node", "-e", node_seed], capture_output=True, text=True)
        tokens = json.loads(res.stdout.strip().splitlines()[-1])
        cls.org1_token = tokens["org1Token"]
        cls.org2_token = tokens["org2Token"]
        cls.secret = get_ingestion_secret()

    @classmethod
    def tearDownClass(cls):
        cls.clean_test_data()

    def ingest_call(self, payload):
        req = urllib.request.Request(
            f"{BASE_URL}/api/v1/vaani/calls/complete",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.secret}"
            },
            method="POST"
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def post_authed(self, path, payload, token):
        req = urllib.request.Request(
            f"{BASE_URL}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Cookie": f"rxv_sess={token}"
            },
            method="POST"
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8")), resp.status

    def get_authed(self, path, token):
        req = urllib.request.Request(
            f"{BASE_URL}{path}",
            headers={
                "Cookie": f"rxv_sess={token}"
            },
            method="GET"
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8")), resp.status

    # =========================================================================
    # Test 1: Seller missing photos creates REQUEST_PHOTOS task
    # =========================================================================
    def test_01_seller_missing_photos_creates_request_photos_task(self):
        run_id = 8901
        phone = "+918900000001"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Ramesh Choudhary",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Tata Hitachi",
                "model": "EX 200 LC",
                "model_year": 2021,
                "running_hours": 4200,
                "location_city": "Jaipur",
                "location_state": "Rajasthan"
            },
            "commercial_terms": {
                "expected_price_inr": 2800000,
                "price_or_budget_raw": "28 Lakhs"
            },
            "evidence_readiness": {
                "photos_agreed": False,
                "running_video_agreed": False,
                "rc_copy_agreed": False
            }
        }
        res = self.ingest_call(payload)
        self.assertTrue(res["success"])
        tasks = res.get("tasks_created", [])
        self.assertTrue(len(tasks) > 0)

        photo_task = next((t for t in tasks if t["task_type"] == "REQUEST_PHOTOS"), None)
        self.assertIsNotNone(photo_task)
        self.assertEqual(photo_task["organization_id"], 1)
        self.assertEqual(photo_task["priority"], "HIGH")
        self.assertEqual(photo_task["status"], "PENDING")
        self.assertIn("Tata Hitachi", photo_task["title"])

    # =========================================================================
    # Test 2: Seller missing video and RC creates REQUEST_RUNNING_VIDEO & REQUEST_RC
    # =========================================================================
    def test_02_seller_missing_video_and_rc_creates_tasks(self):
        run_id = 8902
        phone = "+918900000002"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Suresh Gehlot",
            "customer_type": "seller",
            "machine_details": {
                "brand": "JCB",
                "model": "JS 205",
                "model_year": 2020,
                "running_hours": 3800,
                "location_city": "Jodhpur",
                "location_state": "Rajasthan"
            },
            "commercial_terms": {
                "expected_price_inr": 2500000,
                "price_or_budget_raw": "25 Lakhs"
            },
            "evidence_readiness": {
                "photos_agreed": True,  # Photos already agreed/received
                "running_video_agreed": False,  # Pending
                "rc_copy_agreed": False  # Pending
            }
        }
        res = self.ingest_call(payload)
        self.assertTrue(res["success"])
        tasks = res.get("tasks_created", [])

        # Should NOT request photos again because photos_agreed is True
        self.assertIsNone(next((t for t in tasks if t["task_type"] == "REQUEST_PHOTOS"), None))
        # MUST request video and RC
        self.assertIsNotNone(next((t for t in tasks if t["task_type"] == "REQUEST_RUNNING_VIDEO"), None))
        self.assertIsNotNone(next((t for t in tasks if t["task_type"] == "REQUEST_RC"), None))

    # =========================================================================
    # Test 3: Seller all evidence promised triggers VERIFY_MACHINE task candidate
    # =========================================================================
    def test_03_seller_all_evidence_promised_creates_verify_machine_task(self):
        run_id = 8903
        phone = "+918900000003"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Vikram Singh",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Hyundai",
                "model": "Robex R210-7",
                "model_year": 2022,
                "running_hours": 3200,
                "location_city": "Kota",
                "location_state": "Rajasthan"
            },
            "commercial_terms": {
                "expected_price_inr": 3000000,
                "price_or_budget_raw": "30 Lakhs"
            },
            "evidence_readiness": {
                "photos_agreed": True,
                "running_video_agreed": True,
                "rc_copy_agreed": True
            }
        }
        res = self.ingest_call(payload)
        self.assertTrue(res["success"])
        tasks = res.get("tasks_created", [])
        verify_task = next((t for t in tasks if t["task_type"] == "VERIFY_MACHINE"), None)
        self.assertIsNotNone(verify_task)
        self.assertEqual(verify_task["assigned_to"], "Yard Technical Evaluator")

    # =========================================================================
    # Test 4: Qualified buyer creates MATCH_BUYER task
    # =========================================================================
    def test_04_qualified_buyer_creates_match_buyer_task(self):
        run_id = 8904
        phone = "+918900000004"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Prakash Meena",
            "customer_type": "buyer",
            "machine_details": {
                "brand": "Tata Hitachi",
                "tonnage_class": "20_ton_class",
                "location_city": "Jaipur",
                "location_state": "Rajasthan"
            },
            "commercial_terms": {
                "budget_max_inr": 3200000,
                "price_or_budget_raw": "32 Lakhs",
                "purchase_timeline": "immediate"
            }
        }
        res = self.ingest_call(payload)
        self.assertTrue(res["success"])
        tasks = res.get("tasks_created", [])
        match_task = next((t for t in tasks if t["task_type"] == "MATCH_BUYER"), None)
        self.assertIsNotNone(match_task)
        self.assertEqual(match_task["priority"], "URGENT")  # HOT + immediate timeline -> URGENT

    # =========================================================================
    # Test 5: Buyer yard visit agreed creates YARD_VISIT task assigned to Devendra
    # =========================================================================
    def test_05_buyer_yard_visit_agreed_creates_yard_visit_task(self):
        run_id = 8905
        phone = "+918900000005"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Mahesh Bairwa",
            "customer_type": "buyer",
            "machine_details": {
                "brand": "Komatsu",
                "model": "PC 210-10M0",
                "location_city": "Ajmer"
            },
            "commercial_terms": {
                "budget_max_inr": 3600000,
                "price_or_budget_raw": "36 Lakhs",
                "yard_visit_agreed": True
            }
        }
        res = self.ingest_call(payload)
        self.assertTrue(res["success"])
        tasks = res.get("tasks_created", [])
        yard_task = next((t for t in tasks if t["task_type"] == "YARD_VISIT"), None)
        self.assertIsNotNone(yard_task)
        self.assertIn("Devendra", yard_task["assigned_to"])

    # =========================================================================
    # Test 6: Partially qualified buyer creates FOLLOW_UP_BUYER task
    # =========================================================================
    def test_06_partially_qualified_buyer_creates_follow_up_buyer_task(self):
        run_id = 8906
        phone = "+918900000006"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Anil Kumawat",
            "customer_type": "buyer",
            "machine_details": {
                "brand": "Tata Hitachi"
                # Missing city and missing budget -> PARTIALLY_QUALIFIED
            },
            "commercial_terms": {
                "purchase_timeline": "1_3_months"
            }
        }
        res = self.ingest_call(payload)
        self.assertTrue(res["success"])
        tasks = res.get("tasks_created", [])
        fu_task = next((t for t in tasks if t["task_type"] == "FOLLOW_UP_BUYER"), None)
        self.assertIsNotNone(fu_task)

    # =========================================================================
    # Test 7: DNC caller creates ZERO follow-up tasks
    # =========================================================================
    def test_07_dnc_suppression_creates_zero_tasks(self):
        run_id = 8907
        phone = "+918900000007"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Angry Caller",
            "customer_type": "seller",
            "dnc_requested": True,
            "dnc_reason": "Do not call me again",
            "machine_details": {
                "brand": "Tata Hitachi",
                "model": "EX 200 LC"
            }
        }
        res = self.ingest_call(payload)
        self.assertTrue(res["success"])
        self.assertEqual(res.get("tasks_created", []), [])

        # Double-check database directly
        sql = f"SELECT count(*) as cnt FROM public.vaani_follow_up_tasks WHERE source_call_id = {run_id};"
        proc = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", sql],
            capture_output=True,
            text=True
        )
        cnt = int(proc.stdout.strip())
        self.assertEqual(cnt, 0)

    # =========================================================================
    # Test 8: Task deduplication engine prevents duplicate open tasks
    # =========================================================================
    def test_08_task_deduplication_engine(self):
        run_id = 8908
        phone = "+918900000008"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Deduplication Tester",
            "customer_type": "seller",
            "machine_details": {
                "brand": "Tata Hitachi",
                "model": "EX 200 LC",
                "model_year": 2021,
                "location_city": "Jaipur"
            },
            "commercial_terms": {
                "expected_price_inr": 2800000,
                "price_or_budget_raw": "28 Lakhs"
            },
            "evidence_readiness": {
                "photos_agreed": False,
                "running_video_agreed": False
            }
        }
        # Ingest call first time
        res1 = self.ingest_call(payload)
        self.assertTrue(res1["success"])
        tasks1 = res1.get("tasks_created", [])
        self.assertTrue(len(tasks1) > 0)

        # Ingest identical call second time
        res2 = self.ingest_call(payload)
        self.assertTrue(res2["success"])
        tasks2 = res2.get("tasks_created", [])
        # Deduplication must kick in: no new duplicate open tasks!
        self.assertEqual(len(tasks2), 0)

        # Direct DB count check
        sql = f"SELECT count(*) as cnt FROM public.vaani_follow_up_tasks WHERE source_call_id = {run_id} AND task_type = 'REQUEST_PHOTOS';"
        proc = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", sql],
            capture_output=True,
            text=True
        )
        cnt = int(proc.stdout.strip())
        self.assertEqual(cnt, 1)

    # =========================================================================
    # Test 9: Priority engine deterministic rules unit check
    # =========================================================================
    def test_09_priority_engine_deterministic_rules(self):
        node_check = """
        const { determineTaskPriority, TASK_PRIORITIES } = require('./dashboard/lib/vaani-tasks');
        const p1 = determineTaskPriority('buyer', 'QUALIFIED', 'HOT', { purchase_timeline: 'immediate' }, {}, 'MATCH_BUYER');
        const p2 = determineTaskPriority('seller', 'QUALIFIED', 'HOT', {}, {}, 'REQUEST_PHOTOS');
        const p3 = determineTaskPriority('seller', 'PARTIALLY_QUALIFIED', 'WARM', {}, {}, 'REQUEST_PHOTOS');
        const p4 = determineTaskPriority('seller', 'UNQUALIFIED', 'COLD', {}, {}, 'CALL_BACK');
        console.log(JSON.stringify({ p1, p2, p3, p4 }));
        """
        proc = subprocess.run(["node", "-e", node_check], capture_output=True, text=True)
        data = json.loads(proc.stdout.strip())
        self.assertEqual(data["p1"], "URGENT")
        self.assertEqual(data["p2"], "HIGH")
        self.assertEqual(data["p3"], "MEDIUM")
        self.assertEqual(data["p4"], "LOW")

    # =========================================================================
    # Test 10: Timing engine deterministic rules
    # =========================================================================
    def test_10_timing_engine_deterministic_rules(self):
        node_check = """
        const { determineTaskDueAt } = require('./dashboard/lib/vaani-tasks');
        const customDate = '2026-09-15T10:00:00.000Z';
        const d1 = determineTaskDueAt('REQUEST_PHOTOS', customDate, {});
        const d2 = determineTaskDueAt('REQUEST_PHOTOS', null, {});
        const d3 = determineTaskDueAt('MATCH_BUYER', null, { purchase_timeline: 'immediate' });
        console.log(JSON.stringify({
          d1,
          hasD2: Boolean(d2),
          hasD3: Boolean(d3)
        }));
        """
        proc = subprocess.run(["node", "-e", node_check], capture_output=True, text=True)
        data = json.loads(proc.stdout.strip())
        self.assertEqual(data["d1"], "2026-09-15T10:00:00.000Z")
        self.assertTrue(data["hasD2"])
        self.assertTrue(data["hasD3"])

    # =========================================================================
    # Test 11: State machine valid transitions (PENDING -> IN_PROGRESS -> COMPLETED)
    # =========================================================================
    def test_11_state_machine_valid_transitions(self):
        run_id = 8911
        phone = "+918900000011"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "State Machine Tester",
            "customer_type": "seller",
            "machine_details": {"brand": "Tata Hitachi", "model": "EX 200 LC", "location_city": "Jaipur"},
            "commercial_terms": {"expected_price_inr": 2800000},
            "evidence_readiness": {"photos_agreed": False}
        }
        res = self.ingest_call(payload)
        tasks = res.get("tasks_created", [])
        self.assertTrue(len(tasks) > 0)
        task_id = tasks[0]["task_id"]

        # Transition 1: PENDING -> IN_PROGRESS
        update1, status1 = self.post_authed(
            "/api/vaani/sales/tasks/transition",
            {"task_id": task_id, "status": "IN_PROGRESS", "notes": "Dialing seller on WhatsApp"},
            self.org1_token
        )
        self.assertEqual(status1, 200)
        self.assertEqual(update1["task"]["status"], "IN_PROGRESS")

        # Transition 2: IN_PROGRESS -> COMPLETED
        update2, status2 = self.post_authed(
            "/api/vaani/sales/tasks/transition",
            {"task_id": task_id, "status": "COMPLETED", "notes": "Photos successfully received"},
            self.org1_token
        )
        self.assertEqual(status2, 200)
        self.assertEqual(update2["task"]["status"], "COMPLETED")
        self.assertIsNotNone(update2["task"]["completed_at"])

    # =========================================================================
    # Test 12: State machine rejects invalid transitions (COMPLETED -> IN_PROGRESS)
    # =========================================================================
    def test_12_state_machine_rejects_invalid_transitions(self):
        run_id = 8912
        phone = "+918900000012"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Terminal Transition Tester",
            "customer_type": "seller",
            "machine_details": {"brand": "Tata Hitachi", "model": "EX 200 LC", "location_city": "Jaipur"},
            "commercial_terms": {"expected_price_inr": 2800000},
            "evidence_readiness": {"photos_agreed": False}
        }
        res = self.ingest_call(payload)
        task_id = res["tasks_created"][0]["task_id"]

        # Transition to COMPLETED
        self.post_authed(
            "/api/vaani/sales/tasks/transition",
            {"task_id": task_id, "status": "COMPLETED"},
            self.org1_token
        )

        # Attempt invalid transition: COMPLETED -> IN_PROGRESS
        req = urllib.request.Request(
            f"{BASE_URL}/api/vaani/sales/tasks/transition",
            data=json.dumps({"task_id": task_id, "status": "IN_PROGRESS"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Cookie": f"rxv_sess={self.org1_token}"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 422)
        err_body = json.loads(ctx.exception.read().decode("utf-8"))
        self.assertIn("transition", err_body["error"].lower())

    # =========================================================================
    # Test 13: Evidence received event resolves evidence task
    # =========================================================================
    def test_13_evidence_received_auto_resolves_task(self):
        run_id = 8913
        phone = "+918900000013"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Evidence Receiver Tester",
            "customer_type": "seller",
            "machine_details": {"brand": "Tata Hitachi", "model": "EX 200 LC", "location_city": "Jaipur"},
            "commercial_terms": {"expected_price_inr": 2800000},
            "evidence_readiness": {"photos_agreed": False, "running_video_agreed": False}
        }
        res = self.ingest_call(payload)
        tasks = res["tasks_created"]
        photo_task = next(t for t in tasks if t["task_type"] == "REQUEST_PHOTOS")

        # Mark photo evidence as received
        ev_res, ev_code = self.post_authed(
            "/api/vaani/sales/evidence/received",
            {
                "run_id": run_id,
                "media_type": "photo_exterior",
                "media_url": "https://s3.example.com/photos/ex200_exterior.jpg",
                "evaluator_notes": "Clear 4-angle exterior photos received"
            },
            self.org1_token
        )
        self.assertEqual(ev_code, 200)
        self.assertTrue(ev_res["success"])
        self.assertIsNotNone(ev_res["resolved_task"])
        self.assertEqual(ev_res["resolved_task"]["status"], "COMPLETED")

        # Verify task is now COMPLETED in DB
        sql = f"SELECT status FROM public.vaani_follow_up_tasks WHERE task_id = '{photo_task['task_id']}';"
        proc = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", sql],
            capture_output=True,
            text=True
        )
        status = proc.stdout.strip()
        self.assertEqual(status, "COMPLETED")

    # =========================================================================
    # Test 14: Evidence received triggers machine verification when photos & video present
    # =========================================================================
    def test_14_evidence_received_triggers_machine_verification(self):
        run_id = 8914
        phone = "+918900000014"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Full Evidence Tester",
            "customer_type": "seller",
            "machine_details": {"brand": "Tata Hitachi", "model": "EX 210 LC / Super", "location_city": "Jaipur"},
            "commercial_terms": {"expected_price_inr": 2900000},
            "evidence_readiness": {"photos_agreed": False, "running_video_agreed": False}
        }
        self.ingest_call(payload)

        # 1. Receive photo
        self.post_authed(
            "/api/vaani/sales/evidence/received",
            {"run_id": run_id, "media_type": "photo_boom", "media_url": "https://s3.example.com/boom.jpg"},
            self.org1_token
        )

        # 2. Receive running video
        ev_res2, _ = self.post_authed(
            "/api/vaani/sales/evidence/received",
            {"run_id": run_id, "media_type": "video_running_30s", "media_url": "https://s3.example.com/video.mp4"},
            self.org1_token
        )

        # Now that both photos and video are received, VERIFY_MACHINE task must be created!
        self.assertTrue(ev_res2.get("verify_task_triggered", False))

        # Check DB directly
        sql = f"SELECT count(*) as cnt FROM public.vaani_follow_up_tasks WHERE source_call_id = {run_id} AND task_type = 'VERIFY_MACHINE';"
        proc = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", sql],
            capture_output=True,
            text=True
        )
        cnt = int(proc.stdout.strip())
        self.assertEqual(cnt, 1)

    # =========================================================================
    # Test 15: Lead 360 timeline displays task lifecycle events
    # =========================================================================
    def test_15_activity_timeline_displays_task_lifecycle(self):
        run_id = 8915
        phone = "+918900000015"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Timeline Verification Tester",
            "customer_type": "seller",
            "machine_details": {"brand": "Tata Hitachi", "model": "EX 200 LC", "location_city": "Jaipur"},
            "commercial_terms": {"expected_price_inr": 2800000},
            "evidence_readiness": {"photos_agreed": False}
        }
        res = self.ingest_call(payload)
        task_id = res["tasks_created"][0]["task_id"]

        # Mark completed
        self.post_authed(
            "/api/vaani/sales/tasks/transition",
            {"task_id": task_id, "status": "COMPLETED", "notes": "Done by operator"},
            self.org1_token
        )

        # Fetch lead timeline
        timeline, code = self.get_authed(f"/api/vaani/sales/leads/{run_id}/timeline", self.org1_token)
        self.assertEqual(code, 200)
        self.assertTrue(isinstance(timeline, list))

        act_types = [e["activity_type"] for e in timeline]
        self.assertIn("FOLLOW_UP_CREATED", act_types)
        self.assertIn("FOLLOW_UP_COMPLETED", act_types)

    # =========================================================================
    # Test 16: Multi-tenant isolation for tasks
    # =========================================================================
    def test_16_multi_tenant_isolation(self):
        run_id = 8916
        phone = "+918900000016"
        # Ingest call belonging to Organization 2
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 2},
            "primary_phone": phone,
            "customer_name": "Client B Seller",
            "customer_type": "seller",
            "machine_details": {"brand": "Tata Hitachi", "model": "EX 200 LC", "location_city": "Jaipur"},
            "commercial_terms": {"expected_price_inr": 2800000},
            "evidence_readiness": {"photos_agreed": False}
        }
        res = self.ingest_call(payload)
        task_id = res["tasks_created"][0]["task_id"]

        # Client A (Org 1) attempts to transition Client B (Org 2) task -> MUST be rejected with 404
        req = urllib.request.Request(
            f"{BASE_URL}/api/vaani/sales/tasks/transition",
            data=json.dumps({"task_id": task_id, "status": "COMPLETED"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Cookie": f"rxv_sess={self.org1_token}"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 404)

        # Client A (Org 1) queries follow-ups list -> Org 2 task must NEVER appear!
        fu_data, code = self.get_authed("/api/vaani/sales/follow-ups", self.org1_token)
        self.assertEqual(code, 200)
        all_tasks = fu_data.get("overdue", []) + fu_data.get("due_today", []) + fu_data.get("upcoming", [])
        matching_task = next((t for t in all_tasks if t.get("task_id") == task_id or str(t.get("id")) == str(task_id)), None)
        self.assertIsNone(matching_task)

    # =========================================================================
    # Test 17: Backward compatibility with /api/vaani/sales/follow-ups routes
    # =========================================================================
    def test_17_backward_compatibility_with_follow_up_routes(self):
        # 1. Test GET /api/vaani/sales/tasks returns categorized tasks
        data, code = self.get_authed("/api/vaani/sales/tasks", self.org1_token)
        self.assertEqual(code, 200)
        self.assertIn("overdue", data)
        self.assertIn("due_today", data)
        self.assertIn("upcoming", data)

        # 2. Test POST /api/vaani/sales/follow-up/status updates task
        run_id = 8917
        phone = "+918900000017"
        payload = {
            "call_metadata": {"run_id": run_id, "workflow_id": 3, "org_id": 1},
            "primary_phone": phone,
            "customer_name": "Backward Compat Lead",
            "customer_type": "seller",
            "machine_details": {"brand": "Tata Hitachi", "model": "EX 200 LC", "location_city": "Jaipur"},
            "commercial_terms": {"expected_price_inr": 2800000},
            "evidence_readiness": {"photos_agreed": False}
        }
        res = self.ingest_call(payload)
        task_id = res["tasks_created"][0]["task_id"]

        update_res, update_code = self.post_authed(
            "/api/vaani/sales/follow-up/status",
            {"id": task_id, "status": "completed"},
            self.org1_token
        )
        self.assertEqual(update_code, 200)
        self.assertTrue(update_res["success"])
        self.assertEqual(update_res["status"], "COMPLETED")

if __name__ == "__main__":
    unittest.main()
