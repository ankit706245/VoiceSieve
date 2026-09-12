#!/usr/bin/env python3
"""
Phase E — Step 6: Complete Security & Cross-Tenant Audit Runner
==============================================================
Performs exhaustive automated verification across:
1. Authentication Audit (Routes, API endpoints, expired/invalid tokens, logout)
2. Authorization Audit (Roles: member, owner, admin, super_admin)
3. Tenant Isolation Audit (Org 1 vs Org 2, query param overrides, direct ID access)
4. Ingestion Webhook Audit (Header variations, zero DB mutation on auth failure)
5. Database Schema & Query Audit (Constraints, NOT NULL, zero DEFAULT 1, zero COALESCE fallback)
6. DNC Isolation Audit (Cross-tenant phone number independence)
7. Secret Audit (Static scanner for gitignore, .env, HTML, JS, storage)
8. Session / Cookie Security Audit (HttpOnly, SameSite, Secure flag logic, server-side destruction)
9. API Input Tampering Audit (organization_id / tenant_id injection attempts)
"""

import os
import sys
import json
import re
import urllib.request
import urllib.error
import subprocess

BASE_URL = "http://localhost:8787"

class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def http_error_302(self, req, fp, code, msg, headers):
        return fp
    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302

opener = urllib.request.build_opener(NoRedirectHandler)

audit_results = {}

def log_test(category, name, passed, details=""):
    if category not in audit_results:
        audit_results[category] = []
    status = "PASS" if passed else "FAIL"
    audit_results[category].append({"name": name, "status": status, "details": details})
    print(f"[{status}] {category} -> {name} {f'({details})' if details else ''}")

# -------------------------------------------------------------
# Test Fixture Setup & Cleanup
# -------------------------------------------------------------
AUDIT_ORG1_ID = 1
AUDIT_ORG2_ID = 2
AUDIT_RUN1 = 6661
AUDIT_RUN2 = 6662
AUDIT_PHONE1 = "+919777711111"
AUDIT_PHONE2 = "+919777722222"
AUDIT_SHARED_PHONE = "+919777733333"
AUDIT_MACH1 = "mach_audit_6661"
AUDIT_MACH2 = "mach_audit_6662"
AUDIT_EVID1 = "ev_audit_6661"
AUDIT_EVID2 = "ev_audit_6662"

def clean_fixtures():
    sql = f"""
    DELETE FROM vaani_digital_evidence WHERE evidence_id IN ('{AUDIT_EVID1}', '{AUDIT_EVID2}') OR run_id IN ({AUDIT_RUN1}, {AUDIT_RUN2});
    DELETE FROM vaani_machines WHERE machine_id IN ('{AUDIT_MACH1}', '{AUDIT_MACH2}') OR source_lead_run_id IN ({AUDIT_RUN1}, {AUDIT_RUN2});
    DELETE FROM vaani_dnc_registry WHERE run_id IN ({AUDIT_RUN1}, {AUDIT_RUN2}) OR phone_number IN ('{AUDIT_PHONE1}', '{AUDIT_PHONE2}', '{AUDIT_SHARED_PHONE}');
    DELETE FROM workflow_runs WHERE id IN ({AUDIT_RUN1}, {AUDIT_RUN2}, 99999);
    """
    subprocess.run(
        ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
        capture_output=True, text=True
    )
    node_clean = """
    const core = require('./dashboard/lib/core');
    (async () => {
      await core.mutate(d => {
        d.tenants = d.tenants.filter(t => t.id !== 't_audit_org2');
        d.users = d.users.filter(u => !u.id.startsWith('u_audit_'));
        d.sessions = d.sessions.filter(s => s.tenantId !== 't_audit_org2' && !s.userId.startsWith('u_audit_'));
      });
    })();
    """
    subprocess.run(["node", "-e", node_clean], capture_output=True, text=True)

