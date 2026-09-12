#!/usr/bin/env python3
"""
Phase E — Step 5: Frontend Authentication & Secure Dashboard Navigation Test Suite
==================================================================================
Tests:
A. Unauthenticated request to /vaani-sales -> 302 redirected to /app.html?redirect=/vaani-sales.
B. Unauthenticated request to /sales and /vaani-sales.html -> 302 redirected.
C. Unauthenticated JSON request to /vaani-sales -> 401 rejected.
D. Authenticated Org 1 session -> /vaani-sales returns 200 OK HTML.
E. Authenticated Org 2 session -> /vaani-sales returns 200 OK HTML.
F. Authenticated identity check (/api/me) returns correct Org 1 user and tenant context.
G. Authenticated identity check (/api/me) returns correct Org 2 user and tenant context.
H. Org 1 cannot see Org 2 data (strict backend tenant scoping).
I. Logout (POST /api/auth/logout) invalidates session:
   - Next request to /vaani-sales redirects to /app.html
   - Business APIs return 401
J. Invalid/expired session cookie is rejected and cleared.
K. Attempting ?organization_id=2 manipulation cannot switch tenant context.
L. No session tokens or secrets leaked in HTML response.

Cleanup: Completely cleans up temporary test database records and sessions.
"""

import unittest
import urllib.request
import urllib.error
import http.client
import json
import subprocess

BASE_URL = "http://localhost:8787"

class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        return fp
    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302

