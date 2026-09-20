import unittest
import urllib.request
import urllib.error
import json
import subprocess
import time

BASE_URL = "http://localhost:8787"

class TestPhaseGBuyerMatching(unittest.TestCase):
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

        # Clear specific machines and matches
        sql = """
        DELETE FROM vaani_buyer_machine_matches WHERE buyer_run_id IN (9000, 9001);
        DELETE FROM vaani_machines WHERE machine_id LIKE 'test_mach_%';
        """
        subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql])

        # Seed machines
        machines = [
            (1, 'test_mach_1', 'Tata Hitachi', 'EX 200 LC', 2020, 5000, 'soil_earthwork', 2500000, 'in_sourcing_pipeline'), # EXACT
            (1, 'test_mach_2', 'Tata Hitachi', 'EX 210 LC / Super', 2020, 5000, 'soil_earthwork', 2500000, 'in_sourcing_pipeline'), # ALT MODEL
            (1, 'test_mach_3', 'Tata Hitachi', 'EX 200 LC', 2021, 5000, 'soil_earthwork', 2700000, 'in_sourcing_pipeline'), # ALT BUDGET (+8%)
            (1, 'test_mach_4', 'Tata Hitachi', 'EX 200 LC', 2019, 5000, 'soil_earthwork', 2500000, 'in_sourcing_pipeline'), # ALT YEAR (-1)
            (1, 'test_mach_5', 'JCB', 'JS 205', 2020, 5000, 'soil_earthwork', 2500000, 'in_sourcing_pipeline'), # NO MATCH (Brand)
            (1, 'test_mach_6', 'Tata Hitachi', 'EX 200 LC', 2020, 5000, 'soil_earthwork', 3000000, 'in_sourcing_pipeline'), # NO MATCH (Budget)
            (1, 'test_mach_7', 'Tata Hitachi', 'EX 200 LC', 2018, 5000, 'soil_earthwork', 2500000, 'in_sourcing_pipeline'), # NO MATCH (Year)
            (1, 'test_mach_8', 'Tata Hitachi', 'EX 200 LC', 2020, 5000, 'soil_earthwork', 2500000, 'sold'), # NO MATCH (Status)
            (2, 'test_mach_9', 'Tata Hitachi', 'EX 200 LC', 2020, 5000, 'soil_earthwork', 2500000, 'in_sourcing_pipeline'), # NO MATCH (Tenant)
        ]
        insert_sql = "INSERT INTO vaani_machines (organization_id, machine_id, brand, model, manufacturing_year, hour_meter_reading, application_history, target_resale_inr, status) VALUES "
        vals = []
        for m in machines:
            vals.append(f"({m[0]}, '{m[1]}', '{m[2]}', '{m[3]}', {m[4]}, {m[5]}, '{m[6]}', {m[7]}, '{m[8]}')")
        subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", insert_sql + ", ".join(vals) + ";"])

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'server_proc'):
            cls.server_proc.terminate()
            cls.server_proc.wait()

        sql = """
        DELETE FROM vaani_buyer_machine_matches WHERE buyer_run_id IN (9000, 9001);
        DELETE FROM vaani_machines WHERE machine_id LIKE 'test_mach_%';
        """
        subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql])

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

    def test_01_exact_match(self):
        status, data = self.api_post('/api/vaani/buyers/9000/matches', {
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC",
            "model_year_min": 2020,
            "model_year_max": 2020,
            "buyer_budget_max_inr": 2500000,
            "running_hours_max": 6000,
            "application_history": "soil_earthwork"
        }, self.ORG1_TOKEN)
        if status != 200:
            print("test_01 Error:", data)
        self.assertEqual(status, 200)
        exact = [m for m in data if m['match_type'] == 'EXACT_MATCH']
        self.assertTrue(len(exact) >= 1)
        self.assertEqual(exact[0]['machine_id'], 'test_mach_1')

    def test_02_alternative_model(self):
        status, data = self.api_post('/api/vaani/buyers/9000/matches', {
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC",
            "buyer_budget_max_inr": 2500000
        }, self.ORG1_TOKEN)
        if status != 200:
            print("test_02 Error:", data)
        self.assertEqual(status, 200)
        alt = [m for m in data if m['machine_id'] == 'test_mach_2']
        self.assertTrue(len(alt) >= 1)
        self.assertEqual(alt[0]['match_type'], 'ALTERNATIVE_MATCH')
        self.assertEqual(alt[0]['evidence']['model'], 'brand matched, alternative model')

    def test_03_alternative_budget(self):
        status, data = self.api_post('/api/vaani/buyers/9000/matches', {
            "machine_brand": "Tata Hitachi",
            "machine_model": "EX 200 LC",
            "buyer_budget_max_inr": 2500000
        }, self.ORG1_TOKEN)
        if status != 200:
            print("test_03 Error:", data)
        self.assertEqual(status, 200)
        alt = [m for m in data if m['machine_id'] == 'test_mach_3']
        self.assertTrue(len(alt) >= 1)
        self.assertEqual(alt[0]['match_type'], 'ALTERNATIVE_MATCH')
        self.assertEqual(alt[0]['evidence']['budget'], 'price within 10% alternative budget')

    def test_04_tenant_isolation(self):
        status, data = self.api_post('/api/vaani/buyers/9000/matches', {
            "machine_brand": "Tata Hitachi",
            "buyer_budget_max_inr": 2500000
        }, self.ORG1_TOKEN)
        if status != 200:
            print("test_04 Error:", data)
        self.assertEqual(status, 200)
        machines = [m['machine_id'] for m in data]
        self.assertNotIn('test_mach_9', machines)

if __name__ == '__main__':
    unittest.main()