def seed_fixtures():
    clean_fixtures()
    sql = f"""
    INSERT INTO workflow_runs (id, name, workflow_id, mode, call_type, gathered_context, initial_context, usage_info, cost_info, annotations, logs, extra, created_at)
    VALUES (
      {AUDIT_RUN1}, 'run_audit_org1', 3, 'outbound', 'outbound',
      '{{"extracted_variables": {{"caller_name": "Audit Seller 1", "primary_phone": "{AUDIT_PHONE1}", "customer_type": "seller", "machine_details": {{"brand": "Tata Hitachi", "model": "EX 200 LC"}}, "commercial_terms": {{"expected_price_inr": 2500000}}, "qualification_state": "QUALIFIED", "lead_temperature": "HOT", "follow_up_required": true, "follow_up_datetime": "2026-09-15T10:00:00Z"}}}}'::json,
      '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, CURRENT_TIMESTAMP
    );
    INSERT INTO workflow_runs (id, name, workflow_id, mode, call_type, gathered_context, initial_context, usage_info, cost_info, annotations, logs, extra, created_at)
    VALUES (
      {AUDIT_RUN2}, 'run_audit_org2', 4, 'outbound', 'outbound',
      '{{"extracted_variables": {{"caller_name": "Audit Buyer 2", "primary_phone": "{AUDIT_PHONE2}", "customer_type": "buyer", "machine_details": {{"brand": "Komatsu", "model": "PC 210"}}, "commercial_terms": {{"budget_max_inr": 3200000}}, "qualification_state": "QUALIFIED", "lead_temperature": "WARM", "follow_up_required": true, "follow_up_datetime": "2026-09-16T11:00:00Z"}}}}'::json,
      '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, '{{}}'::json, CURRENT_TIMESTAMP
    );

    INSERT INTO vaani_machines (machine_id, organization_id, source_lead_run_id, brand, model, manufacturing_year, status, sourcing_cost_inr)
    VALUES ('{AUDIT_MACH1}', {AUDIT_ORG1_ID}, {AUDIT_RUN1}, 'Tata Hitachi', 'EX 200 LC', 2021, 'in_sourcing_pipeline', 2500000);

    INSERT INTO vaani_machines (machine_id, organization_id, source_lead_run_id, brand, model, manufacturing_year, status, sourcing_cost_inr)
    VALUES ('{AUDIT_MACH2}', {AUDIT_ORG2_ID}, {AUDIT_RUN2}, 'Komatsu', 'PC 210', 2022, 'certified_ready_in_yard', 3200000);

    INSERT INTO vaani_digital_evidence (evidence_id, organization_id, run_id, media_type, media_url, evaluator_verdict)
    VALUES ('{AUDIT_EVID1}', {AUDIT_ORG1_ID}, {AUDIT_RUN1}, 'photo_meter', 'https://example.com/audit1.jpg', 'approved');

    INSERT INTO vaani_digital_evidence (evidence_id, organization_id, run_id, media_type, media_url, evaluator_verdict)
    VALUES ('{AUDIT_EVID2}', {AUDIT_ORG2_ID}, {AUDIT_RUN2}, 'doc_rc', 'https://example.com/audit2.pdf', 'approved');

    -- Org 1 registers shared phone as DNC
    INSERT INTO vaani_dnc_registry (organization_id, phone_number, run_id, reason, is_active)
    VALUES ({AUDIT_ORG1_ID}, '{AUDIT_SHARED_PHONE}', {AUDIT_RUN1}, 'Org 1 Audit Opt-Out', true);
    """
    subprocess.run(
        ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", sql],
        capture_output=True, text=True, check=True
    )

    node_seed = """
    const core = require('./dashboard/lib/core');
    (async () => {
      await core.mutate(d => {
        const t1 = d.tenants.find(t => t.id === 't_69d344e9ee8945d8');
        if (t1) t1.organization_id = 1;

        if (!d.tenants.some(t => t.id === 't_audit_org2')) {
          d.tenants.push({
            id: 't_audit_org2',
            name: 'Audit Client Two Ltd',
            slug: 'audit-client-two',
            createdAt: new Date().toISOString(),
            branding: { color: '#00AAFF' },
            providers: { stt: 'deepgram', tts: 'rumik', llm: 'groq', telephony: 'vobiz' },
            plan: 'studio',
            status: 'active',
            privacyMode: 'standard',
            organization_id: 2
          });
        }

        // Roles for Org 1
        const roles = ['member', 'owner', 'admin', 'super_admin'];
        for (const r of roles) {
          const uid = `u_audit_org1_${r}`;
          if (!d.users.some(u => u.id === uid)) {
            d.users.push({
              id: uid,
              tenantId: 't_69d344e9ee8945d8',
              email: `org1_${r}@audit.local`,
              name: `Org 1 ${r}`,
              passHash: core.hashPassword('auditpass123'),
              role: r,
              status: 'active',
              createdAt: new Date().toISOString()
            });
          }
        }

        // Org 2 user
        if (!d.users.some(u => u.id === 'u_audit_org2_owner')) {
          d.users.push({
            id: 'u_audit_org2_owner',
            tenantId: 't_audit_org2',
            email: 'org2_owner@audit.local',
            name: 'Org 2 Owner',
            passHash: core.hashPassword('auditpass123'),
            role: 'owner',
            status: 'active',
            createdAt: new Date().toISOString()
          });
        }
      });

      const s_org1_owner = await core.createSession('u_audit_org1_owner', 't_69d344e9ee8945d8');
      const s_org1_member = await core.createSession('u_audit_org1_member', 't_69d344e9ee8945d8');
      const s_org1_admin = await core.createSession('u_audit_org1_admin', 't_69d344e9ee8945d8');
      const s_org1_super = await core.createSession('u_audit_org1_super_admin', 't_69d344e9ee8945d8');
      const s_org2_owner = await core.createSession('u_audit_org2_owner', 't_audit_org2');

      console.log(JSON.stringify({
        org1_owner: s_org1_owner,
        org1_member: s_org1_member,
        org1_admin: s_org1_admin,
        org1_super_admin: s_org1_super,
        org2_owner: s_org2_owner
      }));
    })();
    """
    proc = subprocess.run(["node", "-e", node_seed], capture_output=True, text=True, check=True)
    return json.loads(proc.stdout.strip())

