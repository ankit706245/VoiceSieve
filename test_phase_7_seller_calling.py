import unittest
import urllib.request
import urllib.error
import json
import subprocess
import time

BASE_URL = "http://localhost:8787"

class TestPhase7SellerCalling(unittest.TestCase):
    ORG1_ID = 1
    ORG2_ID = 2

    @classmethod
    def get_token(cls, org_id):
        node_seed = f"""
        const core = require('./dashboard/lib/core');
        (async () => {{
           const token = await core.createSession({org_id} === 1 ? 'u_290fde84dd4df51e' : 'u_test_org2', {org_id} === 1 ? 't_69d344e9ee8945d8' : 't_test_org2');
           console.log(token);
        }})();
        """
        proc = subprocess.run(["node", "-e", node_seed], capture_output=True, text=True, check=True)
        return proc.stdout.strip()

    @classmethod
    def setUpClass(cls):
        # Create test users if they don't exist
        node_setup = """
        const core = require('./dashboard/lib/core');
        (async () => {
          await core.mutate((d) => {
            if (!d.tenants.some(t => t.id === 't_test_org2')) {
              d.tenants.push({ id: 't_test_org2', name: 'Org 2', status: 'active', organization_id: 2 });
            }
            if (!d.users.some(u => u.id === 'u_test_org2')) {
              d.users.push({ id: 'u_test_org2', tenantId: 't_test_org2', email: 'org2@test.com', name: 'Org 2', passHash: 'xxx', role: 'owner', status: 'active' });
            }
          });
        })();
        """
        subprocess.run(["node", "-e", node_setup], capture_output=True, text=True)
        cls.ORG1_TOKEN = cls.get_token(1)
        cls.ORG2_TOKEN = cls.get_token(2)

        cls.server_proc = subprocess.Popen(["node", "dashboard/server.js"])
        time.sleep(1.5)

        sql = "DELETE FROM vaani_follow_up_tasks WHERE source_call_id IN (SELECT id + 900000 FROM vaani_calls WHERE customer_id IN (SELECT id FROM vaani_customers WHERE name = 'Phase 7 Test Seller v2')); DELETE FROM vaani_call_summaries WHERE call_id IN (SELECT id FROM vaani_calls WHERE customer_id IN (SELECT id FROM vaani_customers WHERE name = 'Phase 7 Test Seller v2')); DELETE FROM vaani_calls WHERE customer_id IN (SELECT id FROM vaani_customers WHERE name = 'Phase 7 Test Seller v2'); DELETE FROM vaani_customers WHERE name = 'Phase 7 Test Seller v2';"
        subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql])

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'server_proc'):
            cls.server_proc.terminate()
            cls.server_proc.wait()

    def api_post(self, path, payload, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{BASE_URL}{path}", data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_01_unauthenticated_rejected(self):
        status, data = self.api_post('/api/vaani/sales/outbound/seller', {
            "name": "Phase 7 Test Seller v2",
            "phone": "9999911111",
            "machine_requirement": "Tata 200"
        })
        self.assertEqual(status, 401)
        self.assertEqual(data.get("error"), "authentication required")

    def test_02_validation_error(self):
        status, data = self.api_post('/api/vaani/sales/outbound/seller', {
            "name": "Phase 7 Test Seller v2",
            "phone": "123" # invalid phone
        }, self.ORG1_TOKEN)
        self.assertEqual(status, 422)
        self.assertEqual(data.get("code"), "invalid_phone")

        status, data = self.api_post('/api/vaani/sales/outbound/seller', {
            "name": "",
            "phone": "9999911111"
        }, self.ORG1_TOKEN)
        self.assertEqual(status, 422)
        self.assertEqual(data.get("code"), "bad_request")

    def test_03_seller_call_demo_fallback(self):
        # Initiate a seller call
        status, data = self.api_post('/api/vaani/sales/outbound/seller', {
            "name": "Phase 7 Test Seller",
            "phone": "9999911111",
            "machine_requirement": "Komatsu PC210",
            "price": "Rs 28 Lakhs",
            "city": "Pune"
        }, self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        self.assertTrue(data.get("success"))

        # In this local environment without Dograh, it should fall back to DEMO
        self.assertEqual(data.get("call_status"), "DEMO")
        self.assertIn("telephony_boundary", data)
        self.assertIn("telephony_missing", data)

        # Wait a moment for background _runDemoSellerCall to insert the call and tasks
        time.sleep(2)

        call_id = data.get("call_id")
        customer_id = data.get("customer_id")
        self.assertIsNotNone(call_id)

        # Verify the database records were created via CLI query to postgres
        sql_check_call = f"SELECT status, mode FROM vaani_calls WHERE id = {call_id};"
        proc = subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", sql_check_call], capture_output=True, text=True)
        self.assertIn("demo", proc.stdout.strip())

        # Verify transcript summary
        sql_check_summary = f"SELECT customer_requirement, interest_level, customer_intent FROM vaani_call_summaries WHERE call_id = {call_id};"
        proc = subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", sql_check_summary], capture_output=True, text=True)
        summary_out = proc.stdout.strip()
        self.assertIn("Komatsu PC210", summary_out)
        self.assertIn("Warm", summary_out)
        self.assertIn("Sell", summary_out)

        # Verify follow up task was created correctly (org 1)
        run_id = 900000 + call_id
        sql_check_tasks = f"SELECT source_call_id, task_type, status, priority, metadata->>'qualification_state' FROM vaani_follow_up_tasks WHERE source_call_id = {run_id};"
        proc = subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-c", sql_check_tasks], capture_output=True, text=True)
        task_out = proc.stdout.strip()
        self.assertIn("REQUEST_RUNNING_VIDEO", task_out)
        self.assertIn("QUALIFIED", task_out)

if __name__ == '__main__':
    unittest.main()
