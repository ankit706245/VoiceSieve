import unittest
import urllib.request
import urllib.error
import json
import subprocess
import time

BASE_URL = "http://localhost:8787"

class TestPhase8AWhatsAppDemo(unittest.TestCase):
    ORG1_ID = 1
    ORG2_ID = 2

    # Store dynamic lead ID and phone
    LEAD_ID = None
    PHONE = None

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
        # Create test users
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

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'server_proc'):
            cls.server_proc.terminate()
            cls.server_proc.wait()

    def _req(self, path, token, payload=None, method="POST"):
        req = urllib.request.Request(f"{BASE_URL}{path}", method=method)
        req.add_header("Authorization", f"Bearer {token}")
        if payload is not None:
            req.add_header("Content-Type", "application/json")
            req.data = json.dumps(payload).encode("utf-8")
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode())

    def test_01_simulate_call(self):
        status, res = self._req("/api/vaani/sales/simulate-call", self.ORG1_TOKEN, {"scenario": "seller"})
        self.assertEqual(status, 201)
        self.assertTrue(res.get("success"))
        TestPhase8AWhatsAppDemo.LEAD_ID = res.get("lead_id")
        TestPhase8AWhatsAppDemo.PHONE = res.get("primary_phone")
        self.assertIsNotNone(TestPhase8AWhatsAppDemo.LEAD_ID)

    def test_02_demo_send_auth(self):
        status, res = self._req("/api/vaani/sales/whatsapp/demo-send", "INVALID", {"lead_id": TestPhase8AWhatsAppDemo.LEAD_ID})
        self.assertEqual(status, 401)

    def test_03_demo_send_success(self):
        payload = {
            "lead_id": TestPhase8AWhatsAppDemo.LEAD_ID,
            "phone_number": TestPhase8AWhatsAppDemo.PHONE,
            "evidence_types": ["BOOM_PHOTOS"]
        }
        status, res = self._req("/api/vaani/sales/whatsapp/demo-send", self.ORG1_TOKEN, payload)
        self.assertEqual(status, 200)
        self.assertTrue(res.get("success"))

        # Verify it shows up in timeline
        status2, res2 = self._req(f"/api/vaani/sales/leads/{TestPhase8AWhatsAppDemo.LEAD_ID}/whatsapp", self.ORG1_TOKEN, method="GET")
        self.assertEqual(status2, 200)
        msgs = res2.get("messages", [])
        self.assertGreater(len(msgs), 0)
        outbound = [m for m in msgs if m["direction"] == "OUTBOUND"]
        self.assertGreater(len(outbound), 0)

    def test_04_demo_reply_tenant_isolation(self):
        payload = {
            "lead_id": TestPhase8AWhatsAppDemo.LEAD_ID,
            "message_type": "TEXT",
            "text": "Hello"
        }
        status, res = self._req("/api/vaani/sales/whatsapp/demo-reply", self.ORG2_TOKEN, payload)
        self.assertEqual(status, 404)

    def test_05_demo_reply_success(self):
        payload = {
            "lead_id": TestPhase8AWhatsAppDemo.LEAD_ID,
            "message_type": "IMAGE",
            "media_url": "whatsapp://simulated/BOOM_PHOTOS/123",
            "mime_type": "image/jpeg",
            "filename": "boom.jpg",
            "raw_metadata": {"evidence_type": "BOOM_PHOTOS"}
        }
        status, res = self._req("/api/vaani/sales/whatsapp/demo-reply", self.ORG1_TOKEN, payload)
        self.assertEqual(status, 200)
        self.assertTrue(res.get("success"))

        # Check timeline again
        status2, res2 = self._req(f"/api/vaani/sales/leads/{TestPhase8AWhatsAppDemo.LEAD_ID}/whatsapp", self.ORG1_TOKEN, method="GET")
        self.assertEqual(status2, 200)
        msgs = res2.get("messages", [])
        inbound = [m for m in msgs if m["direction"] == "INBOUND"]
        self.assertGreater(len(inbound), 0)
        self.assertEqual(inbound[-1]["message_type"], "IMAGE")

    def test_06_demo_reply_text(self):
        payload = {
            "lead_id": TestPhase8AWhatsAppDemo.LEAD_ID,
            "message_type": "TEXT",
            "text": "Main bhej raha hu"
        }
        status, res = self._req("/api/vaani/sales/whatsapp/demo-reply", self.ORG1_TOKEN, payload)
        self.assertEqual(status, 200)

if __name__ == '__main__':
    unittest.main()