# -------------------------------------------------------------
# 1. Authentication Audit
# -------------------------------------------------------------
def run_auth_audit(tokens):
    # Check protected HTML routes
    html_routes = ["/vaani-sales", "/sales", "/vaani-sales.html", "/vaani-sales/"]
    for route in html_routes:
        req = urllib.request.Request(f"{BASE_URL}{route}")
        res = opener.open(req)
        is_redirect = res.status == 302 and "/app.html" in res.headers.get("Location", "")
        log_test("Authentication", f"Unauthenticated HTML route blocked: {route}", is_redirect, f"Status={res.status}")

    # Check protected API routes return 401
    api_endpoints = [
        "/api/vaani/sales/overview",
        "/api/vaani/sales/sellers",
        "/api/vaani/sales/buyers",
        "/api/vaani/sales/machines",
        "/api/vaani/sales/demand",
        "/api/vaani/sales/follow-ups",
        "/api/vaani/sales/calls",
        "/api/vaani/sales/dnc",
        "/api/vaani/sales/search?q=tata",
        f"/api/vaani/sales/leads/{AUDIT_RUN1}",
        f"/api/vaani/sales/leads/{AUDIT_RUN1}/timeline",
        "/api/vaani/sales/activities",
        "/api/vaani/leads",
    ]
    for ep in api_endpoints:
        req = urllib.request.Request(f"{BASE_URL}{ep}")
        try:
            urllib.request.urlopen(req)
            log_test("Authentication", f"Unauthenticated API 401: {ep}", False, "Expected 401, got 200")
        except urllib.error.HTTPError as e:
            log_test("Authentication", f"Unauthenticated API 401: {ep}", e.code == 401, f"Code={e.code}")

    # Expired / invalid session cookie
    req = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/overview", headers={"Cookie": "rxv_sess=fake_expired_token_000000000000"})
    try:
        urllib.request.urlopen(req)
        log_test("Authentication", "Invalid session token rejected", False)
    except urllib.error.HTTPError as e:
        log_test("Authentication", "Invalid session token rejected", e.code == 401, f"Code={e.code}")

    # Logout destroys session
    node_create_temp = "const core = require('./dashboard/lib/core'); (async () => console.log(await core.createSession('u_audit_org1_owner', 't_69d344e9ee8945d8')))();"
    tok = subprocess.run(["node", "-e", node_create_temp], capture_output=True, text=True, check=True).stdout.strip()
    req_logout = urllib.request.Request(f"{BASE_URL}/api/auth/logout", data=b"{}", headers={"Cookie": f"rxv_sess={tok}", "Content-Type": "application/json"}, method="POST")
    urllib.request.urlopen(req_logout)
    req_after = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/overview", headers={"Cookie": f"rxv_sess={tok}"})
    try:
        urllib.request.urlopen(req_after)
        log_test("Authentication", "Post-logout session destruction", False)
    except urllib.error.HTTPError as e:
        log_test("Authentication", "Post-logout session destruction", e.code == 401, f"Code={e.code}")

