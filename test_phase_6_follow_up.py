import unittest
import urllib.request
import urllib.error
import json
import subprocess
import time

BASE_URL = "http://localhost:8787"

class TestPhase6FollowUp(unittest.TestCase):
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

        # Clear tasks
        sql = "DELETE FROM vaani_follow_up_tasks WHERE source_call_id IN (99991, 99992, 99995, 99998, 99999);"
        subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql])

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'server_proc'):
            cls.server_proc.terminate()
            cls.server_proc.wait()
        sql = "DELETE FROM vaani_follow_up_tasks WHERE source_call_id IN (99991, 99992, 99995, 99998, 99999);"
        subprocess.run(["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql])

    def api_get(self, path, token=None):
        headers = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{BASE_URL}{path}", headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

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

    def test_01_create_follow_up_via_node(self):
        # We invoke the function directly via node script because the webhook endpoint might not directly take this payload
        node_script = """
        const vaaniTasks = require('./dashboard/lib/vaani-tasks');
        (async () => {
            const context = {
                organization_id: 1, run_id: 99991, lead_id: 'lead_99991', customer_id: '1234567890',
                customer_type: 'seller', qual_state: 'QUALIFIED', lead_temp: 'HOT',
                mach_details: { brand: 'JCB', model: 'JS 205' },
                ev_readiness: { photos_agreed: false, running_video_agreed: true, rc_copy_agreed: true }
            };
            const tasks = await vaaniTasks.processCallFollowUpTasks(context);
            console.log(JSON.stringify(tasks));
        })().catch(e => { console.error(e); process.exit(1); });
        """
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0)
        tasks = json.loads(proc.stdout.strip())
        self.assertTrue(len(tasks) > 0)
        self.assertEqual(tasks[0]['task_type'], 'REQUEST_PHOTOS')
        self.assertEqual(tasks[0]['priority'], 'HIGH')

    def test_02_no_follow_up_disqualified(self):
        node_script = """
        const vaaniTasks = require('./dashboard/lib/vaani-tasks');
        (async () => {
            const context = {
                organization_id: 1, run_id: 99992, lead_id: 'lead_99992',
                customer_type: 'seller', qual_state: 'DISQUALIFIED', lead_temp: 'COLD'
            };
            const tasks = await vaaniTasks.processCallFollowUpTasks(context);
            console.log(JSON.stringify(tasks));
        })();
        """
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        tasks = json.loads(proc.stdout.strip())
        self.assertEqual(len(tasks), 0)

    def test_08_duplicate_processing_idempotency(self):
        node_script = """
        const vaaniTasks = require('./dashboard/lib/vaani-tasks');
        (async () => {
            const context = {
                organization_id: 1, run_id: 99998, lead_id: 'lead_99998',
                customer_type: 'buyer', qual_state: 'QUALIFIED', lead_temp: 'HOT',
                comm_terms: { yard_visit_agreed: true }
            };
            const tasks1 = await vaaniTasks.processCallFollowUpTasks(context);
            const tasks2 = await vaaniTasks.processCallFollowUpTasks(context);
            console.log(JSON.stringify({ t1: tasks1.length, t2: tasks2.length }));
        })();
        """
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        res = json.loads(proc.stdout.strip())
        self.assertTrue(res['t1'] > 0)
        self.assertEqual(res['t2'], 0) # No duplicates created

    def test_09_complete_task(self):
        # First ensure task exists
        node_script = """
        const vaaniTasks = require('./dashboard/lib/vaani-tasks');
        (async () => {
            const context = { organization_id: 1, run_id: 99999, lead_id: 'lead_99999', customer_type: 'seller', qual_state: 'QUALIFIED', lead_temp: 'HOT', ev_readiness: { photos_agreed: false } };
            const tasks = await vaaniTasks.processCallFollowUpTasks(context);
            console.log(tasks[0].task_id);
        })();
        """
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        task_id = proc.stdout.strip()

        status, data = self.api_post('/api/vaani/sales/tasks/transition', {
            "task_id": task_id,
            "status": "COMPLETED",
            "notes": "Done"
        }, self.ORG1_TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(data['task']['status'], 'COMPLETED')

    def test_13_invalid_transition(self):
        status, data = self.api_post('/api/vaani/sales/tasks/transition', {
            "task_id": "nonexistent",
            "status": "PENDING"
        }, self.ORG1_TOKEN)
        self.assertEqual(status, 404)

    def test_15_tenant_isolation(self):
        node_script = """
        const vaaniTasks = require('./dashboard/lib/vaani-tasks');
        (async () => {
            const context = { organization_id: 2, run_id: 99995, lead_id: 'lead_99995', customer_type: 'seller', qual_state: 'QUALIFIED', lead_temp: 'HOT', ev_readiness: { photos_agreed: false } };
            const tasks = await vaaniTasks.processCallFollowUpTasks(context);
            console.log(tasks[0].task_id);
        })();
        """
        proc = subprocess.run(["node", "-e", node_script], capture_output=True, text=True)
        task_id_org2 = proc.stdout.strip()

        # Org1 tries to complete Org2's task
        status, data = self.api_post('/api/vaani/sales/tasks/transition', {
            "task_id": task_id_org2,
            "status": "COMPLETED"
        }, self.ORG1_TOKEN)
        self.assertEqual(status, 404)

if __name__ == '__main__':
    unittest.main()