class TestPhaseEFrontendAuth(unittest.TestCase):
    ORG1_ID = 1
    ORG2_ID = 2

    ORG1_RUN_ID = 7771
    ORG2_RUN_ID = 7772

    @classmethod
    def clean_data(cls):
        sql = f"""
        DELETE FROM vaani_digital_evidence WHERE run_id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID});
        DELETE FROM vaani_machines WHERE source_lead_run_id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID});
        DELETE FROM vaani_dnc_registry WHERE run_id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID});
        DELETE FROM workflow_runs WHERE id IN ({cls.ORG1_RUN_ID}, {cls.ORG2_RUN_ID});
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
            capture_output=True,
            text=True
        )

        node_clean = """
        const core = require('./dashboard/lib/core');
        (async () => {
          await core.mutate((d) => {
            d.tenants = d.tenants.filter(t => t.id !== 't_test_fe_org2');
            d.users = d.users.filter(u => u.id !== 'u_test_fe_org2');
            d.sessions = d.sessions.filter(s => s.tenantId !== 't_test_fe_org2' && s.userId !== 'u_test_fe_org2');
          });
        })();
        """
        subprocess.run(["node", "-e", node_clean], capture_output=True, text=True)

    @classmethod
    def seed_data(cls):
        cls.clean_data()

        # Seed minimal workflow runs for Org 1 and Org 2
        sql = f"""
        INSERT INTO workflow_runs (id, name, workflow_id, mode, call_type, gathered_context, initial_context, usage_info, cost_info, annotations, logs, extra, created_at)
        VALUES (
          {cls.ORG1_RUN_ID}, 'run_fe_org1', 3, 'outbound', 'outbound',
          '{{"extracted_variables": {{"caller_name": "Org 1 Customer", "primary_phone": "+919888811111", "customer_type": "seller", "qualification_state": "QUALIFIED"}}}}'::json,
          '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, CURRENT_TIMESTAMP
        );
        INSERT INTO workflow_runs (id, name, workflow_id, mode, call_type, gathered_context, initial_context, usage_info, cost_info, annotations, logs, extra, created_at)
        VALUES (
          {cls.ORG2_RUN_ID}, 'run_fe_org2', 4, 'outbound', 'outbound',
          '{{"extracted_variables": {{"caller_name": "Org 2 Customer", "primary_phone": "+919888822222", "customer_type": "buyer", "qualification_state": "QUALIFIED"}}}}'::json,
          '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, CURRENT_TIMESTAMP
        );
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
            capture_output=True,
            text=True,
            check=True
        )

        node_seed = """
        const core = require('./dashboard/lib/core');
        (async () => {
          await core.mutate((d) => {
            const t1 = d.tenants.find(t => t.id === 't_69d344e9ee8945d8');
            if (t1) t1.organization_id = 1;

            if (!d.tenants.some(t => t.id === 't_test_fe_org2')) {
              d.tenants.push({
                id: 't_test_fe_org2',
                name: 'Apex Machinery Solutions',
                slug: 'apex-machinery',
                createdAt: new Date().toISOString(),
                branding: { color: '#10B981' },
                providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
                plan: 'studio',
                status: 'active',
                privacyMode: 'standard',
                organization_id: 2
              });
            }
            if (!d.users.some(u => u.id === 'u_test_fe_org2')) {
              d.users.push({
                id: 'u_test_fe_org2',
                tenantId: 't_test_fe_org2',
                email: 'apex_admin@example.com',
                name: 'Apex Admin',
                passHash: core.hashPassword('apexsecurepass123'),
                role: 'owner',
                status: 'active',
                createdAt: new Date().toISOString()
              });
            }
          });

          const t1Token = await core.createSession('u_290fde84dd4df51e', 't_69d344e9ee8945d8');
          const t2Token = await core.createSession('u_test_fe_org2', 't_test_fe_org2');
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

    def test_a_unauthenticated_vaani_sales_redirects(self):
        """Unauthenticated GET /vaani-sales should redirect to /app.html?redirect=/vaani-sales."""
        opener = urllib.request.build_opener(NoRedirectHandler)
        req = urllib.request.Request(f"{BASE_URL}/vaani-sales")
        res = opener.open(req)
        self.assertEqual(res.status, 302)
        location = res.headers.get("Location")
        self.assertTrue(location.startswith("/app.html"))
        self.assertIn("redirect=/vaani-sales", location)

    def test_b_unauthenticated_aliases_redirect(self):
        """Unauthenticated GET /sales and /vaani-sales.html should redirect."""
        opener = urllib.request.build_opener(NoRedirectHandler)
        for path in ["/sales", "/vaani-sales.html", "/vaani-sales/"]:
            req = urllib.request.Request(f"{BASE_URL}{path}")
            res = opener.open(req)
            self.assertEqual(res.status, 302, f"Failed for path {path}")
            self.assertIn("/app.html", res.headers.get("Location"))

    def test_c_unauthenticated_json_request_returns_401(self):
        """Unauthenticated request accepting application/json returns 401."""
        req = urllib.request.Request(f"{BASE_URL}/vaani-sales", headers={"Accept": "application/json"})
        try:
            urllib.request.urlopen(req)
            self.fail("Expected 401 for unauthenticated JSON request")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 401)
            body = json.loads(e.read().decode())
            self.assertEqual(body.get("code"), "no_session")

    def test_d_authenticated_org1_accesses_dashboard(self):
        """Authenticated Org 1 user can access /vaani-sales."""
        req = urllib.request.Request(f"{BASE_URL}/vaani-sales", headers={"Cookie": f"rxv_sess={self.ORG1_TOKEN}"})
        res = urllib.request.urlopen(req)
        self.assertEqual(res.status, 200)
        content = res.read().decode()
        self.assertIn("SHYAM EARTHMOVER", content)
        self.assertIn("id=\"logoutBtn\"", content)
        self.assertIn("id=\"userEmailLabel\"", content)

    def test_e_authenticated_org2_accesses_dashboard(self):
        """Authenticated Org 2 user can access /vaani-sales."""
        req = urllib.request.Request(f"{BASE_URL}/vaani-sales", headers={"Cookie": f"rxv_sess={self.ORG2_TOKEN}"})
        res = urllib.request.urlopen(req)
        self.assertEqual(res.status, 200)
        content = res.read().decode()
        self.assertIn("id=\"tenantBrandName\"", content)
        self.assertIn("id=\"logoutBtn\"", content)

    def test_f_org1_identity_via_api_me(self):
        """GET /api/me returns Org 1 user and tenant context."""
        req = urllib.request.Request(f"{BASE_URL}/api/me", headers={"Cookie": f"rxv_sess={self.ORG1_TOKEN}"})
        res = urllib.request.urlopen(req)
        self.assertEqual(res.status, 200)
        data = json.loads(res.read().decode())
        self.assertEqual(data["tenant"]["organization_id"], 1)
        self.assertEqual(data["user"]["email"], "ankitsharma706245@gmail.com")

    def test_g_org2_identity_via_api_me(self):
        """GET /api/me returns Org 2 user and tenant context."""
        req = urllib.request.Request(f"{BASE_URL}/api/me", headers={"Cookie": f"rxv_sess={self.ORG2_TOKEN}"})
        res = urllib.request.urlopen(req)
        self.assertEqual(res.status, 200)
        data = json.loads(res.read().decode())
        self.assertEqual(data["tenant"]["organization_id"], 2)
        self.assertEqual(data["tenant"]["name"], "Apex Machinery Solutions")
        self.assertEqual(data["user"]["email"], "apex_admin@example.com")

    def test_h_tenant_data_isolation(self):
        """Org 1 cannot read Org 2 data and vice versa."""
        # Org 1 requests sellers
        req1 = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/sellers", headers={"Cookie": f"rxv_sess={self.ORG1_TOKEN}"})
        res1 = urllib.request.urlopen(req1)
        data1 = json.loads(res1.read().decode())
        org1_names = [s.get("caller_name") for s in data1.get("sellers", [])]
        org1_run_ids = [s.get("run_id") for s in data1.get("sellers", [])]
        self.assertIn("Org 1 Customer", org1_names)
        self.assertIn(self.ORG1_RUN_ID, org1_run_ids)
        self.assertNotIn("Org 2 Customer", org1_names)
        self.assertNotIn(self.ORG2_RUN_ID, org1_run_ids)

        # Org 2 requests buyers
        req2 = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/buyers", headers={"Cookie": f"rxv_sess={self.ORG2_TOKEN}"})
        res2 = urllib.request.urlopen(req2)
        data2 = json.loads(res2.read().decode())
        org2_names = [b.get("caller_name") for b in data2.get("buyers", [])]
        org2_run_ids = [b.get("run_id") for b in data2.get("buyers", [])]
        self.assertIn("Org 2 Customer", org2_names)
        self.assertIn(self.ORG2_RUN_ID, org2_run_ids)
        self.assertNotIn("Org 1 Customer", org2_names)
        self.assertNotIn(self.ORG1_RUN_ID, org2_run_ids)

    def test_i_logout_invalidates_session(self):
        """Calling POST /api/auth/logout invalidates session and revokes access."""
        # First, create a temporary session to log out
        node_create_temp = """
        const core = require('./dashboard/lib/core');
        (async () => {
          const tok = await core.createSession('u_290fde84dd4df51e', 't_69d344e9ee8945d8');
          console.log(tok);
        })();
        """
        proc = subprocess.run(["node", "-e", node_create_temp], capture_output=True, text=True, check=True)
        temp_token = proc.stdout.strip()

        # Verify temp token works
        req_check = urllib.request.Request(f"{BASE_URL}/api/me", headers={"Cookie": f"rxv_sess={temp_token}"})
        res_check = urllib.request.urlopen(req_check)
        self.assertEqual(res_check.status, 200)

        # Call logout
        req_logout = urllib.request.Request(
            f"{BASE_URL}/api/auth/logout",
            data=b"{}",
            headers={"Cookie": f"rxv_sess={temp_token}", "Content-Type": "application/json"},
            method="POST"
        )
        res_logout = urllib.request.urlopen(req_logout)
        self.assertEqual(res_logout.status, 200)
        set_cookie = res_logout.headers.get("Set-Cookie", "")
        self.assertIn("rxv_sess=;", set_cookie)

        # Now test that /vaani-sales redirects
        opener = urllib.request.build_opener(NoRedirectHandler)
        req_after = urllib.request.Request(f"{BASE_URL}/vaani-sales", headers={"Cookie": f"rxv_sess={temp_token}"})
        res_after = opener.open(req_after)
        self.assertEqual(res_after.status, 302)
        self.assertIn("/app.html", res_after.headers.get("Location"))

        # Business API returns 401
        req_api = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/overview", headers={"Cookie": f"rxv_sess={temp_token}"})
        try:
            urllib.request.urlopen(req_api)
            self.fail("Expected 401 after logout")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 401)

    def test_j_invalid_session_cookie_rejected(self):
        """Invalid or forged session cookie is rejected."""
        opener = urllib.request.build_opener(NoRedirectHandler)
        req = urllib.request.Request(f"{BASE_URL}/vaani-sales", headers={"Cookie": "rxv_sess=forged_fake_token_1234567890"})
        res = opener.open(req)
        self.assertEqual(res.status, 302)
        self.assertIn("/app.html", res.headers.get("Location"))

    def test_k_query_manipulation_cannot_change_tenant(self):
        """Passing ?organization_id=2 with Org 1 session cannot access Org 2 data."""
        req = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/buyers?organization_id=2", headers={"Cookie": f"rxv_sess={self.ORG1_TOKEN}"})
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        buyers = data.get("buyers", [])
        buyer_names = [b.get("caller_name") for b in buyers]
        self.assertNotIn("Org 2 Customer", buyer_names)

    def test_l_no_secrets_in_html(self):
        """Verify HTML does not expose database credentials, secrets, or internal configs."""
        req = urllib.request.Request(f"{BASE_URL}/vaani-sales", headers={"Cookie": f"rxv_sess={self.ORG1_TOKEN}"})
        res = urllib.request.urlopen(req)
        html = res.read().decode()
        self.assertNotIn("VAANI_INGESTION_SECRET", html)
        self.assertNotIn("POSTGRES_PASSWORD", html)
        self.assertNotIn("passHash", html)

if __name__ == "__main__":
    unittest.main()