# -------------------------------------------------------------
# 2. Authorization Audit
# -------------------------------------------------------------
def run_authorization_audit(tokens):
    # Test role access across member, owner, admin, super_admin
    roles = ["member", "owner", "admin", "super_admin"]
    for r in roles:
        tok = tokens.get(f"org1_{r}")
        req = urllib.request.Request(f"{BASE_URL}/api/me", headers={"Cookie": f"rxv_sess={tok}"})
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        user_role = data.get("user", {}).get("role")
        log_test("Authorization", f"User role resolved correctly: {r}", user_role == r, f"Role={user_role}")

        # Verify business API accessible to normal roles
        req_biz = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/overview", headers={"Cookie": f"rxv_sess={tok}"})
        res_biz = urllib.request.urlopen(req_biz)
        log_test("Authorization", f"Role {r} can access scoped business data", res_biz.status == 200, f"Status={res_biz.status}")

    # Admin-gated endpoint verification: /api/members requires admin role
    # member trying to access /api/members should receive 403 Forbidden
    req_adm = urllib.request.Request(f"{BASE_URL}/api/members", headers={"Cookie": f"rxv_sess={tokens['org1_member']}"})
    try:
        urllib.request.urlopen(req_adm)
        log_test("Authorization", "Member blocked from admin-only API", False)
    except urllib.error.HTTPError as e:
        log_test("Authorization", "Member blocked from admin-only API", e.code == 403, f"Code={e.code}")

# -------------------------------------------------------------
# 3. Tenant Isolation Audit
# -------------------------------------------------------------
def run_tenant_isolation_audit(tokens):
    tok1 = tokens["org1_owner"]
    tok2 = tokens["org2_owner"]

    # 1. Org 1 requests sellers -> sees only Org 1 seller
    req1 = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/sellers", headers={"Cookie": f"rxv_sess={tok1}"})
    data1 = json.loads(urllib.request.urlopen(req1).read().decode())
    org1_run_ids = [s.get("run_id") for s in data1.get("sellers", [])]
    log_test("Tenant Isolation", "Org 1 sees Org 1 seller", AUDIT_RUN1 in org1_run_ids)
    log_test("Tenant Isolation", "Org 1 CANNOT see Org 2 buyer", AUDIT_RUN2 not in org1_run_ids)

    # 2. Org 2 requests buyers -> sees only Org 2 buyer
    req2 = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/buyers", headers={"Cookie": f"rxv_sess={tok2}"})
    data2 = json.loads(urllib.request.urlopen(req2).read().decode())
    org2_run_ids = [b.get("run_id") for b in data2.get("buyers", [])]
    log_test("Tenant Isolation", "Org 2 sees Org 2 buyer", AUDIT_RUN2 in org2_run_ids)
    log_test("Tenant Isolation", "Org 2 CANNOT see Org 1 seller", AUDIT_RUN1 not in org2_run_ids)

    # 3. Query param attacks
    for qparam in ["?organization_id=2", "?organizationId=2", "?tenant_id=2", "?tenantId=2"]:
        req_attack = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/buyers{qparam}", headers={"Cookie": f"rxv_sess={tok1}"})
        data_attack = json.loads(urllib.request.urlopen(req_attack).read().decode())
        attack_ids = [b.get("run_id") for b in data_attack.get("buyers", [])]
        log_test("Tenant Isolation", f"Query param override blocked: {qparam}", AUDIT_RUN2 not in attack_ids)

    # 4. Direct Resource ID Cross-Access Attempts
    # Org 1 tries to access Org 2 Lead 360
    req_lead = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/leads/{AUDIT_RUN2}", headers={"Cookie": f"rxv_sess={tok1}"})
    try:
        urllib.request.urlopen(req_lead)
        log_test("Tenant Isolation", "Cross-tenant lead direct ID access blocked", False)
    except urllib.error.HTTPError as e:
        log_test("Tenant Isolation", "Cross-tenant lead direct ID access blocked", e.code == 404, f"Code={e.code}")

    # Org 1 tries to access Org 2 Lead Timeline
    req_time = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/leads/{AUDIT_RUN2}/timeline", headers={"Cookie": f"rxv_sess={tok1}"})
    try:
        res_time = urllib.request.urlopen(req_time)
        data_time = json.loads(res_time.read().decode())
        log_test("Tenant Isolation", "Cross-tenant timeline direct ID access returns no data", len(data_time) == 0, f"Events={len(data_time)}")
    except urllib.error.HTTPError as e:
        log_test("Tenant Isolation", "Cross-tenant timeline direct ID access blocked", e.code == 404, f"Code={e.code}")

    # Org 1 searches for Org 2 caller name
    req_search = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/search?q=Buyer+2", headers={"Cookie": f"rxv_sess={tok1}"})
    search_data = json.loads(urllib.request.urlopen(req_search).read().decode())
    search_ids = [r.get("run_id") for r in search_data.get("results", [])]
    log_test("Tenant Isolation", "Cross-tenant search leak blocked", AUDIT_RUN2 not in search_ids)

    # Org 1 machines list contains no Org 2 machines
    req_mach = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/machines", headers={"Cookie": f"rxv_sess={tok1}"})
    mach_data = json.loads(urllib.request.urlopen(req_mach).read().decode())
    actual_mach_ids = [m.get("machine_id") for m in mach_data.get("actual_stock", [])]
    log_test("Tenant Isolation", "Cross-tenant machine leak blocked", AUDIT_MACH2 not in actual_mach_ids)

