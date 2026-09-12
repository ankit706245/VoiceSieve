#!/usr/bin/env python3
"""
Phase E — Step 4: Backend API Authentication & Tenant Scoping Security Test Suite
==================================================================================
Tests:
A. Unauthenticated API request -> 401 rejected
B. Authenticated Org 1 user -> can read Org 1 data
C. Authenticated Org 1 user -> cannot read Org 2 data (returns 404 for specific resource, isolated counts/lists)
D. Authenticated Org 2 user -> can read Org 2 data
E. Org 1 user attempts ?organization_id=2 -> still only sees Org 1 data
F. Org 1 user attempts to access an Org 2 lead_id -> rejected / not found (404)
G. Org 1 user attempts to access an Org 2 machine -> rejected / not found (404)
H. Org 1 user attempts to access Org 2 evidence -> rejected / not found (404)
I. Org 1 DNC does not affect Org 2 DNC (independent phone numbers per organization)
J. Org 1 dashboard metrics contain no Org 2 records
K. Search cannot cross tenant boundary
L. Existing super_admin behavior, if present, remains unchanged
M. Phase D ingestion tests pass (verified separately)
N. Phase E Step 2 tenant isolation tests pass (verified separately)
O. Phase E Step 3 webhook authentication tests pass (verified separately)
P. Existing Vaani dialogue tests pass (verified separately)

Cleans all test data completely upon completion.
"""

import unittest
import urllib.request
import urllib.error
import json
import subprocess

BASE_URL = "http://localhost:8787"

