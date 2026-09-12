#!/usr/bin/env python3
"""
Phase E Step 2 — Database Multi-Tenant Security & Isolation Verification Suite
=============================================================================
Verifies:
1. Existing records remain intact and mapped to verified organization_id.
2. vaani_excavator_sales_leads view exposes organization_id.
3. DNC registry is multi-tenant scoped (same phone can exist in Org 1 & Org 2).
4. Machine inventory is strictly tenant-scoped.
5. Digital evidence tracking is strictly tenant-scoped.
6. Queries filtering by organization_id provide complete isolation.
7. Strict NOT NULL on organization_id with NO silent default fallback.
8. Unmapped call ingestion cannot silently become organization 1.
9. Automated database cleanup on setup and teardown.
"""

import unittest
import subprocess
import json
import urllib.request
import urllib.error
import os

TEST_PHONE = "+919999900088"
TEST_MACH_1 = "mach_test_iso_org1"
TEST_MACH_2 = "mach_test_iso_org2"
TEST_EV_1 = "ev_test_iso_org1"
TEST_EV_2 = "ev_test_iso_org2"
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

class TestDatabaseTenantIsolation(unittest.TestCase):

    @classmethod
    def query_psql(cls, sql):
        proc = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A"],
            input=sql,
            text=True,
            capture_output=True
        )
        if proc.returncode != 0:
            raise RuntimeError(f"psql failed: {proc.stderr}")
        raw = proc.stdout.strip()
        if not raw:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return raw

    @classmethod
    def clean_test_data(cls):
        sql = f"""
        DELETE FROM vaani_digital_evidence WHERE evidence_id IN ('{TEST_EV_1}', '{TEST_EV_2}');
        DELETE FROM vaani_machines WHERE machine_id IN ('{TEST_MACH_1}', '{TEST_MACH_2}');
        DELETE FROM vaani_dnc_registry WHERE phone_number = '{TEST_PHONE}';
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
            capture_output=True,
            text=True
        )

    @classmethod
    def setUpClass(cls):
        cls.clean_test_data()

    @classmethod
    def tearDownClass(cls):
        cls.clean_test_data()

    def test_01_existing_records_intact(self):
        """Verifies existing workflow_runs and receptionist leads remain intact."""
        sql = """
        SELECT json_build_object(
            'sales_runs', (SELECT count(*) FROM workflow_runs WHERE workflow_id = 3),
            'receptionist_runs', (SELECT count(*) FROM workflow_runs WHERE workflow_id = 1),
            'org1_exists', EXISTS(SELECT 1 FROM organizations WHERE id = 1),
            'org2_exists', EXISTS(SELECT 1 FROM organizations WHERE id = 2)
        );
        """
        data = self.query_psql(sql)
        self.assertGreaterEqual(data["sales_runs"], 28, "Existing 28 sales runs must remain intact")
        self.assertGreaterEqual(data["receptionist_runs"], 4, "Existing receptionist runs must remain intact")
        self.assertTrue(data["org1_exists"], "Organization 1 must exist")
        self.assertTrue(data["org2_exists"], "Organization 2 must exist")

    def test_02_view_exposes_organization_id(self):
        """Verifies vaani_excavator_sales_leads exposes organization_id."""
        sql = """
        SELECT json_build_object(
            'has_column', EXISTS(
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'vaani_excavator_sales_leads' AND column_name = 'organization_id'
            ),
            'sample_org_id', (SELECT organization_id FROM vaani_excavator_sales_leads LIMIT 1)
        );
        """
        data = self.query_psql(sql)
        self.assertTrue(data["has_column"], "View must expose organization_id")
        self.assertEqual(data["sample_org_id"], 1, "Default existing runs must map to organization_id 1")

    def test_03_dnc_records_tenant_scoped(self):
        """Verifies same phone number can be DNC in Org 1 and Org 2 with distinct reasons."""
        insert_sql = f"""
        INSERT INTO vaani_dnc_registry (organization_id, phone_number, reason, is_active)
        VALUES 
            (1, '{TEST_PHONE}', 'Opted out from Tenant A marketing', true),
            (2, '{TEST_PHONE}', 'Wrong number for Tenant B', true);
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", insert_sql],
            check=True, capture_output=True
        )

        query_sql = f"""
        SELECT json_build_object(
            'org1', (SELECT reason FROM vaani_dnc_registry WHERE organization_id = 1 AND phone_number = '{TEST_PHONE}'),
            'org2', (SELECT reason FROM vaani_dnc_registry WHERE organization_id = 2 AND phone_number = '{TEST_PHONE}')
        );
        """
        res = self.query_psql(query_sql)
        self.assertEqual(res["org1"], "Opted out from Tenant A marketing")
        self.assertEqual(res["org2"], "Wrong number for Tenant B")

    def test_04_machine_records_tenant_scoped(self):
        """Verifies machines are strictly partitioned by organization_id."""
        insert_sql = f"""
        INSERT INTO vaani_machines (organization_id, machine_id, brand, model, status)
        VALUES 
            (1, '{TEST_MACH_1}', 'Tata Hitachi', 'EX 200 LC', 'certified_ready_in_yard'),
            (2, '{TEST_MACH_2}', 'Komatsu', 'PC 210', 'in_sourcing_pipeline');
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", insert_sql],
            check=True, capture_output=True
        )

        query_sql = f"""
        SELECT json_build_object(
            'org1_machines', (SELECT json_agg(machine_id) FROM vaani_machines WHERE organization_id = 1 AND machine_id IN ('{TEST_MACH_1}', '{TEST_MACH_2}')),
            'org2_machines', (SELECT json_agg(machine_id) FROM vaani_machines WHERE organization_id = 2 AND machine_id IN ('{TEST_MACH_1}', '{TEST_MACH_2}'))
        );
        """
        res = self.query_psql(query_sql)
        self.assertEqual(res["org1_machines"], [TEST_MACH_1])
        self.assertEqual(res["org2_machines"], [TEST_MACH_2])

    def test_05_evidence_records_tenant_scoped(self):
        """Verifies digital evidence is strictly partitioned by organization_id."""
        insert_sql = f"""
        INSERT INTO vaani_digital_evidence (organization_id, evidence_id, machine_id, media_type, media_url)
        VALUES 
            (1, '{TEST_EV_1}', '{TEST_MACH_1}', 'photo_exterior', 'https://org1.example/ext.jpg'),
            (2, '{TEST_EV_2}', '{TEST_MACH_2}', 'photo_boom', 'https://org2.example/boom.jpg');
        """
        subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", insert_sql],
            check=True, capture_output=True
        )

        query_sql = f"""
        SELECT json_build_object(
            'org1_evidence', (SELECT json_agg(evidence_id) FROM vaani_digital_evidence WHERE organization_id = 1 AND evidence_id IN ('{TEST_EV_1}', '{TEST_EV_2}')),
            'org2_evidence', (SELECT json_agg(evidence_id) FROM vaani_digital_evidence WHERE organization_id = 2 AND evidence_id IN ('{TEST_EV_1}', '{TEST_EV_2}'))
        );
        """
        res = self.query_psql(query_sql)
        self.assertEqual(res["org1_evidence"], [TEST_EV_1])
        self.assertEqual(res["org2_evidence"], [TEST_EV_2])

    def test_06_tenant_isolation_query(self):
        """Verifies organization_id filtering completely segregates tenant views."""
        sql = """
        SELECT json_build_object(
            'org1_lead_count', (SELECT count(*) FROM vaani_excavator_sales_leads WHERE organization_id = 1),
            'org2_lead_count', (SELECT count(*) FROM vaani_excavator_sales_leads WHERE organization_id = 2)
        );
        """
        res = self.query_psql(sql)
        self.assertEqual(res["org1_lead_count"], 28, "Org 1 has all 28 existing leads")
        self.assertEqual(res["org2_lead_count"], 0, "Org 2 has 0 leads (zero leak from Org 1)")

    def test_07_organization_id_required_no_silent_default(self):
        """Verifies that inserting records without organization_id is rejected by PostgreSQL NOT NULL."""
        # 1. vaani_machines
        proc_mach = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c",
             "INSERT INTO vaani_machines (machine_id, brand, model) VALUES ('mach_null_test', 'Tata', 'EX200');"],
            capture_output=True, text=True
        )
        self.assertNotEqual(proc_mach.returncode, 0)
        self.assertIn("violates not-null constraint", proc_mach.stderr)
        self.assertIn("organization_id", proc_mach.stderr)

        # 2. vaani_digital_evidence
        proc_ev = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c",
             "INSERT INTO vaani_digital_evidence (evidence_id, media_url) VALUES ('ev_null_test', 'https://test/x.jpg');"],
            capture_output=True, text=True
        )
        self.assertNotEqual(proc_ev.returncode, 0)
        self.assertIn("violates not-null constraint", proc_ev.stderr)
        self.assertIn("organization_id", proc_ev.stderr)

        # 3. vaani_dnc_registry
        proc_dnc = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c",
             "INSERT INTO vaani_dnc_registry (phone_number, reason) VALUES ('+919999900011', 'test opt out');"],
            capture_output=True, text=True
        )
        self.assertNotEqual(proc_dnc.returncode, 0)
        self.assertIn("violates not-null constraint", proc_dnc.stderr)
        self.assertIn("organization_id", proc_dnc.stderr)

        # 4. Verify no column defaults exist in information_schema
        check_defaults_sql = """
        SELECT json_agg(t) FROM (
            SELECT table_name, column_name, column_default 
            FROM information_schema.columns 
            WHERE table_name IN ('vaani_machines', 'vaani_digital_evidence', 'vaani_dnc_registry') 
              AND column_name = 'organization_id'
        ) t;
        """
        cols = self.query_psql(check_defaults_sql)
        for col in cols:
            self.assertIsNone(col["column_default"], f"{col['table_name']}.organization_id must not have a default")

    def test_08_unmapped_call_fails_cleanly(self):
        """Verifies ingestion of an unmapped workflow without org_id fails with 400 instead of defaulting to Org 1."""
        unmapped_payload = {
            "lead_id": "test_lead_unmapped_99999",
            "customer_name": "Unmapped Caller",
            "primary_phone": "+919999900022",
            "customer_type": "seller",
            "call_metadata": {
                "run_id": 99999,
                "workflow_id": 99999  # Non-existent workflow in database
            }
        }
        req = urllib.request.Request(
            f"{BASE_URL}/api/v1/vaani/calls/complete",
            data=json.dumps(unmapped_payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {get_ingestion_secret()}"
            }
        )
        try:
            with urllib.request.urlopen(req) as resp:
                self.fail("Expected unmapped ingestion to fail with 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
            body = json.loads(e.read().decode("utf-8"))
            self.assertEqual(body.get("code"), "missing_organization_id")

if __name__ == "__main__":
    unittest.main(verbosity=2)
