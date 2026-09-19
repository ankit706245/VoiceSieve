import re

with open('dashboard/server.js', 'r') as f:
    content = f.read()

new_handlers = """
async function apiVaaniBuyerMatchesGet(req, res, buyerRunId) {
  const orgId = resolveOrganizationId(req);
  if (!orgId) return core.sendJson(res, 401, { error: 'Unauthorized', authenticated: false });
  try {
    const sql = `
      SELECT m.id, m.match_type, m.match_status, m.evidence_json, m.created_at,
             v.machine_id, v.brand, v.model, v.manufacturing_year, v.hour_meter_reading, v.status, v.current_location
      FROM vaani_buyer_machine_matches m
      JOIN vaani_machines v ON m.inventory_machine_id = v.machine_id
      WHERE m.organization_id = $1 AND m.buyer_run_id = $2
      ORDER BY m.created_at DESC
    `;
    const results = await getVaaniSales().queryPostgres(sql, [orgId, parseInt(buyerRunId, 10)]);
    core.sendJson(res, 200, Array.isArray(results) ? results : []);
  } catch (err) {
    core.sendJson(res, 500, { error: 'Database error' });
  }
}

async function apiVaaniBuyerMatchesPost(req, res, buyerRunId, body) {
  const orgId = resolveOrganizationId(req);
  if (!orgId) return core.sendJson(res, 401, { error: 'Unauthorized', authenticated: false });
  try {
    if (!body || typeof body !== 'object') {
       return core.sendJson(res, 422, { error: 'Invalid buyer requirement' });
    }
    const matches = await getVaaniSales().runIntelligentMatching(orgId, buyerRunId, body);
    core.sendJson(res, 200, matches);
  } catch (err) {
    core.sendJson(res, 500, { error: err.message });
  }
}
"""

if "apiVaaniBuyerMatchesGet" not in content:
    content = content.replace("async function handleRequest(req, res) {", new_handlers + "\nasync function handleRequest(req, res) {")

# GET routes
get_route = "if (route === '/api/vaani/buyers') return core.requireAuth(req, res, apiVaaniBuyersList);"
if "/api/vaani/buyers/') && route.endsWith('/matches')" not in content:
    content = content.replace(get_route, get_route + "\n        if (route.startsWith('/api/vaani/buyers/') && route.endsWith('/matches') && route.split('/').length === 6) return core.requireAuth(req, res, apiVaaniBuyerMatchesGet, route.split('/')[4]);")

# POST routes
post_route = "if (route.startsWith('/api/vaani/sales/leads/') && route.endsWith('/evidence/request')) {"
if "/api/vaani/buyers/') && route.endsWith('/matches')" not in content.split("} else if (req.method === 'POST') {")[-1]:
    content = content.replace(post_route, "if (route.startsWith('/api/vaani/buyers/') && route.endsWith('/matches') && route.split('/').length === 6) return core.requireAuth(req, res, apiVaaniBuyerMatchesPost, route.split('/')[4], body);\n      " + post_route)

with open('dashboard/server.js', 'w') as f:
    f.write(content)