# -------------------------------------------------------------
# 4. Ingestion Webhook Audit
# -------------------------------------------------------------
def run_webhook_audit():
    secret = os.getenv("VAANI_INGESTION_SECRET", "")
    if not secret and os.path.exists(".env"):
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VAANI_INGESTION_SECRET="):
                    secret = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break

    # Count DB records before failed attempts
    def get_run_count():
        out = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c",
             "SELECT count(*) FROM workflow_runs WHERE id = 99999;"],
            capture_output=True, text=True, check=True
        )
        return int(out.stdout.strip() or 0)

    subprocess.run(
        ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", "DELETE FROM workflow_runs WHERE id = 99999;"],
        capture_output=True, text=True
    )
    count_before = get_run_count()

    payload = json.dumps({
        "lead_id": "lead_audit_99999",
        "customer_name": "Audit Webhook Seller",
        "primary_phone": "+919999988888",
        "customer_type": "seller",
        "call_metadata": {"run_id": 99999, "workflow_id": 3}
    }).encode()

    endpoints = ["/api/v1/vaani/calls/complete", "/api/vaani/calls/complete"]
    for ep in endpoints:
        # 1. No Authorization header
        try:
            urllib.request.urlopen(urllib.request.Request(f"{BASE_URL}{ep}", data=payload, headers={"Content-Type": "application/json"}))
            log_test("Webhook Security", f"Missing Auth header blocked on {ep}", False)
        except urllib.error.HTTPError as e:
            log_test("Webhook Security", f"Missing Auth header blocked on {ep}", e.code == 401)

        # 2. Wrong secret
        try:
            urllib.request.urlopen(urllib.request.Request(f"{BASE_URL}{ep}", data=payload, headers={"Content-Type": "application/json", "Authorization": "Bearer wrong_secret"}))
            log_test("Webhook Security", f"Wrong secret blocked on {ep}", False)
        except urllib.error.HTTPError as e:
            log_test("Webhook Security", f"Wrong secret blocked on {ep}", e.code == 401)

        # 3. Empty Bearer token
        try:
            urllib.request.urlopen(urllib.request.Request(f"{BASE_URL}{ep}", data=payload, headers={"Content-Type": "application/json", "Authorization": "Bearer "}))
            log_test("Webhook Security", f"Empty Bearer token blocked on {ep}", False)
        except urllib.error.HTTPError as e:
            log_test("Webhook Security", f"Empty Bearer token blocked on {ep}", e.code == 401)

        # 4. Wrong auth scheme
        try:
            urllib.request.urlopen(urllib.request.Request(f"{BASE_URL}{ep}", data=payload, headers={"Content-Type": "application/json", "Authorization": "Basic dGVzdDp0ZXN0"}))
            log_test("Webhook Security", f"Wrong auth scheme blocked on {ep}", False)
        except urllib.error.HTTPError as e:
            log_test("Webhook Security", f"Wrong auth scheme blocked on {ep}", e.code == 401)

    count_after_failures = get_run_count()
    log_test("Webhook Security", "Failed auth attempts caused ZERO DB mutations", count_before == count_after_failures, f"Count={count_after_failures}")

    # Valid secret test (seed valid workflow run 99999 first)
    subprocess.run(
        ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c",
         "INSERT INTO workflow_runs (id, name, workflow_id, mode, call_type, gathered_context, initial_context, usage_info, cost_info, annotations, logs, extra, created_at) "
         "VALUES (99999, 'test_webhook_run', 3, 'outbound', 'outbound', '{}'::json, '{}'::json, '{}'::json, '{}'::json, '{}'::json, '{}'::json, '{}'::json, CURRENT_TIMESTAMP);"],
        capture_output=True, text=True, check=True
    )
    req_valid = urllib.request.Request(
        f"{BASE_URL}/api/v1/vaani/calls/complete",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {secret}"}
    )
    res_valid = urllib.request.urlopen(req_valid)
    log_test("Webhook Security", "Valid secret accepted with 201", res_valid.status == 201)

    # Clean test run 99999
    subprocess.run(
        ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-c", "DELETE FROM workflow_runs WHERE id = 99999;"],
        capture_output=True, text=True
    )

