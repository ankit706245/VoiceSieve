#!/usr/bin/env python3
"""
Phase F — Step 4 Integration Test Suite: WhatsApp Evidence Engine
===================================================================
Product: Shyam Earthmover — Vaani AI Sales Command Center

Validates:
1. Missing photos creates correct request
2. Missing meter creates correct request
3. Missing running video creates correct request
4. Missing RC creates correct request
5. Missing NOC creates correct request
6. Already received evidence is not requested again
7. Already verified evidence is not requested again
8. Outbound message generated from real lead data
9. No hallucinated machine data
10. Mock provider send success
11. Mock provider send failure
12. Outbound message idempotency
13. Inbound webhook authentication failure
14. Inbound webhook authentication success
15. Inbound event idempotency
16. Image evidence recorded
17. Video evidence recorded
18. Document evidence recorded
19. Evidence status RECEIVED != VERIFIED
20. VERIFY_MACHINE task generated when criteria met
21. DNC blocks outbound WhatsApp
22. Cross-tenant outbound access blocked
23. Cross-tenant inbound access blocked
24. Cross-tenant evidence access blocked
25. Lead 360 shows WhatsApp/evidence timeline
26. Duplicate webhook creates no duplicate evidence
27. Invalid evidence type rejected
28. Provider failure creates FAILED state without corrupting task state
29. Complete cleanup verification (0 residual messages, evidence, tasks, inbound events)
"""

import unittest
import urllib.request
import urllib.error
import json
import subprocess
import os
import time

BASE_URL = "http://localhost:8787"

def get_secret(var_name="VAANI_INGESTION_SECRET"):
    secret = os.getenv(var_name, "")
    if not secret and os.path.exists(".env"):
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(f"{var_name}="):
                    secret = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
    return secret