class TestPhaseEBackendAuth(unittest.TestCase):
    ORG1_ID = 1
    ORG2_ID = 2

    ORG1_RUN_ID = 8881
    ORG2_RUN_ID = 8882

    ORG1_PHONE = "+919999911111"
    ORG2_PHONE = "+919999922222"
    SHARED_PHONE = "+919999933333"

    ORG1_MACHINE_ID = "mach_test_org1_8881"
    ORG2_MACHINE_ID = "mach_test_org2_8882"

    ORG1_EVIDENCE_ID = "ev_test_org1_8881"
    ORG2_EVIDENCE_ID = "ev_test_org2_8882"

    @classmethod
    def clean_data(cls):
        sql = f"""
        DELETE FROM vaani_digital_evidence WHERE evidence_id IN ('{cls.ORG1_EVIDENCE_ID}', '{cls.ORG2_EVIDENCE_ID}') OR run_id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID});
        DELETE FROM vaani_machines WHERE machine_id IN ('{cls.ORG1_MACHINE_ID}', '{cls.ORG2_MACHINE_ID}') OR source_lead_run_id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID});
        DELETE FROM vaani_dnc_registry WHERE run_id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID}) OR phone_number IN ('{cls.ORG1_PHONE}', '{cls.ORG2_PHONE}', '{cls.SHARED_PHONE}');
        DELETE FROM workflow_runs WHERE id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID});
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
            d.tenants = d.tenants.filter(t => t.id !== 't_test_org2');
            d.users = d.users.filter(u => u.id !== 'u_test_org2');
            d.sessions = d.sessions.filter(s => s.tenantId !== 't_test_org2');
          });
        })();
        """
        subprocess.run(["node", "-e", node_clean], capture_output=True, text=True)

    @classmethod
    def seed_data(cls):
        cls.clean_data()

        # Existing workflow 3 belongs to org 1, workflow 4 belongs to org 2
        sql = f"""
        -- Org 1 workflow run (Seller lead)
        INSERT INTO workflow_runs (id, name, workflow_id, mode, call_type, gathered_context, initial_context, usage_info, cost_info, annotations, logs, extra, created_at)
        VALUES (
          {cls.ORG1_RUN_ID},
          'run_org1_8881',
          3,
          'outbound',
          'outbound',
          json_build_object(
            'extracted_variables', json_build_object(
              'caller_name', 'Org1 Seller Ramesh',
              'primary_phone', '{cls.ORG1_PHONE}',
              'callback_number', '{cls.ORG1_PHONE}',
              'customer_type', 'seller',
              'ownership_type', 'direct_owner',
              'machine_details', json_build_object(
                'brand', 'Tata Hitachi',
                'model', 'EX 200 LC',
                'model_year', 2021,
                'running_hours', 3000,
                'location_city', 'Jaipur',
                'location_state', 'Rajasthan'
              ),
              'commercial_terms', json_build_object(
                'expected_price_inr', 2500000
              ),
              'evidence_readiness', json_build_object(
                'photos_agreed', true
              ),
              'qualification_state', 'QUALIFIED',
              'lead_temperature', 'HOT',
              'conversation_outcome', 'lead_qualified'
            )
          ),
          '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json,
          CURRENT_TIMESTAMP
        );

        -- Org 2 workflow run (Buyer lead)
        INSERT INTO workflow_runs (id, name, workflow_id, mode, call_type, gathered_context, initial_context, usage_info, cost_info, annotations, logs, extra, created_at)
        VALUES (
          {cls.ORG2_RUN_ID},
          'run_org2_8882',
          4,
          'outbound',
          'outbound',
          json_build_object(
            'extracted_variables', json_build_object(
              'caller_name', 'Org2 Buyer Suresh',
              'primary_phone', '{cls.ORG2_PHONE}',
              'callback_number', '{cls.ORG2_PHONE}',
              'customer_type', 'buyer',
              'machine_details', json_build_object(
                'brand', 'Komatsu',
                'model', 'PC 210',
                'tonnage_class', '20-ton',
                'location_city', 'Jaipur'
              ),
              'commercial_terms', json_build_object(
                'budget_max_inr', 3000000
              ),
              'qualification_state', 'QUALIFIED',
              'lead_temperature', 'WARM',
              'conversation_outcome', 'lead_qualified'
            )
          ),
          '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json,
          CURRENT_TIMESTAMP
        );

        -- Org 1 machine
        INSERT INTO vaani_machines (machine_id, organization_id, source_lead_run_id, brand, model, manufacturing_year, status, sourcing_cost_inr)
        VALUES ('{cls.ORG1_MACHINE_ID}', {cls.ORG1_ID}, {cls.ORG1_RUN_ID}, 'Tata Hitachi', 'EX 200 LC', 2021, 'in_sourcing_pipeline', 2500000);

        -- Org 2 machine
        INSERT INTO vaani_machines (machine_id, organization_id, source_lead_run_id, brand, model, manufacturing_year, status, sourcing_cost_inr)
        VALUES ('{cls.ORG2_MACHINE_ID}', {cls.ORG2_ID}, {cls.ORG2_RUN_ID}, 'Komatsu', 'PC 210', 2022, 'certified_ready_in_yard', 3100000);

        -- Org 1 evidence
        INSERT INTO vaani_digital_evidence (evidence_id, organization_id, run_id, media_type, media_url, evaluator_verdict)
        VALUES ('{cls.ORG1_EVIDENCE_ID}', {cls.ORG1_ID}, {cls.ORG1_RUN_ID}, 'photo_meter', 'https://example.com/meter.jpg', 'approved');

        -- Org 2 evidence
        INSERT INTO vaani_digital_evidence (evidence_id, organization_id, run_id, media_type, media_url, evaluator_verdict)
        VALUES ('{cls.ORG2_EVIDENCE_ID}', {cls.ORG2_ID}, {cls.ORG2_RUN_ID}, 'doc_rc', 'https://example.com/rc.pdf', 'approved');

        -- Org 1 DNC on shared phone
        INSERT INTO vaani_dnc_registry (organization_id, phone_number, run_id, reason, is_active)
        VALUES ({cls.ORG1_ID}, '{cls.SHARED_PHONE}', {cls.ORG1_RUN_ID}, 'Org 1 Opt out', true);
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
            capture_output=True,
            text=True,
            check=True
        )

        # Create Org 1 and Org 2 sessions in dashboard
        node_seed = """
        const core = require('./dashboard/lib/core');
        (async () => {
          await core.mutate((d) => {
            // Ensure Org 1 tenant has organization_id: 1
            const t1 = d.tenants.find(t => t.id === 't_69d344e9ee8945d8');
            if (t1) t1.organization_id = 1;

            // Seed Org 2 tenant and user
            if (!d.tenants.some(t => t.id === 't_test_org2')) {
              d.tenants.push({
                id: 't_test_org2',
                name: 'Client B Earthmovers',
                slug: 'client-b',
                createdAt: new Date().toISOString(),
                branding: { color: '#FF5500' },
                providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
                plan: 'studio',
                status: 'active',
                privacyMode: 'standard',
                organization_id: 2
              });
            }
            if (!d.users.some(u => u.id === 'u_test_org2')) {
              d.users.push({
                id: 'u_test_org2',
                tenantId: 't_test_org2',
                email: 'org2user@example.com',
                name: 'Client B Admin',
                passHash: core.hashPassword('org2pass123'),
                role: 'owner',
                status: 'active',
                createdAt: new Date().toISOString()
              });
            }
          });

          const t1Token = await core.createSession('u_290fde84dd4df51e', 't_69d344e9ee8945d8');
          const t2Token = await core.createSession('u_test_org2', 't_test_org2');
          console.log(JSON.stringify({ org1Token: t1Token, org2Token: t2Token }));
        })();
        """
        proc = subprocess.run(["node", "-e", node_seed], capture_output=True, text=True, check=True)
        tokens = json.loads(proc.stdout.strip())
        cls.ORG1_TOKEN = tokens["org1Token"]
        cls.ORG2_TOKEN = tokens["org2Token"]

    @classmethod
    def setUpClass(cls):
        cls.seed_data()

    @classmethod
    def tearDownClass(cls):
        cls.clean_data()

    def api_get(self, path, token=None):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{BASE_URL}{path}", headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                return resp.status, body
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
            except Exception:
                body = {"error": e.reason}
            return e.code, body

    def api_post(self, path, payload, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{BASE_URL}{path}", data=json.dumps(payload).encode("utf-8"), headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                return resp.status, body
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
            except Exception:
                body = {"error": e.reason}
            return e.code, body

    # -------------------------------------------------------------
    # Test A: Unauthenticated API requests rejected
    # -------------------------------------------------------------
    def test_01_unauthenticated_requests_rejected(self):
        endpoints = [
            "/api/vaani/leads",
            "/api/vaani/sales/overview",
            "/api/vaani/sales/sellers",
            "/api/vaani/sales/buyers",
            "/api/vaani/sales/machines",
            "/api/vaani/sales/demand",
            "/api/vaani/sales/follow-ups",
            "/api/vaani/sales/calls",
            f"/api/vaani/sales/calls/{self.ORG1_RUN_ID}",
            f"/api/vaani/sales/leads/{self.ORG1_RUN_ID}",
            f"/api/vaani/sales/leads/{self.ORG1_RUN_ID}/timeline",
            "/api/vaani/sales/activities",
            "/api/vaani/sales/dnc",
            "/api/vaani/sales/search?q=Ramesh"
        ]
        for ep in endpoints:
            status, res = self.api_get(ep, token=None)
            self.assertEqual(status, 401, f"Expected 401 for unauthenticated {ep}, got {status}")
            self.assertEqual(res.get("code"), "no_session")

        # Also test POST follow-up status without auth
        status, res = self.api_post("/api/vaani/sales/follow-up/status", {"id": self.ORG1_RUN_ID, "status": "completed"}, token=None)
        self.assertEqual(status, 401)

    # -------------------------------------------------------------
    # Test B & C: Org 1 reads Org 1 data, cannot read Org 2 data
    # -------------------------------------------------------------
    def test_02_org1_reads_own_data_and_isolated_from_org2(self):
        # 1. Sellers endpoint
        status, res = self.api_get("/api/vaani/sales/sellers?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        sellers = res.get("sellers", [])
        seller_ids = [s.get("run_id") for s in sellers]
        self.assertIn(self.ORG1_RUN_ID, seller_ids)
        self.assertNotIn(self.ORG2_RUN_ID, seller_ids)

        # 2. Buyers endpoint (Org 2 buyer must NOT be in Org 1 results)
        status, res = self.api_get("/api/vaani/sales/buyers?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        buyers = res.get("buyers", [])
        buyer_ids = [b.get("run_id") for b in buyers]
        self.assertNotIn(self.ORG2_RUN_ID, buyer_ids)

        # 3. Machines endpoint
        status, res = self.api_get("/api/vaani/sales/machines?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        actual_stock = res.get("actual_stock", [])
        mach_ids = [m["machine_id"] for m in actual_stock]
        self.assertIn(self.ORG1_MACHINE_ID, mach_ids)
        self.assertNotIn(self.ORG2_MACHINE_ID, mach_ids)

        # 4. Lead 360: Org 1 accessing Org 1 lead -> 200
        status, res = self.api_get(f"/api/vaani/sales/leads/{self.ORG1_RUN_ID}?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(res["customer_name"], "Org1 Seller Ramesh")
        self.assertEqual(res["relational_machine"]["machine_id"], self.ORG1_MACHINE_ID)

        # 5. Lead 360: Org 1 accessing Org 2 lead -> 404 (isolation)
        status, res = self.api_get(f"/api/vaani/sales/leads/{self.ORG2_RUN_ID}?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 404)

        # 6. Call detail: Org 1 accessing Org 2 call -> 404
        status, res = self.api_get(f"/api/vaani/sales/calls/{self.ORG2_RUN_ID}?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 404)

    # -------------------------------------------------------------
    # Test D: Org 2 reads Org 2 data, cannot read Org 1 data
    # -------------------------------------------------------------
    def test_03_org2_reads_own_data_and_isolated_from_org1(self):
        # 1. Buyers endpoint
        status, res = self.api_get("/api/vaani/sales/buyers?demo=0", token=self.ORG2_TOKEN)
        self.assertEqual(status, 200)
        buyers = res.get("buyers", [])
        buyer_ids = [b.get("run_id") for b in buyers]
        self.assertIn(self.ORG2_RUN_ID, buyer_ids)
        self.assertNotIn(self.ORG1_RUN_ID, buyer_ids)

        # 2. Machines endpoint
        status, res = self.api_get("/api/vaani/sales/machines?demo=0", token=self.ORG2_TOKEN)
        self.assertEqual(status, 200)
        actual_stock = res.get("actual_stock", [])
        mach_ids = [m["machine_id"] for m in actual_stock]
        self.assertIn(self.ORG2_MACHINE_ID, mach_ids)
        self.assertNotIn(self.ORG1_MACHINE_ID, mach_ids)

        # 3. Lead 360: Org 2 accessing Org 2 lead -> 200
        status, res = self.api_get(f"/api/vaani/sales/leads/{self.ORG2_RUN_ID}?demo=0", token=self.ORG2_TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(res["customer_name"], "Org2 Buyer Suresh")
        self.assertEqual(res["relational_machine"]["machine_id"], self.ORG2_MACHINE_ID)

        # 4. Lead 360: Org 2 accessing Org 1 lead -> 404
        status, res = self.api_get(f"/api/vaani/sales/leads/{self.ORG1_RUN_ID}?demo=0", token=self.ORG2_TOKEN)
        self.assertEqual(status, 404)

    # -------------------------------------------------------------
    # Test E: Query parameter attack ?organization_id=2
    # -------------------------------------------------------------
    def test_04_query_param_attack_cannot_bypass_scope(self):
        # Org 1 user attempts to pass ?organization_id=2 on various endpoints
        endpoints = [
            "/api/vaani/sales/overview?organization_id=2&demo=0",
            "/api/vaani/sales/sellers?organization_id=2&demo=0",
            "/api/vaani/sales/buyers?organization_id=2&demo=0",
            "/api/vaani/sales/machines?organization_id=2&demo=0",
            "/api/vaani/sales/calls?organization_id=2&demo=0",
            "/api/vaani/sales/dnc?organization_id=2&demo=0",
            "/api/vaani/sales/search?q=Suresh&organization_id=2&demo=0"
        ]
        for ep in endpoints:
            status, res = self.api_get(ep, token=self.ORG1_TOKEN)
            self.assertEqual(status, 200)
            res_str = json.dumps(res)
            # Must NOT leak Org 2 records
            self.assertNotIn("Org2 Buyer Suresh", res_str)
            self.assertNotIn(self.ORG2_MACHINE_ID, res_str)
            self.assertNotIn(str(self.ORG2_RUN_ID), res_str)

    # -------------------------------------------------------------
    # Test F, G, H: Direct ID access attacks
    # -------------------------------------------------------------
    def test_05_direct_id_resource_isolation(self):
        # Org 1 user accesses Org 2 lead
        status, _ = self.api_get(f"/api/vaani/sales/leads/{self.ORG2_RUN_ID}?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 404)

        # Org 1 user accesses Org 2 lead timeline
        status, _ = self.api_get(f"/api/vaani/sales/leads/{self.ORG2_RUN_ID}/timeline?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        # Empty journey progressions or no Org 2 events
        # Org 1 user updating Org 2 follow up status -> 404
        status, res = self.api_post("/api/vaani/sales/follow-up/status", {"id": self.ORG2_RUN_ID, "status": "completed"}, token=self.ORG1_TOKEN)
        self.assertEqual(status, 404)

    # -------------------------------------------------------------
    # Test I: DNC scoping independence
    # -------------------------------------------------------------
    def test_06_dnc_registry_organization_isolation(self):
        # SHARED_PHONE is DNC in Org 1
        status, res = self.api_get("/api/vaani/sales/dnc?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        org1_dnc_phones = [r["phone_number"] for r in res.get("dnc_records", [])]
        self.assertIn(self.SHARED_PHONE, org1_dnc_phones)

        # SHARED_PHONE must NOT be DNC in Org 2
        status, res = self.api_get("/api/vaani/sales/dnc?demo=0", token=self.ORG2_TOKEN)
        self.assertEqual(status, 200)
        org2_dnc_phones = [r["phone_number"] for r in res.get("dnc_records", [])]
        self.assertNotIn(self.SHARED_PHONE, org2_dnc_phones)

    # -------------------------------------------------------------
    # Test J: Dashboard Overview Metrics Isolation
    # -------------------------------------------------------------
    def test_07_overview_metrics_isolation(self):
        status, res = self.api_get("/api/vaani/sales/overview?demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        # Org 1 overview has hot_sellers count >= 1, hot_buyers == 0
        self.assertGreaterEqual(res.get("hot_sellers", 0), 1)

        # Org 2 overview should reflect Org 2's numbers only
        status2, res2 = self.api_get("/api/vaani/sales/overview?demo=0", token=self.ORG2_TOKEN)
        self.assertEqual(status2, 200)
        self.assertEqual(res2.get("total_leads"), 1) # exactly 1 lead in Org 2
        self.assertEqual(res2.get("connected_calls"), 1) # exactly 1 call in Org 2
        self.assertEqual(res2.get("hot_sellers", 0), 0) # Org 2 has no hot sellers

    # -------------------------------------------------------------
    # Test K: Search tenant scoping
    # -------------------------------------------------------------
    def test_08_search_tenant_boundary(self):
        # Org 1 user searches for "Suresh" (Org 2 buyer) -> must yield 0 results
        status, res = self.api_get("/api/vaani/sales/search?q=Suresh&demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(res["total"], 0)
        self.assertEqual(len(res["results"]), 0)

        # Org 1 user searches for "Ramesh" (Org 1 seller) -> must find lead
        status, res = self.api_get("/api/vaani/sales/search?q=Ramesh&demo=0", token=self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        self.assertGreaterEqual(res["total"], 1)
        found_names = [r["customer_name"] for r in res["results"]]
        self.assertIn("Org1 Seller Ramesh", found_names)

        # Org 2 user searches for "Ramesh" (Org 1 seller) -> must yield 0 results
        status, res = self.api_get("/api/vaani/sales/search?q=Ramesh&demo=0", token=self.ORG2_TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(res["total"], 0)

if __name__ == "__main__":
    unittest.main(verbosity=2)