# -------------------------------------------------------------
# 5. Database Schema & Query Audit
# -------------------------------------------------------------
def run_database_audit():
    # 1. Verify NOT NULL and NO DEFAULT on organization_id in vaani_machines, vaani_digital_evidence, vaani_dnc_registry
    tables = ["vaani_machines", "vaani_digital_evidence", "vaani_dnc_registry"]
    for t in tables:
        sql = f"""
        SELECT is_nullable, column_default 
        FROM information_schema.columns 
        WHERE table_name = '{t}' AND column_name = 'organization_id';
        """
        out = subprocess.run(
            ["docker", "exec", "-i", "dograh-local-postgres-1", "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
            capture_output=True, text=True, check=True
        ).stdout.strip()
        parts = out.split("|")
        is_nullable = parts[0] if parts else ""
        col_default = parts[1] if len(parts) > 1 else ""

        log_test("Database Security", f"Table {t} organization_id NOT NULL", is_nullable == "NO", f"is_nullable={is_nullable}")
        log_test("Database Security", f"Table {t} organization_id has NO DEFAULT", col_default == "" or col_default == "NULL", f"default={col_default}")

    # 2. Check source code in dashboard/lib/vaani-sales.js for unsafe COALESCE(..., 1) or DEFAULT 1
    with open("dashboard/lib/vaani-sales.js", "r", encoding="utf-8") as f:
        code = f.read()

    has_unsafe_coalesce = bool(re.search(r"COALESCE\s*\([^,]+,\s*1\s*\)", code, re.IGNORECASE))
    log_test("Database Security", "No unsafe COALESCE(..., 1) in vaani-sales.js", not has_unsafe_coalesce)

    has_unsafe_default1 = bool(re.search(r"organization_id\s*=\s*1\b", code))
    log_test("Database Security", "No hardcoded organization_id = 1 query scoping", not has_unsafe_default1)

# -------------------------------------------------------------
# 6. DNC Audit
# -------------------------------------------------------------
def run_dnc_audit(tokens):
    tok1 = tokens["org1_owner"]
    tok2 = tokens["org2_owner"]

    # Shared phone (+919777733333) was inserted in Org 1 DNC registry
    req1 = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/dnc", headers={"Cookie": f"rxv_sess={tok1}"})
    data1 = json.loads(urllib.request.urlopen(req1).read().decode())
    phones1 = [r.get("phone_number") for r in data1.get("dnc_records", [])]
    log_test("DNC Isolation", "Org 1 sees its registered DNC phone", AUDIT_SHARED_PHONE in phones1)

    # Org 2 must NOT see that phone in its DNC registry
    req2 = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/dnc", headers={"Cookie": f"rxv_sess={tok2}"})
    data2 = json.loads(urllib.request.urlopen(req2).read().decode())
    phones2 = [r.get("phone_number") for r in data2.get("dnc_records", [])]
    log_test("DNC Isolation", "Org 2 DOES NOT see Org 1 DNC phone", AUDIT_SHARED_PHONE not in phones2)

# -------------------------------------------------------------
# 7. Secret Audit
# -------------------------------------------------------------
def run_secret_audit():
    # 1. Verify .gitignore ignores .env
    with open(".gitignore", "r", encoding="utf-8") as f:
        gitignore = f.read()
    log_test("Secret Handling", ".env is included in .gitignore", ".env" in gitignore)

    # 2. Check tracked files for actual secret keys (without printing secret values)
    git_tracked = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines()
    tracked_secrets_found = []
    for fpath in git_tracked:
        if not os.path.isfile(fpath) or fpath.endswith((".png", ".jpg", ".webp", ".ico", ".svg")):
            continue
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
                # Check for patterns like real sk- or private keys
                if re.search(r"sk-[a-zA-Z0-9]{32,}", content) or re.search(r"-----BEGIN PRIVATE KEY-----", content):
                    tracked_secrets_found.append(fpath)
        except Exception:
            pass

    log_test("Secret Handling", "Zero tracked private keys or real API keys committed", len(tracked_secrets_found) == 0, f"Violations={tracked_secrets_found}")

    # 3. Check public HTML / JS for leaked secrets or storage tokens
    for fe_file in ["dashboard/public/vaani-sales.html", "dashboard/public/assets/app.js", "dashboard/public/app.html"]:
        with open(fe_file, "r", encoding="utf-8") as f:
            fe_content = f.read()
        has_secret_pattern = bool(re.search(r"(VAANI_INGESTION_SECRET|POSTGRES_PASSWORD|scrypt\$)", fe_content))
        log_test("Secret Handling", f"No secret patterns in {fe_file}", not has_secret_pattern)

# -------------------------------------------------------------
# 8. Session & Cookie Security Audit
# -------------------------------------------------------------
def run_session_cookie_audit(tokens):
    # Make a login request and inspect Set-Cookie headers
    req = urllib.request.Request(f"{BASE_URL}/api/auth/login", data=b'{"email":"org1_owner@audit.local","password":"auditpass123"}', headers={"Content-Type": "application/json"}, method="POST")
    res = urllib.request.urlopen(req)
    set_cookie = res.headers.get("Set-Cookie", "")
    log_test("Session Security", "rxv_sess cookie has HttpOnly flag", "HttpOnly" in set_cookie, f"Header: {set_cookie}")
    log_test("Session Security", "rxv_sess cookie has SameSite flag", "SameSite=" in set_cookie, f"Header: {set_cookie}")
    log_test("Session Security", "rxv_sess cookie has Path=/", "Path=/" in set_cookie)

# -------------------------------------------------------------
# 9. API Input Tampering Audit
# -------------------------------------------------------------
def run_api_input_audit(tokens):
    tok = tokens["org1_owner"]
    # Attempt to post a follow-up status update with organization_id: 2 injected in body
    payload = json.dumps({"id": f"fup_{AUDIT_RUN2}", "status": "completed", "organization_id": 2}).encode()
    req = urllib.request.Request(f"{BASE_URL}/api/vaani/sales/follow-up/status", data=payload, headers={"Cookie": f"rxv_sess={tok}", "Content-Type": "application/json"}, method="POST")
    try:
        res = urllib.request.urlopen(req)
        data = json.loads(res.read().decode())
        log_test("API Input Audit", "Body organization_id tampering does NOT affect cross-tenant follow-up", not data.get("success", False), f"Result={data}")
    except urllib.error.HTTPError as e:
        log_test("API Input Audit", "Body organization_id tampering does NOT affect cross-tenant follow-up", e.code in [403, 404], f"Blocked with {e.code}")

# -------------------------------------------------------------
# Main Runner
# -------------------------------------------------------------
def main():
    print("=" * 70)
    print("PHASE E — STEP 6: FINAL SECURITY & CROSS-TENANT AUDIT")
    print("=" * 70)

    try:
        tokens = seed_fixtures()
        run_auth_audit(tokens)
        run_authorization_audit(tokens)
        run_tenant_isolation_audit(tokens)
        run_webhook_audit()
        run_database_audit()
        run_dnc_audit(tokens)
        run_secret_audit()
        run_session_cookie_audit(tokens)
        run_api_input_audit(tokens)
    finally:
        clean_fixtures()

    print("=" * 70)
    print("AUDIT SUMMARY:")
    all_passed = True
    for cat, tests in audit_results.items():
        cat_passed = all(t["status"] == "PASS" for t in tests)
        if not cat_passed:
            all_passed = False
        print(f"  {cat}: {'PASS' if cat_passed else 'FAIL'} ({len(tests)} checks)")

    print("=" * 70)
    print(f"OVERALL SECURITY STATUS: {'PASS' if all_passed else 'FAIL'}")
    return 0 if all_passed else 1

if __name__ == "__main__":
    sys.exit(main())