class TestVaaniWhatsAppEvidenceEngine(unittest.TestCase):
    TEST_RUN_IDS = tuple(range(9101, 9140))
    TEST_PHONES = tuple(f"+9191000000{i:02d}" for i in range(1, 40))

    @classmethod
    def clean_test_data(cls):
        run_ids_csv = ",".join(str(i) for i in cls.TEST_RUN_IDS)
        phones_csv = ",".join(f"'{p}'" for p in cls.TEST_PHONES)
        mach_ids_csv = ",".join(f"'mach_run_{i}'" for i in cls.TEST_RUN_IDS)
        lead_ids_csv = ",".join(f"'lead_{i}'" for i in cls.TEST_RUN_IDS)
        raw_lead_ids = ",".join(f"'{i}'" for i in cls.TEST_RUN_IDS)

        sql = f"""
        DELETE FROM public.vaani_whatsapp_inbound_events WHERE from_phone IN ({phones_csv}) OR raw_metadata->>'test' = 'phase_f_step4';
        DELETE FROM public.vaani_whatsapp_messages WHERE phone_number IN ({phones_csv}) OR lead_id IN ({lead_ids_csv}, {raw_lead_ids});
        DELETE FROM public.vaani_digital_evidence WHERE run_id IN ({run_ids_csv}) OR lead_id IN ({lead_ids_csv}, {raw_lead_ids});
        DELETE FROM public.vaani_follow_up_tasks WHERE source_call_id IN ({run_ids_csv}) OR lead_id IN ({lead_ids_csv}, {raw_lead_ids});
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
        cls.secret = get_secret("VAANI_INGESTION_SECRET")
        cls.webhook_secret = get_secret("VAANI_WHATSAPP_WEBHOOK_SECRET") or cls.secret

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
            return json.loads(resp.read().decode("utf-8"))

    def get_authed(self, path, token):
        req = urllib.request.Request(
            f"{BASE_URL}{path}",
            headers={"Cookie": f"rxv_sess={token}"},
            method="GET"
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def post_webhook(self, payload, secret=None, org_id=None):
        headers = {"Content-Type": "application/json"}
        if secret:
            headers["x-vaani-whatsapp-secret"] = secret
        if org_id:
            headers["x-organization-id"] = str(org_id)
        req = urllib.request.Request(
            f"{BASE_URL}/api/v1/vaani/whatsapp/webhook",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))

    # -------------------------------------------------------------
    # Tests 1-5: Deterministic Evidence Request Generation
    # -------------------------------------------------------------
    def test_01_missing_photos_request(self):
        """1. Missing photos creates correct request with Hindi/Hinglish copy"""
        node_script = """
        const { buildEvidenceRequest } = require('./dashboard/lib/vaani-whatsapp');
        const req = buildEvidenceRequest({
          lead: { caller_name: 'Ramesh Patel' },
          machine: { brand: 'Tata Hitachi', model: 'EX 200 LC', model_year: 2021 },
          evidence_type: 'BOOM_PHOTOS'
        });
        console.log(JSON.stringify(req));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(res["template_key"], "REQ_PHOTOS_4SIDE")
        self.assertIn("Tata Hitachi EX 200 LC", res["body"])
        self.assertIn("Ramesh Patel ji", res["body"])
        self.assertIn("4 side ke photos", res["body"])

    def test_02_missing_meter_request(self):
        """2. Missing meter creates correct request"""
        node_script = """
        const { buildEvidenceRequest } = require('./dashboard/lib/vaani-whatsapp');
        const req = buildEvidenceRequest({
          lead: { caller_name: 'Suresh' },
          machine: { brand: 'JCB', model: '3DX' },
          evidence_type: 'HOUR_METER_PHOTO'
        });
        console.log(JSON.stringify(req));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(res["template_key"], "REQ_HOUR_METER")
        self.assertIn("hour meter ka saaf photo", res["body"])
        self.assertIn("JCB 3DX", res["body"])

    def test_03_missing_running_video_request(self):
        """3. Missing running video creates correct request"""
        node_script = """
        const { buildEvidenceRequest } = require('./dashboard/lib/vaani-whatsapp');
        const req = buildEvidenceRequest({
          lead: { caller_name: 'Devendra Singh' },
          machine: { brand: 'Komatsu', model: 'PC 210' },
          evidence_type: 'RUNNING_VIDEO'
        });
        console.log(JSON.stringify(req));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(res["template_key"], "REQ_RUNNING_VIDEO")
        self.assertIn("30 second ka running video", res["body"])

    def test_04_missing_rc_request(self):
        """4. Missing RC creates correct request"""
        node_script = """
        const { buildEvidenceRequest } = require('./dashboard/lib/vaani-whatsapp');
        const req = buildEvidenceRequest({
          lead: { caller_name: 'Mahesh' },
          machine: { brand: 'Hyundai', model: 'R 215' },
          evidence_type: 'RC_DOCUMENT'
        });
        console.log(JSON.stringify(req));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(res["template_key"], "REQ_RC_DOCUMENT")
        self.assertIn("RC (Registration Certificate)", res["body"])

    def test_05_missing_noc_request(self):
        """5. Missing NOC creates correct request"""
        node_script = """
        const { buildEvidenceRequest } = require('./dashboard/lib/vaani-whatsapp');
        const req = buildEvidenceRequest({
          lead: { caller_name: 'Mahesh' },
          machine: { brand: 'Hyundai', model: 'R 215' },
          evidence_type: 'BANK_NOC_DOCUMENT'
        });
        console.log(JSON.stringify(req));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(res["template_key"], "REQ_BANK_NOC")
        self.assertIn("Bank NOC / Clearance certificate", res["body"])

    # -------------------------------------------------------------
    # Tests 6-7: Deduplication against Received/Verified Evidence
    # -------------------------------------------------------------
    def test_06_already_received_evidence_not_requested_again(self):
        """6. Already received evidence is omitted from missing list in readiness"""
        node_script = """
        const { calculateEvidenceReadiness } = require('./dashboard/lib/vaani-whatsapp');
        const items = [
          { evidence_type: 'BOOM_PHOTOS', status: 'RECEIVED' },
          { evidence_type: 'UNDERCARRIAGE_PHOTOS', status: 'RECEIVED' }
        ];
        const readiness = calculateEvidenceReadiness(items);
        console.log(JSON.stringify(readiness));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertIn("BOOM_PHOTOS", res["received"])
        self.assertNotIn("BOOM_PHOTOS", res["missing"])
        self.assertEqual(res["status"], "PARTIAL")

    def test_07_already_verified_evidence_not_requested_again(self):
        """7. Already verified evidence is verified and omitted from missing"""
        node_script = """
        const { calculateEvidenceReadiness } = require('./dashboard/lib/vaani-whatsapp');
        const items = [
          { evidence_type: 'HOUR_METER_PHOTO', status: 'VERIFIED' }
        ];
        const readiness = calculateEvidenceReadiness(items);
        console.log(JSON.stringify(readiness));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertIn("HOUR_METER_PHOTO", res["verified"])
        self.assertNotIn("HOUR_METER_PHOTO", res["missing"])

    # -------------------------------------------------------------
    # Tests 8-9: Zero Hallucination Guarantee
    # -------------------------------------------------------------
    def test_08_outbound_message_generated_from_real_lead_data(self):
        """8. Outbound message generated from real lead data"""
        node_script = """
        const { buildEvidenceRequest } = require('./dashboard/lib/vaani-whatsapp');
        const req = buildEvidenceRequest({
          lead: { caller_name: 'Anil Kumar' },
          machine: { brand: 'Kobelco', model: 'SK 210', model_year: 2020 },
          evidence_type: 'CABIN_GAUGES_PHOTO'
        });
        console.log(JSON.stringify(req));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertIn("Anil Kumar ji", res["body"])
        self.assertIn("Kobelco SK 210", res["body"])

    def test_09_no_hallucinated_machine_data(self):
        """9. No hallucinated machine data when machine model is unknown"""
        node_script = """
        const { buildEvidenceRequest } = require('./dashboard/lib/vaani-whatsapp');
        const req = buildEvidenceRequest({
          lead: { caller_name: '' },
          machine: {},
          evidence_type: 'BOOM_PHOTOS'
        });
        console.log(JSON.stringify(req));
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        # Must not fabricate random models like 'Tata 200' or fake names
        self.assertNotIn("Tata Hitachi", res["body"])
        self.assertNotIn("undefined", res["body"])
        self.assertIn("Aapki excavator machine", res["body"])

    # -------------------------------------------------------------
    # Tests 10-11: Outbound Mock Provider Send & Failure Simulation
    # -------------------------------------------------------------
    def test_10_mock_provider_send_success(self):
        """10. Mock provider send success produces valid SENT state and message_id"""
        node_script = """
        const { MockWhatsAppProvider } = require('./dashboard/lib/vaani-whatsapp');
        const provider = new MockWhatsAppProvider();
        (async () => {
          const res = await provider.sendMessage({
            to: '+919100000010',
            body: 'Namaste ji, photos bhej dijiye'
          });
          console.log(JSON.stringify(res));
        })();
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertTrue(res["success"])
        self.assertEqual(res["status"], "SENT")
        self.assertTrue(res["provider_message_id"].startswith("mock_wa_"))
        self.assertTrue(res["is_dry_run"])

    def test_11_mock_provider_send_failure(self):
        """11. Mock provider simulated failure returns proper error without crashing"""
        node_script = """
        const { MockWhatsAppProvider } = require('./dashboard/lib/vaani-whatsapp');
        const provider = new MockWhatsAppProvider();
        (async () => {
          try {
            await provider.sendMessage({
              to: '+919100000011',
              body: 'Failure test',
              simulate_failure: true
            });
            console.log(JSON.stringify({ error: false }));
          } catch (err) {
            console.log(JSON.stringify({ error: true, message: err.message, code: err.code }));
          }
        })();
        """
        out = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(out.stdout.strip().splitlines()[-1])
        self.assertTrue(res["error"])
        self.assertEqual(res["code"], "SIMULATED_PROVIDER_OUTAGE")

    # -------------------------------------------------------------
    # Test 12: Outbound Message Idempotency
    # -------------------------------------------------------------
    def test_12_outbound_message_idempotency(self):
        """12. Outbound message idempotency blocks duplicate sends for same lead & type"""
        # Ingest a real lead first
        run_id = 9112
        phone = "+919100000012"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Idempotency Tester",
            "callback_number": phone,
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC",
            "conversation_outcome": "lead_qualified"
        })

        # Send request 1
        res1 = self.post_authed(
            f"/api/vaani/sales/leads/{run_id}/evidence/request",
            {"evidence_type": "BOOM_PHOTOS"},
            self.org1_token
        )
        self.assertTrue(res1["success"])
        msg_id_1 = res1["message_id"]

        # Send request 2 with same evidence type
        res2 = self.post_authed(
            f"/api/vaani/sales/leads/{run_id}/evidence/request",
            {"evidence_type": "BOOM_PHOTOS"},
            self.org1_token
        )
        self.assertTrue(res2["success"])
        msg_id_2 = res2["message_id"]
        # Must return same existing message, not a new row
        self.assertEqual(msg_id_1, msg_id_2)

    # -------------------------------------------------------------
    # Tests 13-15: Inbound Webhook Security & Idempotency
    # -------------------------------------------------------------
    def test_13_inbound_webhook_authentication_failure(self):
        """13. Inbound webhook authentication failure returns 401"""
        req = urllib.request.Request(
            f"{BASE_URL}/api/v1/vaani/whatsapp/webhook",
            data=json.dumps({"event_id": "bad_evt_13", "organization_id": 1}).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-vaani-whatsapp-secret": "wrong_secret"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 401)

    def test_14_inbound_webhook_authentication_success(self):
        """14. Inbound webhook authentication success returns 200"""
        evt_id = "evt_test_14_auth_ok"
        res = self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "message_type": "TEXT",
            "from_phone": "+919100000014",
            "text": "Hello, machine is available"
        }, secret=self.webhook_secret)
        self.assertTrue(res["success"])
        self.assertEqual(res["event_id"], evt_id)

    def test_15_inbound_event_idempotency(self):
        """15. Inbound event idempotency returns ignored_duplicate on replay"""
        evt_id = "evt_test_15_replay"
        res1 = self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "message_type": "TEXT",
            "from_phone": "+919100000015",
            "text": "First send"
        }, secret=self.webhook_secret)
        self.assertTrue(res1["success"])

        # Replay same event_id
        res2 = self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "message_type": "TEXT",
            "from_phone": "+919100000015",
            "text": "Duplicate send"
        }, secret=self.webhook_secret)
        self.assertTrue(res2["success"])
        self.assertEqual(res2["status"], "ignored_duplicate")

    # -------------------------------------------------------------
    # Tests 16-18: Media Evidence Classification & Storage
    # -------------------------------------------------------------
    def test_16_image_evidence_recorded(self):
        """16. Inbound image evidence classified and stored"""
        run_id = 9116
        phone = "+919100000016"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Image Sender",
            "callback_number": phone,
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC"
        })

        evt_id = f"evt_img_{run_id}"
        res = self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Hour meter photo 4500 hours",
            "media_url": "https://storage.example.com/media/meter_photo_9116.jpg"
        }, secret=self.webhook_secret)

        self.assertTrue(res["success"])
        self.assertEqual(res["classified_as"], "HOUR_METER_PHOTO")

        # Verify evidence endpoint returns it
        ev_data = self.get_authed(f"/api/vaani/sales/leads/{run_id}/evidence", self.org1_token)
        types_received = [e["evidence_type"] for e in ev_data["evidence"]]
        self.assertIn("HOUR_METER_PHOTO", types_received)

    def test_17_video_evidence_recorded(self):
        """17. Inbound video evidence recorded as RUNNING_VIDEO"""
        run_id = 9117
        phone = "+919100000017"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Video Sender",
            "callback_number": phone,
            "machine_brand": "Komatsu",
            "machine_model": "PC 210"
        })

        evt_id = f"evt_vid_{run_id}"
        res = self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "VIDEO",
            "text": "Machine running video 30s",
            "media_url": "https://storage.example.com/media/running_video_9117.mp4"
        }, secret=self.webhook_secret)

        self.assertTrue(res["success"])
        self.assertEqual(res["classified_as"], "RUNNING_VIDEO")

    def test_18_document_evidence_recorded(self):
        """18. Inbound document evidence recorded as RC_DOCUMENT"""
        run_id = 9118
        phone = "+919100000018"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "RC Document Sender",
            "callback_number": phone,
            "machine_brand": "JCB",
            "machine_model": "3DX"
        })

        evt_id = f"evt_doc_{run_id}"
        res = self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "DOCUMENT",
            "filename": "rc_book_ex200.pdf",
            "text": "RC copy attached",
            "media_url": "https://storage.example.com/media/rc_book_9118.pdf"
        }, secret=self.webhook_secret)

        self.assertTrue(res["success"])
        self.assertEqual(res["classified_as"], "RC_DOCUMENT")

    # -------------------------------------------------------------
    # Tests 19-20: State Separation (RECEIVED != VERIFIED) & Task Trigger
    # -------------------------------------------------------------
    def test_19_evidence_status_received_not_verified(self):
        """19. Evidence status RECEIVED != VERIFIED (strict separation)"""
        run_id = 9119
        phone = "+919100000019"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Separation Check",
            "callback_number": phone,
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 210 LC"
        })

        self.post_webhook({
            "event_id": f"evt_19_{run_id}",
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Boom photo",
            "media_url": "https://storage.example.com/media/boom_9119.jpg"
        }, secret=self.webhook_secret)

        ev_data = self.get_authed(f"/api/vaani/sales/leads/{run_id}/evidence", self.org1_token)
        evidence_item = ev_data["evidence"][0]
        self.assertEqual(evidence_item["status"], "RECEIVED")
        self.assertIsNone(evidence_item.get("verified_at"))
        self.assertIn("BOOM_PHOTOS", ev_data["readiness"]["received"])
        self.assertNotIn("BOOM_PHOTOS", ev_data["readiness"]["verified"])

    def test_20_verify_machine_task_generated_when_criteria_met(self):
        """20. VERIFY_MACHINE task generated when inspection criteria met"""
        run_id = 9120
        phone = "+919100000020"
        # Ingest call missing photos and video
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Full Evidence Seller",
            "callback_number": phone,
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC",
            "conversation_outcome": "lead_qualified"
        })

        # Submit Boom photo
        self.post_webhook({
            "event_id": f"evt_20_boom_{run_id}",
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Machine boom photo",
            "media_url": "https://storage.example.com/boom.jpg"
        }, secret=self.webhook_secret)

        # Submit Meter photo
        self.post_webhook({
            "event_id": f"evt_20_meter_{run_id}",
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Hour meter reading photo",
            "media_url": "https://storage.example.com/meter.jpg"
        }, secret=self.webhook_secret)

        # Submit Running video -> triggers readiness >= 3
        res_vid = self.post_webhook({
            "event_id": f"evt_20_vid_{run_id}",
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "VIDEO",
            "text": "Running video 30s",
            "media_url": "https://storage.example.com/video.mp4"
        }, secret=self.webhook_secret)

        self.assertTrue(res_vid["success"])

        # Check follow-up tasks to verify VERIFY_MACHINE was created
        tasks_resp = self.get_authed(f"/api/vaani/sales/tasks", self.org1_token)
        lead_tasks = [t for t in tasks_resp["tasks"] if str(t.get("source_call_id")) == str(run_id) or str(t.get("lead_id")) == f"lead_{run_id}"]
        verify_tasks = [t for t in lead_tasks if t["task_type"] == "VERIFY_MACHINE"]
        self.assertGreaterEqual(len(verify_tasks), 1)

    # -------------------------------------------------------------
    # Test 21: DNC Compliance Quarantine
    # -------------------------------------------------------------
    def test_21_dnc_blocks_outbound_whatsapp(self):
        """21. DNC blocks outbound WhatsApp evidence requests"""
        run_id = 9121
        phone = "+919100000021"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Opt Out Caller",
            "callback_number": phone,
            "dnc_requested": True,
            "customer_type": "dnc"
        })

        req = urllib.request.Request(
            f"{BASE_URL}/api/vaani/sales/leads/{run_id}/evidence/request",
            data=json.dumps({"evidence_type": "BOOM_PHOTOS"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Cookie": f"rxv_sess={self.org1_token}"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 403)

    # -------------------------------------------------------------
    # Tests 22-24: Strict Cross-Tenant Security Isolation
    # -------------------------------------------------------------
    def test_22_cross_tenant_outbound_access_blocked(self):
        """22. Client A cannot trigger outbound WhatsApp for Client B lead (404)"""
        # Ingest call for org 1
        run_id = 9122
        phone = "+919100000022"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Org 1 Seller",
            "callback_number": phone,
            "organization_id": 1
        })

        # Attempt request as org 2
        req = urllib.request.Request(
            f"{BASE_URL}/api/vaani/sales/leads/{run_id}/evidence/request",
            data=json.dumps({"evidence_type": "BOOM_PHOTOS"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Cookie": f"rxv_sess={self.org2_token}"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        # Should be blocked (400, 403 or 404)
        self.assertIn(ctx.exception.code, (400, 403, 404))

    def test_23_cross_tenant_inbound_access_blocked(self):
        """23. Inbound webhook for org 2 cannot attach media to org 1 lead"""
        run_id = 9123
        phone = "+919100000023"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Org 1 Lead Only",
            "callback_number": phone,
            "organization_id": 1
        })

        # Submit inbound media specifying organization_id = 2
        res = self.post_webhook({
            "event_id": f"evt_23_org2_{run_id}",
            "organization_id": 2,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Cross tenant media attempt",
            "media_url": "https://storage.example.com/exploit.jpg"
        }, secret=self.webhook_secret)

        # In org 1, this evidence must NOT appear
        ev_data_org1 = self.get_authed(f"/api/vaani/sales/leads/{run_id}/evidence", self.org1_token)
        self.assertEqual(len(ev_data_org1["evidence"]), 0)

    def test_24_cross_tenant_evidence_access_blocked(self):
        """24. Cross-tenant evidence access returns empty/not found"""
        run_id = 9124
        phone = "+919100000024"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Org 1 Sensitive Machine",
            "callback_number": phone,
            "organization_id": 1
        })

        # Query as org 2
        ev_data_org2 = self.get_authed(f"/api/vaani/sales/leads/{run_id}/evidence", self.org2_token)
        self.assertEqual(len(ev_data_org2["evidence"]), 0)

    # -------------------------------------------------------------
    # Tests 25-28: Lead 360, Duplicate Protection, Validation, Resilience
    # -------------------------------------------------------------
    def test_25_lead_360_shows_whatsapp_evidence_timeline(self):
        """25. Lead 360 timeline displays WhatsApp and Evidence events"""
        run_id = 9125
        phone = "+919100000025"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Timeline Lead",
            "callback_number": phone,
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC"
        })

        # Send outbound request
        self.post_authed(
            f"/api/vaani/sales/leads/{run_id}/evidence/request",
            {"evidence_type": "HOUR_METER_PHOTO"},
            self.org1_token
        )

        # Ingest inbound response
        self.post_webhook({
            "event_id": f"evt_25_{run_id}",
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Hour meter photo 3500h",
            "media_url": "https://storage.example.com/meter25.jpg"
        }, secret=self.webhook_secret)

        # Check Lead 360 timeline
        l360 = self.get_authed(f"/api/vaani/sales/leads/{run_id}", self.org1_token)
        timeline = l360.get("timeline", [])
        activity_types = [t.get("activity_type") for t in timeline]

        self.assertIn("WHATSAPP_MESSAGE_SENT", activity_types)
        self.assertIn("EVIDENCE_RECEIVED", activity_types)

        # Verify WhatsApp block in Lead 360
        self.assertIn("whatsapp", l360)
        self.assertEqual(l360["whatsapp"]["indicator"], "WHATSAPP: DRY RUN")
        self.assertTrue(l360["whatsapp"]["is_dry_run"])

    def test_26_duplicate_webhook_no_duplicate_evidence(self):
        """26. Replayed webhook does not duplicate evidence records"""
        run_id = 9126
        phone = "+919100000026"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Replay Lead",
            "callback_number": phone
        })

        evt_id = f"evt_26_repeat_{run_id}"
        # Send twice
        self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Running video 30s",
            "media_url": "https://storage.example.com/meter26.jpg"
        }, secret=self.webhook_secret)

        self.post_webhook({
            "event_id": evt_id,
            "organization_id": 1,
            "lead_id": str(run_id),
            "from_phone": phone,
            "message_type": "IMAGE",
            "text": "Running video 30s",
            "media_url": "https://storage.example.com/meter26.jpg"
        }, secret=self.webhook_secret)

        ev_data = self.get_authed(f"/api/vaani/sales/leads/{run_id}/evidence", self.org1_token)
        self.assertEqual(len(ev_data["evidence"]), 1)

    def test_27_invalid_evidence_type_rejected(self):
        """27. Invalid evidence type rejected with 422 Unprocessable Entity"""
        run_id = 9127
        phone = "+919100000027"
        self.ingest_call({
            "run_id": run_id,
            "caller_name": "Invalid Type Lead",
            "callback_number": phone
        })

        req = urllib.request.Request(
            f"{BASE_URL}/api/vaani/sales/leads/{run_id}/evidence/request",
            data=json.dumps({"evidence_type": "INVALID_EVIDENCE_TYPE"}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Cookie": f"rxv_sess={self.org1_token}"},
            method="POST"
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 422)

    def test_28_provider_failure_does_not_corrupt_task_state(self):
        """28. Provider failure creates FAILED message without corrupting task state"""
        run_id = 9128
        phone = "+919100000028"
        # Ingest call with missing photos -> task created
        ingest_res = self.ingest_call({
            "run_id": run_id,
            "caller_name": "Failure Resilient Lead",
            "callback_number": phone,
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC",
            "conversation_outcome": "lead_qualified"
        })

        # Request evidence with simulated failure
        res = self.post_authed(
            f"/api/vaani/sales/leads/{run_id}/evidence/request",
            {
                "evidence_type": "BOOM_PHOTOS",
                "provider_options": {"simulate_failure": True}
            },
            self.org1_token
        )

        self.assertFalse(res["success"])
        self.assertEqual(res["status"], "FAILED")

        # Verify task is still intact (PENDING) in vaani_follow_up_tasks
        tasks_resp = self.get_authed(f"/api/vaani/sales/tasks", self.org1_token)
        lead_tasks = [t for t in tasks_resp["tasks"] if str(t.get("source_call_id")) == str(run_id) or str(t.get("lead_id")) == f"lead_{run_id}"]
        self.assertGreaterEqual(len(lead_tasks), 1)
        for t in lead_tasks:
            self.assertIn(t["status"], ("PENDING", "IN_PROGRESS"))

    def test_29_cleanup_verification(self):
        """29. Cleanup verification confirms 0 residual records in all WhatsApp & evidence tables"""
        # Run teardown cleanup
        self.clean_test_data()

        run_ids_csv = ",".join(str(i) for i in self.TEST_RUN_IDS)
        phones_csv = ",".join(f"'{p}'" for p in self.TEST_PHONES)
        sql = f"""
        SELECT
          (SELECT COUNT(*) FROM public.vaani_whatsapp_messages WHERE phone_number IN ({phones_csv})) as messages_count,
          (SELECT COUNT(*) FROM public.vaani_digital_evidence WHERE run_id IN ({run_ids_csv})) as evidence_count,
          (SELECT COUNT(*) FROM public.vaani_follow_up_tasks WHERE source_call_id IN ({run_ids_csv})) as tasks_count,
          (SELECT COUNT(*) FROM public.vaani_whatsapp_inbound_events WHERE from_phone IN ({phones_csv})) as inbound_count;
        """
        res = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
            capture_output=True,
            text=True
        )
        counts = [int(c) for c in res.stdout.strip().split("|")]
        self.assertEqual(counts, [0, 0, 0, 0], f"Residual records detected: {counts}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
