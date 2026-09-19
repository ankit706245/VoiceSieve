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
    let reqBody = body;
    if (!reqBody || Object.keys(reqBody).length === 0) {
      const bsql = `SELECT machine_brand, machine_model, required_tonnage_class, buyer_budget_max_inr, 
                           model_year_min, model_year_max, running_hours_max, application_history 
                    FROM vaani_excavator_sales_leads 
                    WHERE organization_id = $1 AND run_id = $2`;
      const leads = await getVaaniSales().queryPostgres(bsql, [orgId, parseInt(buyerRunId, 10)]);
      if (leads && leads.length > 0) {
         reqBody = leads[0];
      } else {
         return core.sendJson(res, 404, { error: 'Buyer not found' });
      }
    }
    const matches = await getVaaniSales().runIntelligentMatching(orgId, buyerRunId, reqBody);
    core.sendJson(res, 200, matches);
  } catch (err) {
    core.sendJson(res, 500, { error: err.message });
  }
}

"""

if "async function apiVaaniBuyerMatchesGet" not in content:
    content = content.replace("async function apiVaaniCallsList", new_handlers + "\nasync function apiVaaniCallsList")

with open('dashboard/server.js', 'w') as f:
    f.write(content)