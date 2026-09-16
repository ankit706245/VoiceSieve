/**
 * Vaani Used Excavator Sales Backend Module
 * =========================================
 * Implements the data access layer for the Vaani Sales CRM / Operations Console.
 * Complies strictly with docs/dashboard/VAANI-SALES-DATA-CONTRACT.md.
 * 
 * Supports:
 * - Real PostgreSQL querying from public.vaani_excavator_sales_leads, vaani_machines, and vaani_dnc_registry
 * - Explicit development demo fixture loading (dashboard/data/fixtures/demo-sales-data.json)
 * - Zero-hallucination empty states when production data has 0 records
 * - Strict DNC quarantine isolation
 */

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const vaaniExtractor = require('./vaani-extractor');
const vaaniTasks = require('./vaani-tasks');
const vaaniWhatsapp = require('./vaani-whatsapp');

const FIXTURE_PATH = path.join(__dirname, '..', 'data', 'fixtures', 'demo-sales-data.json');

// Canonical Machine Master taxonomy from docs/entity-model/MACHINE-MASTER-MODEL.md
const MACHINE_MASTER_TAXONOMY = [
  {
    brand: 'Tata Hitachi',
    canonical_model: 'EX 200 LC',
    aliases: ['Tata 200', 'EX 200', '200 Model', 'Bada Tata'],
    tonnage_class: '20_ton_class',
    operating_weight_kg: 20000,
    standard_engine: 'Cummins 6BT 5.9',
    market_positioning: 'Highest resale liquidity and buyer demand in Indian market',
    indicative_bands: {
      '2023_2024': '₹32L - ₹36L',
      '2021_2022': '₹27L - ₹31L',
      '2018_2019': '₹19L - ₹24L'
    }
  },
  {
    brand: 'Tata Hitachi',
    canonical_model: 'EX 210 LC / Super',
    aliases: ['Tata 210', '210 Super', 'EX 210'],
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21000,
    standard_engine: 'Cummins 6BT 5.9',
    market_positioning: 'High fuel efficiency, contractor standard for canal and soil work',
    indicative_bands: {
      '2023_2024': '₹33L - ₹37L',
      '2021_2022': '₹28L - ₹32L',
      '2018_2019': '₹20L - ₹25L'
    }
  },
  {
    brand: 'JCB',
    canonical_model: 'JS 205',
    aliases: ['JCB 205', 'JS 205', 'JCB Excavator'],
    tonnage_class: '20_ton_class',
    operating_weight_kg: 20500,
    standard_engine: 'Cummins 6BT 5.9',
    market_positioning: 'Popular for bulk earthwork, affordable spares across India',
    indicative_bands: {
      '2023_2024': '₹31L - ₹35L',
      '2021_2022': '₹26L - ₹30L',
      '2018_2019': '₹18L - ₹23L'
    }
  },
  {
    brand: 'Hyundai',
    canonical_model: 'Robex R210-7',
    aliases: ['Hyundai 210', 'Smart 210', 'Robex 210', 'Hyundai Poclain'],
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21200,
    standard_engine: 'Hyundai / Cummins',
    market_positioning: 'Smooth hydraulics, high contractor preference in Rajasthan & MP',
    indicative_bands: {
      '2023_2024': '₹30L - ₹34L',
      '2021_2022': '₹25L - ₹29L',
      '2018_2019': '₹17L - ₹22L'
    }
  },
  {
    brand: 'Komatsu',
    canonical_model: 'PC 210-10M0',
    aliases: ['Komatsu 210', 'PC 210'],
    tonnage_class: '21_ton_class',
    operating_weight_kg: 21000,
    standard_engine: 'Komatsu SAA6D107E-1',
    market_positioning: 'Heavy quarry durability and high cycle speed',
    indicative_bands: {
      '2023_2024': '₹34L - ₹38L',
      '2021_2022': '₹28L - ₹33L',
      '2018_2019': '₹20L - ₹25L'
    }
  }
];

function loadDemoData() {
  if (!fs.existsSync(FIXTURE_PATH)) return null;
  try {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[VAANI SALES] Error reading demo fixture:', err.message);
    return null;
  }
}

function sqlEscapeString(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'` + String(val).replace(/'/g, `''`) + `'`;
}

function sqlEscapeJson(obj) {
  if (obj === null || obj === undefined) return 'NULL';
  const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return `'` + str.replace(/'/g, `''`) + `'::jsonb`;
}

function sqlEscapeInt(val) {
  if (val === null || val === undefined || isNaN(Number(val))) return 'NULL';
  return String(parseInt(val, 10));
}

function formatSql(sql, params) {
  if (!params || !params.length) return sql;
  return sql.replace(/\$(\d+)/g, (match, idx) => {
    const i = parseInt(idx, 10) - 1;
    if (i < 0 || i >= params.length) return match;
    const val = params[i];
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
    return `'${String(val).replace(/'/g, "''")}'`;
  });
}

function queryPostgres(sql, params = []) {
  const finalSql = formatSql(sql, params);
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'exec',
      '-i',
      'dograh-local-postgres-1',
      'psql',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-t',
      '-A'
    ]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `psql exited with code ${code}`));
      try {
        const trimmed = stdout.trim();
        if (!trimmed) return resolve(null);
        try {
          return resolve(JSON.parse(trimmed));
        } catch (_) {
          const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
          for (const line of lines) {
            if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
              try {
                return resolve(JSON.parse(line));
              } catch (_) {}
            }
          }
          return resolve(trimmed);
        }
      } catch (parseErr) {
        resolve(stdout.trim());
      }
    });
    proc.on('error', reject);
    proc.stdin.write(finalSql);
    proc.stdin.end();
  });
}

// In-memory follow-up status store for local runtime persistence
const localFollowUpOverrides = new Map();

function getEmptyOverview() {
  return {
    is_demo: false,
    total_leads: 0,
    connected_calls: 0,
    hot_sellers: 0,
    hot_buyers: 0,
    qualified_leads: 0,
    follow_ups_due: 0,
    closed_won: 0,
    dnc_total: 0,
    funnel: [
      { stage: 'NEW', count: 0 },
      { stage: 'CONTACTED', count: 0 },
      { stage: 'CONNECTED', count: 0 },
      { stage: 'INTERESTED', count: 0 },
      { stage: 'QUALIFIED', count: 0 },
      { stage: 'PRICE_DISCUSSION', count: 0 },
      { stage: 'FOLLOW_UP', count: 0 },
      { stage: 'NEGOTIATION', count: 0 },
      { stage: 'CLOSED_WON', count: 0 },
      { stage: 'CLOSED_LOST', count: 0 },
      { stage: 'DO_NOT_CALL', count: 0 }
    ],
    recent_leads: [],
    recent_activities: []
  };
}

async function getOverview(isDemo = false, organizationId = null) {
  if (isDemo) {
    const demo = loadDemoData();
    if (demo) {
      return {
        is_demo: true,
        ...demo.stats,
        funnel: demo.funnel,
        recent_leads: demo.sellers.concat(demo.buyers).slice(0, 8),
        recent_activities: demo.recent_activities || []
      };
    }
  }

  if (!organizationId) {
    return getEmptyOverview();
  }

  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) {
    return getEmptyOverview();
  }

  try {
    const sql = `
      SELECT json_build_object(
        'total_leads', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1),
        'connected_calls', (SELECT COUNT(*) FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE w.organization_id = $1),
        'hot_sellers', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND customer_type = 'seller' AND lead_temperature = 'HOT'),
        'hot_buyers', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND customer_type = 'buyer' AND lead_temperature = 'HOT'),
        'qualified_leads', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND qualification_state = 'QUALIFIED'),
        'follow_ups_due', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND follow_up_required = true AND dnc_requested = false),
        'closed_won', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND conversation_outcome = 'lead_qualified' AND lead_temperature = 'HOT'),
        'dnc_total', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND dnc_requested = true),
        'funnel', json_build_array(
          json_build_object('stage', 'NEW', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND (customer_type = 'unknown' OR conversation_outcome = 'inquiry'))),
          json_build_object('stage', 'CONTACTED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1)),
          json_build_object('stage', 'CONNECTED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND conversation_outcome IS NOT NULL AND conversation_outcome != 'failed')),
          json_build_object('stage', 'INTERESTED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND conversation_outcome IN ('inquiry', 'price_discussion', 'callback_requested', 'appointment_requested', 'lead_qualified'))),
          json_build_object('stage', 'QUALIFIED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND qualification_state = 'QUALIFIED')),
          json_build_object('stage', 'PRICE_DISCUSSION', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND (conversation_outcome = 'price_discussion' OR price_raw IS NOT NULL))),
          json_build_object('stage', 'FOLLOW_UP', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND follow_up_required = true)),
          json_build_object('stage', 'NEGOTIATION', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND lead_temperature = 'HOT' AND qualification_state = 'QUALIFIED')),
          json_build_object('stage', 'CLOSED_WON', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND conversation_outcome = 'lead_qualified' AND lead_temperature = 'HOT')),
          json_build_object('stage', 'CLOSED_LOST', 'count', 0),
          json_build_object('stage', 'DO_NOT_CALL', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE organization_id = $1 AND dnc_requested = true))
        ),
        'recent_leads', COALESCE(
          (SELECT json_agg(t) FROM (
            SELECT run_id AS lead_id, created_at, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_time,
                   caller_name, callback_number, customer_type, machine_brand, machine_model,
                   lead_temperature, qualification_state, conversation_outcome, next_action, dnc_requested
            FROM vaani_excavator_sales_leads
            WHERE organization_id = $1
            ORDER BY run_id DESC LIMIT 10
          ) t), '[]'::json
        )
      );
    `;
    const result = await queryPostgres(sql, [orgInt]);
    if (result && typeof result === 'object') {
      const activities = await getRecentActivities(10, false, orgInt);
      return { is_demo: false, ...result, recent_activities: activities };
    }
  } catch (err) {
    console.error('[VAANI SALES] Error querying overview from PG:', err.message);
  }

  return getEmptyOverview();
}

async function getSellers(filters = {}, isDemo = false, organizationId = null) {
  let sellers = [];
  if (isDemo) {
    const demo = loadDemoData();
    sellers = demo ? demo.sellers : [];
  } else {
    if (!organizationId) return [];
    const orgInt = parseInt(organizationId, 10);
    if (isNaN(orgInt) || orgInt <= 0) return [];
    try {
      const sql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT run_id AS lead_id, run_id, created_at, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_time,
                 caller_name, callback_number, whatsapp_number, ownership_type,
                 machine_brand, machine_model, model_year, running_hours, application_history,
                 machine_location_city, machine_location_state, document_status,
                 expected_selling_price_inr, price_raw,
                 photos_agreed, running_video_agreed, rc_copy_agreed,
                 lead_temperature, qualification_state, conversation_outcome,
                 next_action, follow_up_required, follow_up_datetime, call_notes, dnc_requested
          FROM vaani_excavator_sales_leads
          WHERE organization_id = $1 AND customer_type = 'seller'
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql, [orgInt]);
      sellers = Array.isArray(result) ? result : [];
    } catch (err) {
      console.error('[VAANI SALES] Error querying sellers from PG:', err.message);
      sellers = [];
    }
  }

  // In-memory filters with support for canonical and alias parameter names
  return sellers.filter((s) => {
    const temp = filters.temperature || filters.lead_temperature;
    if (temp && s.lead_temperature !== temp) return false;

    const role = filters.ownership || filters.ownership_type || filters.caller_role;
    if (role) {
      const sRole = (s.ownership_type || s.caller_role || '').toLowerCase();
      const rLower = role.toLowerCase();
      if (rLower === 'broker' && !sRole.includes('broker') && !sRole.includes('munim')) return false;
      if (rLower === 'owner' && !sRole.includes('owner')) return false;
      if (!['broker', 'owner'].includes(rLower) && sRole !== rLower) return false;
    }

    const brand = filters.brand || filters.machine_brand;
    if (brand && s.machine_brand !== brand) return false;

    const app = filters.application || filters.application_history;
    if (app && s.application_history !== app) return false;

    const state = filters.state || filters.location_state || filters.machine_location_state;
    if (state && s.machine_location_state !== state && s.location_state !== state) return false;

    const qual = filters.qualified || filters.qualification_state;
    if (qual && s.qualification_state !== qual) return false;

    if ((filters.follow_up_due === 'true' || filters.follow_up_due === true) && !s.follow_up_required) return false;
    return true;
  });
}

async function getBuyers(filters = {}, isDemo = false, organizationId = null) {
  let buyers = [];
  if (isDemo) {
    const demo = loadDemoData();
    buyers = (demo ? demo.buyers : []).map((b) => {
      let timeline = b.purchase_timeline;
      if (timeline === 'immediate_within_7_days') timeline = 'immediate_under_7d';
      return {
        ...b,
        required_tonnage_class: b.required_tonnage_class || b.tonnage_class,
        purchase_timeline: timeline
      };
    });
  } else {
    if (!organizationId) return [];
    const orgInt = parseInt(organizationId, 10);
    if (isNaN(orgInt) || orgInt <= 0) return [];
    try {
      const sql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT run_id AS lead_id, run_id, created_at, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_time,
                 caller_name, callback_number, whatsapp_number,
                 machine_brand, machine_model, required_tonnage_class,
                 buyer_budget_max_inr, price_raw, purchase_timeline,
                 machine_location_city, machine_location_state,
                 yard_visit_agreed, yard_visit_schedule,
                 lead_temperature, qualification_state, conversation_outcome,
                 next_action, follow_up_required, follow_up_datetime, call_notes, dnc_requested
          FROM vaani_excavator_sales_leads
          WHERE organization_id = $1 AND customer_type = 'buyer'
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql, [orgInt]);
      buyers = Array.isArray(result) ? result : [];
    } catch (err) {
      console.error('[VAANI SALES] Error querying buyers from PG:', err.message);
      buyers = [];
    }
  }

  return buyers.filter((b) => {
    const temp = filters.temperature || filters.lead_temperature;
    if (temp && b.lead_temperature !== temp) return false;

    const brand = filters.brand || filters.machine_brand;
    if (brand && b.machine_brand !== brand) return false;

    const tonnage = filters.tonnage || filters.required_tonnage_class || filters.tonnage_class;
    if (tonnage) {
      const bTonnage = b.required_tonnage_class || b.tonnage_class;
      if (bTonnage !== tonnage) return false;
    }

    const timeline = filters.timeline || filters.purchase_timeline;
    if (timeline) {
      const bTimeline = b.purchase_timeline || '';
      if (timeline === 'immediate_under_7d' || timeline === 'immediate_within_7_days') {
        if (!bTimeline.includes('immediate') && !bTimeline.includes('7')) return false;
      } else if (bTimeline !== timeline) {
        return false;
      }
    }

    if ((filters.yard_visit === 'true' || filters.yard_visit === true) && !b.yard_visit_agreed && !b.yard_visit_interest) return false;
    return true;
  });
}

async function getMachines(isDemo = false, organizationId = null) {
  let actualStock = [];
  if (isDemo) {
    const demo = loadDemoData();
    actualStock = demo ? demo.actual_stock : [];
  } else {
    if (!organizationId) {
      return { machine_master: MACHINE_MASTER_TAXONOMY, actual_stock: [] };
    }
    const orgInt = parseInt(organizationId, 10);
    if (isNaN(orgInt) || orgInt <= 0) {
      return { machine_master: MACHINE_MASTER_TAXONOMY, actual_stock: [] };
    }
    try {
      const sql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT machine_id, brand, model, manufacturing_year, hour_meter_reading,
                 application_history, sourcing_cost_inr, target_resale_inr, status,
                 current_location, created_at
          FROM vaani_machines
          WHERE organization_id = $1
          ORDER BY created_at DESC
        ) t;
      `;
      const result = await queryPostgres(sql, [orgInt]);
      actualStock = Array.isArray(result) ? result : [];
    } catch (err) {
      console.error('[VAANI SALES] Error querying vaani_machines:', err.message);
      actualStock = [];
    }
  }

  return {
    machine_master: MACHINE_MASTER_TAXONOMY,
    actual_stock: actualStock
  };
}

async function getInternalMachines(filters = {}) {
  try {
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (filters.brand) {
      conditions.push(`brand ILIKE $${paramIndex++}`);
      params.push(`%${filters.brand}%`);
    }
    if (filters.model) {
      conditions.push(`model ILIKE $${paramIndex++}`);
      params.push(`%${filters.model}%`);
    }
    if (filters.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filters.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Explicitly excluding sourcing_cost_inr and target_resale_inr
    const sql = `
      SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT machine_id, brand, model, manufacturing_year, status, current_location
        FROM vaani_machines
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT 50
      ) t;
    `;
    const result = await queryPostgres(sql, params, false);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[VAANI SALES] Error querying internal machines:', err.message);
    throw err;
  }
}

async function getDemand(isDemo = false, organizationId = null) {
  if (isDemo) {
    const demo = loadDemoData();
    const demand = demo ? demo.demand_analytics : {};
    const stock = demo ? demo.actual_stock : [];
    const buyers = demo ? demo.buyers : [];

    // Matching real buyers with real/demo stock
    const matches = buyers.map((b) => {
      const matchingUnits = stock.filter((s) => {
        const brandMatch = b.machine_brand === 'Any' || !b.machine_brand || s.brand === b.machine_brand;
        const budgetMatch = !b.buyer_budget_max_inr || s.target_resale_inr <= b.buyer_budget_max_inr;
        return brandMatch && budgetMatch;
      });
      return {
        buyer_lead_id: b.lead_id,
        buyer_name: b.customer_name,
        buyer_phone: b.primary_phone,
        requested_machine: b.machine_brand || b.required_tonnage_class,
        budget_max_inr: b.buyer_budget_max_inr,
        matching_stock: matchingUnits
      };
    });

    return {
      is_demo: true,
      ...demand,
      matches
    };
  }

  // Real data aggregation from PG
  try {
    const buyers = await getBuyers({}, false, organizationId);
    const machinesRes = await getMachines(false, organizationId);
    const stock = machinesRes.actual_stock;

    // Aggregate brands
    const brandCounts = {};
    const tonnageCounts = {};
    buyers.forEach((b) => {
      const br = b.machine_brand || 'Unspecified';
      brandCounts[br] = (brandCounts[br] || 0) + 1;
      const t = b.required_tonnage_class || 'unknown';
      tonnageCounts[t] = (tonnageCounts[t] || 0) + 1;
    });

    const topBrands = Object.entries(brandCounts).map(([brand, count]) => ({
      brand,
      share_percentage: buyers.length ? Math.round((count / buyers.length) * 100) : 0,
      inquiries_count: count
    }));

    const topTonnage = Object.entries(tonnageCounts).map(([tonnage, count]) => ({
      tonnage,
      percentage: buyers.length ? Math.round((count / buyers.length) * 100) : 0
    }));

    const matches = buyers.map((b) => {
      const matchingUnits = stock.filter((s) => {
        const brandMatch = b.machine_brand === 'Any' || !b.machine_brand || s.brand === b.machine_brand;
        const budgetMatch = !b.buyer_budget_max_inr || s.target_resale_inr <= b.buyer_budget_max_inr;
        return brandMatch && budgetMatch;
      });
      return {
        buyer_lead_id: b.lead_id,
        buyer_name: b.customer_name,
        buyer_phone: b.primary_phone,
        requested_machine: b.machine_brand || b.required_tonnage_class,
        budget_max_inr: b.buyer_budget_max_inr,
        matching_stock: matchingUnits
      };
    });

    return {
      is_demo: false,
      top_requested_brands: topBrands,
      top_requested_tonnage: topTonnage,
      budget_distribution: [],
      top_locations: [],
      matches
    };
  } catch (err) {
    console.error('[VAANI SALES] Error calculating demand:', err.message);
    return { is_demo: false, top_requested_brands: [], top_requested_tonnage: [], budget_distribution: [], top_locations: [], matches: [] };
  }
}

async function getFollowUps(isDemo = false, organizationId = null) {
  let list = [];
  if (isDemo) {
    const demo = loadDemoData();
    list = demo ? demo.follow_ups : [];
  } else {
    if (!organizationId) {
      return { overdue: [], due_today: [], upcoming: [] };
    }
    const orgInt = parseInt(organizationId, 10);
    if (isNaN(orgInt) || orgInt <= 0) {
      return { overdue: [], due_today: [], upcoming: [] };
    }
    try {
      const persistentTasks = await vaaniTasks.getTasksForOrganization(orgInt);
      const totalTasks = (persistentTasks.overdue || []).length + (persistentTasks.due_today || []).length + (persistentTasks.upcoming || []).length;
      if (totalTasks > 0) {
        const allTasks = [
          ...(persistentTasks.overdue || []),
          ...(persistentTasks.due_today || []),
          ...(persistentTasks.upcoming || [])
        ];
        return {
          ...persistentTasks,
          tasks: allTasks,
          total: allTasks.length
        };
      }
    } catch (tErr) {
      console.warn('[VAANI SALES] Notice checking persistent tasks:', tErr.message);
    }

    try {
      const sql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT run_id AS id, caller_name AS customer_name, customer_type,
                 callback_number AS primary_phone,
                 COALESCE(machine_model, required_tonnage_class, '20-Ton Excavator') AS machine_requirement,
                 next_action AS reason, follow_up_datetime,
                 'pending' AS status, 'Procurement/Sales Team' AS assigned_owner
          FROM vaani_excavator_sales_leads
          WHERE organization_id = $1 AND follow_up_required = true AND dnc_requested = false
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql, [orgInt]);
      list = Array.isArray(result) ? result : [];
    } catch (err) {
      console.error('[VAANI SALES] Error querying follow-ups from PG:', err.message);
      list = [];
    }
  }

  // Apply in-memory overrides & categorize by date
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 86400000;

  const enriched = list.map((item) => {
    const currentStatus = localFollowUpOverrides.get(String(item.id)) || item.status || 'pending';
    let category = item.category || 'upcoming';

    if (item.follow_up_datetime) {
      const t = new Date(item.follow_up_datetime).getTime();
      if (t < startOfToday) category = 'overdue';
      else if (t <= endOfToday) category = 'due_today';
      else category = 'upcoming';
    }

    return {
      ...item,
      status: currentStatus,
      category
    };
  });

  const overdueList = enriched.filter((i) => i.category === 'overdue');
  const todayList = enriched.filter((i) => i.category === 'due_today');
  const upcomingList = enriched.filter((i) => i.category === 'upcoming');
  const allTasks = [...overdueList, ...todayList, ...upcomingList];

  return {
    overdue: overdueList,
    due_today: todayList,
    upcoming: upcomingList,
    tasks: allTasks,
    total: allTasks.length,
    stats: {
      total: allTasks.length,
      overdue: overdueList.length,
      today: todayList.length,
      upcoming: upcomingList.length
    }
  };
}

async function getCalls(isDemo = false, organizationId = null) {
  if (isDemo) {
    const demo = loadDemoData();
    return demo ? demo.calls : [];
  }

  if (!organizationId) return [];
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return [];

  try {
    const sql = `
      SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT run_id, created_at, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_time,
               caller_name, callback_number AS primary_phone, customer_type,
               conversation_outcome, lead_temperature, qualification_state,
               COALESCE(machine_model, required_tonnage_class, '20-Ton Excavator') AS machine_summary,
               price_raw, machine_location_city AS location, next_action,
               false AS has_audio, NULL AS audio_url
        FROM vaani_excavator_sales_leads
        WHERE organization_id = $1
        ORDER BY run_id DESC
      ) t;
    `;
    const result = await queryPostgres(sql, [orgInt]);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[VAANI SALES] Error querying calls from PG:', err.message);
    return [];
  }
}

async function getCallDetail(runId, isDemo = false, organizationId = null) {
  if (isDemo) {
    const demo = loadDemoData();
    const match = (demo?.calls || []).find((c) => String(c.run_id) === String(runId));
    if (match) return match;
    return (demo?.calls || [])[0] || null;
  }

  if (!organizationId) return null;
  const orgInt = parseInt(organizationId, 10);
  const runInt = parseInt(runId, 10);
  if (isNaN(orgInt) || orgInt <= 0 || isNaN(runInt) || runInt <= 0) return null;

  try {
    const sql = `
      SELECT json_build_object(
        'run_id', r.id,
        'created_at', r.created_at,
        'customer_name', (r.gathered_context -> 'extracted_variables') ->> 'caller_name',
        'primary_phone', (r.gathered_context -> 'extracted_variables') ->> 'callback_number',
        'customer_type', COALESCE((r.gathered_context -> 'extracted_variables') ->> 'customer_type', 'unknown'),
        'conversation_outcome', (r.gathered_context -> 'extracted_variables') ->> 'conversation_outcome',
        'lead_temperature', (r.gathered_context -> 'extracted_variables') ->> 'lead_temperature',
        'qualification_state', (r.gathered_context -> 'extracted_variables') ->> 'qualification_state',
        'next_action', (r.gathered_context -> 'extracted_variables') ->> 'next_action',
        'dnc_requested', COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'dnc_requested')::boolean, false),
        'extracted_variables', (r.gathered_context -> 'extracted_variables'),
        'has_audio', false,
        'audio_url', NULL,
        'transcript', '[]'::json
      )
      FROM workflow_runs r
      JOIN workflows w ON r.workflow_id = w.id
      WHERE r.id = $1 AND w.organization_id = $2;
    `;
    const result = await queryPostgres(sql, [runInt, orgInt]);
    return result || null;
  } catch (err) {
    console.error(`[VAANI SALES] Error querying call detail for ${runId}:`, err.message);
    return null;
  }
}

async function getDncRegistry(isDemo = false, organizationId = null) {
  if (isDemo) {
    const demo = loadDemoData();
    return demo ? demo.dnc_registry : [];
  }

  if (!organizationId) return [];
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return [];

  try {
    const sql = `
      SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT d.phone_number,
               COALESCE((r.gathered_context -> 'extracted_variables'::text) ->> 'caller_name'::text, 'Unregistered Caller') AS customer_name,
               d.reason,
               d.opted_out_at,
               'Call #' || COALESCE(d.run_id::text, 'N/A') AS source,
               d.is_active
        FROM vaani_dnc_registry d
        LEFT JOIN workflow_runs r ON d.run_id = r.id
        WHERE d.organization_id = $1 AND d.is_active = true
        ORDER BY d.opted_out_at DESC
      ) t;
    `;
    const result = await queryPostgres(sql, [orgInt]);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[VAANI SALES] Error querying DNC registry:', err.message);
    return [];
  }
}

async function searchLeads(query, isDemo = false, organizationId = null) {
  if (!query || typeof query !== 'string') return [];
  const q = query.trim().toLowerCase();

  const [sellers, buyers, dncList] = await Promise.all([
    getSellers({}, isDemo, organizationId),
    getBuyers({}, isDemo, organizationId),
    getDncRegistry(isDemo, organizationId)
  ]);

  const results = [];

  // Check DNC matches first to flag them with high alert
  dncList.forEach((d) => {
    if (d.phone_number?.toLowerCase().includes(q) || d.customer_name?.toLowerCase().includes(q)) {
      results.push({
        id: `dnc_${d.phone_number}`,
        type: 'DNC_SUPPRESSED',
        customer_name: d.customer_name,
        phone: d.phone_number,
        details: d.reason,
        is_dnc: true,
        dnc_warning: 'DO NOT CALL — Suppressed in Compliance Registry'
      });
    }
  });

  sellers.forEach((s) => {
    const name = (s.customer_name || s.caller_name || '').toLowerCase();
    const phone = (s.primary_phone || s.callback_number || '').toLowerCase();
    const model = (s.machine_model || '').toLowerCase();
    const brand = (s.machine_brand || '').toLowerCase();
    const city = (s.machine_location_city || s.location_city || '').toLowerCase();
    const state = (s.machine_location_state || s.location_state || '').toLowerCase();

    if (name.includes(q) || phone.includes(q) || model.includes(q) || brand.includes(q) || city.includes(q) || state.includes(q)) {
      results.push({
        id: s.lead_id || s.run_id,
        type: 'SELLER',
        customer_name: s.customer_name || s.caller_name || 'Seller',
        phone: s.primary_phone || s.callback_number,
        machine: `${s.machine_brand || ''} ${s.machine_model || ''}`.trim(),
        location: `${s.machine_location_city || s.location_city || ''}, ${s.machine_location_state || s.location_state || ''}`.trim(),
        temperature: s.lead_temperature,
        is_dnc: !!s.dnc_requested
      });
    }
  });

  buyers.forEach((b) => {
    const name = (b.customer_name || b.caller_name || '').toLowerCase();
    const phone = (b.primary_phone || b.callback_number || '').toLowerCase();
    const model = (b.machine_model || '').toLowerCase();
    const brand = (b.machine_brand || '').toLowerCase();
    const city = (b.machine_location_city || b.location_city || b.delivery_location || '').toLowerCase();

    if (name.includes(q) || phone.includes(q) || model.includes(q) || brand.includes(q) || city.includes(q)) {
      results.push({
        id: b.lead_id || b.run_id,
        type: 'BUYER',
        customer_name: b.customer_name || b.caller_name || 'Buyer',
        phone: b.primary_phone || b.callback_number,
        machine: b.machine_brand || b.required_tonnage_class || 'Excavator',
        location: b.machine_location_city || b.location_city || b.delivery_location || '',
        temperature: b.lead_temperature,
        is_dnc: !!b.dnc_requested
      });
    }
  });

  return results;
}

async function updateFollowUpStatus(followUpId, status, organizationId = null) {
  const upperStatus = String(status || '').toUpperCase();
  const lowerStatus = String(status || '').toLowerCase();

  // If organizationId is provided and task exists in public.vaani_follow_up_tasks
  if (organizationId) {
    const orgInt = parseInt(organizationId, 10);
    try {
      const taskCheck = await queryPostgres(
        `SELECT row_to_json(t) FROM (SELECT task_id FROM public.vaani_follow_up_tasks WHERE task_id = $1 AND organization_id = $2 LIMIT 1) t;`,
        [String(followUpId), orgInt]
      ).catch(() => null);

      if (taskCheck && taskCheck.task_id) {
        const updated = await vaaniTasks.transitionTaskStatus(
          taskCheck.task_id,
          upperStatus,
          orgInt,
          'Sales Operator'
        );
        return {
          success: true,
          id: followUpId,
          status: updated.status,
          updated_at: updated.updated_at || new Date().toISOString(),
          task: updated
        };
      }
    } catch (taskErr) {
      if (String(followUpId).startsWith('task_') || taskErr.code === 'invalid_transition' || taskErr.code === 'not_found') {
        throw taskErr;
      }
    }
  }

  // Legacy fallback for previous unit tests & demo mode
  if (!['pending', 'completed', 'cancelled', 'scheduled', 'skipped', 'in_progress'].includes(lowerStatus)) {
    throw new Error('Invalid follow-up status');
  }

  if (organizationId) {
    const orgInt = parseInt(organizationId, 10);
    const runInt = parseInt(followUpId, 10);
    if (isNaN(runInt)) {
      const err = new Error('Follow-up not found');
      err.code = 'not_found';
      throw err;
    }
    const checkSql = `SELECT r.id FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id WHERE r.id = $1 AND w.organization_id = $2 LIMIT 1;`;
    const exists = await queryPostgres(checkSql, [runInt, orgInt]);
    if (!exists || (typeof exists === 'object' && !exists.id)) {
      const err = new Error('Follow-up record not found for organization');
      err.code = 'not_found';
      throw err;
    }
  }

  localFollowUpOverrides.set(String(followUpId), lowerStatus);
  return { success: true, id: followUpId, status: lowerStatus, updated_at: new Date().toISOString() };
}


// -------------------------------------------------------------
// Lead 360 & Activity Journey Helpers
// -------------------------------------------------------------

function buildExtractedVsMissing(lead) {
  if (!lead) return { captured: [], missing: [] };
  const isSeller = lead.customer_type === 'seller';
  const captured = [];
  const missing = [];

  if (isSeller) {
    // 1. Owner / Broker
    if (lead.ownership_type || lead.caller_role) {
      captured.push({ field: 'Owner / Broker', key: 'ownership_type', label: 'Owner / Broker', value: lead.ownership_type || lead.caller_role });
    } else {
      missing.push({ field: 'Owner / Broker', key: 'ownership_type', label: 'Owner / Broker', hint: 'Verify if direct owner or mediator munim' });
    }

    // 2. Brand
    if (lead.machine_brand) {
      captured.push({ field: 'Brand', key: 'machine_brand', label: 'Brand', value: lead.machine_brand });
    } else {
      missing.push({ field: 'Brand', key: 'machine_brand', label: 'Brand', hint: 'Ask brand (Tata Hitachi, JCB, Komatsu, Hyundai)' });
    }

    // 3. Model
    if (lead.machine_model) {
      captured.push({ field: 'Model', key: 'machine_model', label: 'Model', value: lead.machine_model });
    } else {
      missing.push({ field: 'Model', key: 'machine_model', label: 'Model', hint: 'Ask exact model series (e.g. EX 200, 210, JS 205)' });
    }

    // 4. Year
    if (lead.model_year || lead.manufacturing_year) {
      captured.push({ field: 'Manufacturing Year', key: 'model_year', label: 'Manufacturing Year', value: String(lead.model_year || lead.manufacturing_year) });
    } else {
      missing.push({ field: 'Manufacturing Year', key: 'model_year', label: 'Manufacturing Year', hint: 'Inquire year of purchase / invoice' });
    }

    // 5. Hours / HMR
    if (lead.running_hours || lead.hour_meter_reading) {
      const hrs = lead.running_hours || lead.hour_meter_reading;
      captured.push({ field: 'Hour Meter Reading (HMR)', key: 'running_hours', label: 'Hours / HMR', value: `${Number(hrs).toLocaleString()} hrs` });
    } else {
      missing.push({ field: 'Hour Meter Reading (HMR)', key: 'running_hours', label: 'Hours / HMR', hint: 'Request current meter reading' });
    }

    // 6. Application (Soil vs Rock)
    if (lead.application_history) {
      const isRock = lead.application_history.includes('rock') || lead.application_history.includes('breaker');
      captured.push({
        field: 'Application (Soil vs Rock)',
        key: 'application_history',
        label: 'Application History',
        value: isRock ? '⚠️ Rock Breaker / Quarry' : 'Soft Soil / Earthwork'
      });
    } else {
      missing.push({ field: 'Application (Soil vs Rock)', key: 'application_history', label: 'Application (Soil vs Rock)', hint: 'Ask if breaker fitted or soil work only' });
    }

    // 7. Component condition
    if (lead.component_condition || lead.machine_condition_summary) {
      captured.push({ field: 'Component Condition', key: 'component_condition', label: 'Component Condition', value: lead.component_condition || lead.machine_condition_summary });
    } else {
      missing.push({ field: 'Component Condition', key: 'component_condition', label: 'Component Condition', hint: 'Verify pump, slew ring, and undercarriage' });
    }

    // 8. Location
    const loc = lead.location_city || lead.machine_location_city;
    if (loc) {
      captured.push({ field: 'Machine Location', key: 'location', label: 'Machine Location', value: `${loc}${lead.location_state ? ', ' + lead.location_state : ''}` });
    } else {
      missing.push({ field: 'Exact Location', key: 'location', label: 'Exact Location', hint: 'Clarify district and yard/site location' });
    }

    // 9. Asking price
    const price = lead.expected_selling_price_inr || lead.expected_price_inr || lead.price_raw;
    if (price) {
      const displayPrice = typeof price === 'number' ? `₹${(price / 100000).toFixed(2)} Lakh` : String(price);
      captured.push({ field: 'Asking Price', key: 'expected_price', label: 'Asking Price', value: displayPrice });
    } else {
      missing.push({ field: 'Asking Price', key: 'expected_price', label: 'Asking Price', hint: 'Explore seller expected in-hand amount' });
    }

    // 10. Documents / RC / NOC
    if (lead.document_status) {
      captured.push({ field: 'Documents (RC/NOC)', key: 'document_status', label: 'Documents / RC / NOC', value: lead.document_status });
    } else {
      missing.push({ field: 'RC / NOC Status', key: 'document_status', label: 'RC / NOC Status', hint: 'Confirm RC ownership & bank NOC clearance' });
    }

    // 11. Evidence status
    if (lead.evidence_checklist || lead.photos_agreed !== undefined) {
      const hasAgreed = lead.photos_agreed || lead.running_video_agreed || lead.evidence_checklist;
      captured.push({ field: 'Evidence Status', key: 'evidence_readiness', label: 'Evidence Status', value: hasAgreed ? 'Evidence package active' : 'Evidence requested' });
    } else {
      missing.push({ field: 'Machine Evidence', key: 'evidence_readiness', label: 'Machine Evidence', hint: 'Request 30s running video and 5 photos' });
    }
  } else {
    // Buyer Leads
    // 1. Required Brand
    if (lead.machine_brand && lead.machine_brand !== 'Any') {
      captured.push({ field: 'Required Brand', key: 'machine_brand', label: 'Required Brand', value: lead.machine_brand });
    } else {
      captured.push({ field: 'Required Brand', key: 'machine_brand', label: 'Required Brand', value: 'Any Reputed Brand (Tata/JCB/Komatsu)' });
    }

    // 2. Model
    if (lead.machine_model) {
      captured.push({ field: 'Model Requirement', key: 'machine_model', label: 'Model Requirement', value: lead.machine_model });
    } else {
      missing.push({ field: 'Model Requirement', key: 'machine_model', label: 'Model Requirement', hint: 'Clarify target model series' });
    }

    // 3. Tonnage
    if (lead.required_tonnage_class || lead.tonnage_class) {
      captured.push({ field: 'Tonnage Class', key: 'tonnage_class', label: 'Tonnage Class', value: lead.required_tonnage_class || lead.tonnage_class });
    } else {
      missing.push({ field: 'Tonnage Class', key: 'tonnage_class', label: 'Tonnage Class', hint: 'Ask required payload (e.g. 20-Ton)' });
    }

    // 4. Application
    if (lead.application_history) {
      captured.push({ field: 'Application Use Case', key: 'application_history', label: 'Application Use Case', value: lead.application_history });
    } else {
      missing.push({ field: 'Application Use Case', key: 'application_history', label: 'Application Use Case', hint: 'Determine canal, highway, or quarry project' });
    }

    // 5. Budget
    const budget = lead.buyer_budget_max_inr || lead.budget_max_inr || lead.price_raw;
    if (budget) {
      const displayBudget = typeof budget === 'number' ? `₹${(budget / 100000).toFixed(2)} Lakh` : String(budget);
      captured.push({ field: 'Maximum Budget', key: 'budget', label: 'Budget Ceiling', value: displayBudget });
    } else {
      missing.push({ field: 'Maximum Budget', key: 'budget', label: 'Budget Ceiling', hint: 'Establish buyer investment budget' });
    }

    // 6. Location
    const bLoc = lead.location_city || lead.machine_location_city || lead.delivery_location;
    if (bLoc) {
      captured.push({ field: 'Delivery Destination', key: 'location', label: 'Delivery Destination', value: bLoc });
    } else {
      missing.push({ field: 'Delivery Destination', key: 'location', label: 'Delivery Destination', hint: 'Confirm machine destination city/state' });
    }

    // 7. Purchase Timeline
    if (lead.purchase_timeline) {
      captured.push({ field: 'Purchase Timeline', key: 'purchase_timeline', label: 'Purchase Timeline', value: lead.purchase_timeline });
    } else {
      missing.push({ field: 'Purchase Timeline', key: 'purchase_timeline', label: 'Purchase Timeline', hint: 'Clarify buying urgency (immediate vs 30 days)' });
    }

    // 8. Used / Refurbished Preference
    if (lead.used_or_refurbished) {
      captured.push({ field: 'Used / Refurbished Tier', key: 'used_or_refurbished', label: 'Used / Refurbished Tier', value: lead.used_or_refurbished });
    } else {
      missing.push({ field: 'Used / Refurbished Tier', key: 'used_or_refurbished', label: 'Used / Refurbished Tier', hint: 'Check interest in certified refurbished yard stock' });
    }

    // 9. Yard Visit
    if (lead.yard_visit_agreed !== undefined) {
      captured.push({
        field: 'Yard Visit',
        key: 'yard_visit',
        label: 'Yard Visit',
        value: lead.yard_visit_agreed ? `Agreed (${lead.yard_visit_schedule || 'Scheduled'})` : 'Not yet agreed'
      });
    } else {
      missing.push({ field: 'Yard Visit', key: 'yard_visit', label: 'Yard Physical Visit', hint: 'Propose live machine trial at Jaipur yard' });
    }

    // 10. Requirement Status
    if (lead.qualification_state) {
      captured.push({ field: 'Requirement Status', key: 'qualification_state', label: 'Requirement Status', value: lead.qualification_state });
    } else {
      missing.push({ field: 'Requirement Status', key: 'qualification_state', label: 'Requirement Status', hint: 'Complete buyer qualification' });
    }
  }

  return { captured, missing };
}

function buildJourneyProgression(lead) {
  if (!lead) return { type: 'unknown', stages: [], current_stage: 'call_initial', current_index: 0 };
  const isSeller = lead.customer_type === 'seller';

  if (isSeller) {
    const stages = [
      { key: 'call_initial', id: 'CALL', label: 'Call' },
      { key: 'machine_details', id: 'MACHINE_DETAILS', label: 'Machine Details' },
      { key: 'application', id: 'APPLICATION', label: 'Application' },
      { key: 'condition', id: 'CONDITION', label: 'Condition' },
      { key: 'location', id: 'LOCATION', label: 'Location' },
      { key: 'documents', id: 'DOCUMENTS', label: 'Documents' },
      { key: 'asking_price', id: 'ASKING_PRICE', label: 'Asking Price' },
      { key: 'evidence_collection', id: 'EVIDENCE', label: 'Evidence' },
      { key: 'qualification', id: 'QUALIFICATION', label: 'Qualification' },
      { key: 'follow_up', id: 'FOLLOW_UP', label: 'Follow-up' },
      { key: 'buyer_matching', id: 'BUYER_MATCHING', label: 'Buyer Matching' },
      { key: 'negotiation', id: 'NEGOTIATION', label: 'Negotiation' },
      { key: 'inspection', id: 'INSPECTION', label: 'Inspection' },
      { key: 'deal_closing', id: 'DEAL', label: 'Deal' }
    ];

    let current = 'call_initial';
    // Priority status checks
    if (lead.current_status?.includes('RC/NOC') || lead.current_status?.includes('Waiting for') || (lead.lead_id === 'demo_lead_s01')) {
      current = 'evidence_collection';
    } else if (lead.lifecycle_stage === 'CLOSED_WON' || lead.lifecycle_stage === 'DEAL') {
      current = 'deal_closing';
    } else if (lead.lifecycle_stage === 'INSPECTION') {
      current = 'inspection';
    } else if (lead.lifecycle_stage === 'NEGOTIATION') {
      current = 'negotiation';
    } else if (lead.lifecycle_stage === 'BUYER_MATCHING') {
      current = 'buyer_matching';
    } else if (lead.follow_up_required) {
      current = 'follow_up';
    } else if (lead.qualification_state === 'QUALIFIED') {
      current = 'qualification';
    } else if (lead.expected_selling_price_inr || lead.price_raw) {
      current = 'asking_price';
    } else if (lead.location_city || lead.machine_location_city) {
      current = 'location';
    } else if (lead.machine_model) {
      current = 'machine_details';
    }

    const currentIndex = stages.findIndex((s) => s.key === current);
    const enrichedStages = stages.map((s, idx) => ({
      ...s,
      status: idx < currentIndex ? 'completed' : idx === currentIndex ? 'active' : 'pending'
    }));

    return { type: 'seller', stages: enrichedStages, current_stage: current, current_index: currentIndex };
  } else {
    const stages = [
      { key: 'call_initial', id: 'CALL', label: 'Call' },
      { key: 'machine_requirement', id: 'MACHINE_REQUIREMENT', label: 'Machine Requirement' },
      { key: 'brand_model', id: 'BRAND_MODEL', label: 'Brand / Model' },
      { key: 'tonnage', id: 'TONNAGE', label: 'Tonnage' },
      { key: 'application', id: 'APPLICATION', label: 'Application' },
      { key: 'budget', id: 'BUDGET', label: 'Budget' },
      { key: 'location', id: 'LOCATION', label: 'Location' },
      { key: 'timeline', id: 'TIMELINE', label: 'Timeline' },
      { key: 'qualification', id: 'QUALIFICATION', label: 'Qualification' },
      { key: 'matching', id: 'MATCHING', label: 'Matching' },
      { key: 'machine_options', id: 'MACHINE_OPTIONS', label: 'Machine Options' },
      { key: 'yard_visit', id: 'YARD_VISIT', label: 'Yard Visit' },
      { key: 'negotiation', id: 'NEGOTIATION', label: 'Negotiation' },
      { key: 'deal', id: 'DEAL', label: 'Deal' }
    ];

    let current = 'call_initial';
    if (lead.lifecycle_stage === 'CLOSED_WON' || lead.lifecycle_stage === 'DEAL') {
      current = 'deal';
    } else if (lead.lifecycle_stage === 'NEGOTIATION') {
      current = 'negotiation';
    } else if (lead.yard_visit_agreed) {
      current = 'yard_visit';
    } else if (lead.lead_id === 'demo_lead_b01' || lead.current_status?.includes('stock') || lead.current_status?.includes('matching')) {
      current = 'matching';
    } else if (lead.qualification_state === 'QUALIFIED') {
      current = 'matching';
    } else if (lead.purchase_timeline) {
      current = 'timeline';
    } else if (lead.buyer_budget_max_inr || lead.price_raw) {
      current = 'budget';
    } else if (lead.required_tonnage_class) {
      current = 'tonnage';
    } else if (lead.machine_brand || lead.machine_model) {
      current = 'brand_model';
    } else {
      current = 'machine_requirement';
    }

    const currentIndex = stages.findIndex((s) => s.key === current);
    const enrichedStages = stages.map((s, idx) => ({
      ...s,
      status: idx < currentIndex ? 'completed' : idx === currentIndex ? 'active' : 'pending'
    }));

    return { type: 'buyer', stages: enrichedStages, current_stage: current, current_index: currentIndex };
  }
}

function buildDefaultEvidenceChecklist(lead) {
  const rawEv = (lead && lead.evidence_checklist) ? lead.evidence_checklist : null;
  const photosAgreed = lead && lead.photos_agreed;
  const videoAgreed = lead && lead.running_video_agreed;
  const rcAgreed = lead && lead.rc_copy_agreed;

  const defaultDict = {
    boom_photo: {
      name: 'Boom structure photo',
      status: photosAgreed ? 'received' : 'pending',
      verified: false,
      note: photosAgreed ? 'Seller agreed to submit photos' : 'Evidence upload pending'
    },
    undercarriage_photo: {
      name: 'Undercarriage photo',
      status: photosAgreed ? 'received' : 'pending',
      verified: false,
      note: photosAgreed ? 'Seller agreed to submit photos' : 'Evidence upload pending'
    },
    cabin_photo: {
      name: 'Cabin & console photo',
      status: photosAgreed ? 'received' : 'pending',
      verified: false,
      note: photosAgreed ? 'Seller agreed to submit photos' : 'Evidence upload pending'
    },
    counterweight_photo: {
      name: 'Counterweight photo',
      status: photosAgreed ? 'received' : 'pending',
      verified: false,
      note: photosAgreed ? 'Seller agreed to submit photos' : 'Evidence upload pending'
    },
    hmr_photo: {
      name: 'Hour meter (HMR) photo',
      status: photosAgreed ? 'received' : 'pending',
      verified: false,
      note: photosAgreed ? 'Meter reading photo pending' : 'Evidence upload pending'
    },
    running_video: {
      name: '30s running & slew video',
      status: videoAgreed ? 'received' : 'pending',
      verified: false,
      note: videoAgreed ? 'Video promised on WhatsApp' : 'WhatsApp action pending integration'
    },
    rc_copy: {
      name: 'RC copy',
      status: rcAgreed ? 'received' : 'pending',
      verified: false,
      note: rcAgreed ? 'RC document promised' : 'Evidence upload pending'
    },
    finance_noc: {
      name: 'Clear finance NOC',
      status: 'pending',
      verified: false,
      note: 'Finance clearance pending verification'
    }
  };

  if (rawEv && typeof rawEv === 'object') {
    return Object.entries(defaultDict).map(([key, defItem]) => {
      const match = rawEv[key] || (key === 'finance_noc' ? (rawEv['noc_document'] || rawEv['finance_noc']) : null);
      return {
        key,
        name: match?.name || defItem.name,
        status: match?.status || defItem.status,
        verified: !!match?.verified,
        note: match?.note || defItem.note
      };
    });
  }

  return Object.entries(defaultDict).map(([key, defItem]) => ({
    key,
    ...defItem
  }));
}

async function getLead360(leadId, isDemo = false, organizationId = null) {
  if (!leadId) return null;
  const targetId = String(leadId).trim();

  if (isDemo) {
    const demo = loadDemoData();
    if (!demo) return null;

    const allLeads = [
      ...(demo.sellers || []).map((s) => ({ ...s, customer_type: 'seller' })),
      ...(demo.buyers || []).map((b) => ({ ...b, customer_type: 'buyer' })),
      ...(demo.inbound_leads || []),
      ...(demo.dnc_registry || []).map((d) => ({ ...d, customer_type: 'dnc', lead_temperature: 'COLD', qualification_state: 'UNQUALIFIED' }))
    ];

    const found = allLeads.find((l) =>
      String(l.lead_id) === targetId ||
      String(l.run_id) === targetId ||
      String(l.primary_phone) === targetId ||
      String(l.phone_number) === targetId
    );

    if (!found) return null;

    // Attach linked calls (multiple calls belonging to this lead)
    const linkedCalls = (demo.calls || []).filter((c) =>
      String(c.lead_id) === String(found.lead_id) ||
      String(c.primary_phone) === String(found.primary_phone || found.phone_number) ||
      String(c.run_id) === targetId
    );

    // Timeline retrieval
    let timeline = demo.lead_timelines ? demo.lead_timelines[found.lead_id] : null;
    if (!timeline) {
      timeline = await getLeadTimeline(found.lead_id || targetId, true);
    } else {
      timeline = timeline.map((e) => {
        const actorLower = (typeof e.actor === 'string' ? e.actor : (e.actor?.type || 'system')).toLowerCase();
        const actorLabel = e.actor_label || (typeof e.actor === 'object' && e.actor?.label) ||
          (actorLower === 'vaani' ? '🤖 VAANI' : actorLower === 'customer' ? '📞 CUSTOMER' : actorLower === 'operator' ? '👤 SALES OPERATOR' : '⚙️ SYSTEM');
        const dayVal = e.day || e.day_label || 'DAY 1';
        return {
          ...e,
          day: dayVal,
          day_label: dayVal.replace(/day/i, 'Day'),
          actor: actorLower,
          actor_label: actorLabel,
          customer_quote: e.customer_quote || null
        };
      });
    }

    const learned = buildExtractedVsMissing(found);
    const journey = buildJourneyProgression(found);
    const evidence = buildDefaultEvidenceChecklist(found);

    const isDnc = !!found.dnc_requested || found.customer_type === 'dnc';
    const dueTime = found.due_display || found.due_datetime || (found.follow_up_datetime ? new Date(found.follow_up_datetime).toLocaleDateString('en-GB') : 'Tomorrow, 11:00 AM');

    return {
      is_demo: true,
      lead_id: found.lead_id || targetId,
      customer_name: found.customer_name || found.caller_name || 'Customer',
      primary_phone: found.primary_phone || found.callback_number || found.phone_number || 'N/A',
      whatsapp_phone: found.whatsapp_phone || found.whatsapp_number || found.primary_phone || null,
      customer_type: isDnc ? 'dnc' : (found.customer_type || 'unknown'),
      lead_temperature: isDnc ? 'COLD' : (found.lead_temperature || 'WARM'),
      lifecycle_stage: found.lifecycle_stage || found.journey_stage || 'QUALIFIED',
      qualification_state: found.qualification_state || 'QUALIFIED',
      conversation_outcome: found.conversation_outcome || 'lead_qualified',
      current_status: found.current_status || (isDnc ? 'DNC Suppressed — Compliance Quarantine' : 'In active follow-up'),
      next_action: found.next_action || (isDnc ? 'DO NOT CALL — Quarantined Number' : 'Follow up with customer'),
      owner: found.owner || found.assigned_owner || 'Vaani / Sales Operator',
      due_datetime: dueTime,
      due_display: dueTime,
      follow_up_datetime: found.follow_up_datetime || null,
      call_count: linkedCalls.length || found.call_count || 1,
      last_activity: timeline && timeline.length ? timeline[timeline.length - 1].title : 'Inbound conversation logged',
      dnc_requested: isDnc,
      raw_lead: found,
      extracted_vs_missing: learned,
      what_vaani_learned: learned,
      journey_progression: Array.isArray(journey?.stages) ? journey.stages : (journey || []),
      sales_journey: journey,
      evidence_checklist: evidence,
      evidence_integration_note: found.evidence_integration_note || 'WhatsApp action pending integration — Evidence manually received and indexed',
      whatsapp: {
        status: 'DELIVERED',
        last_message: 'Photos and meter requested via WhatsApp',
        last_inbound: null,
        pending_requests: 0,
        history: [],
        is_dry_run: true,
        indicator: 'WHATSAPP: DRY RUN'
      },
      evidence_readiness: {
        required: ['BOOM_PHOTOS', 'UNDERCARRIAGE_PHOTOS', 'CABIN_GAUGES_PHOTO', 'COUNTERWEIGHT_PHOTO', 'HOUR_METER_PHOTO', 'RUNNING_VIDEO', 'RC_DOCUMENT'],
        received: ['CABIN_GAUGES_PHOTO', 'HOUR_METER_PHOTO'],
        verified: [],
        missing: ['BOOM_PHOTOS', 'UNDERCARRIAGE_PHOTOS', 'COUNTERWEIGHT_PHOTO', 'RUNNING_VIDEO', 'RC_DOCUMENT'],
        completion_percent: 28,
        status: 'PARTIAL'
      },
      linked_calls: linkedCalls,
      timeline
    };
  }

  if (!organizationId) return null;
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return null;

  // Real DB mode: query PostgreSQL workflow_runs and sales views scoped by organization
  try {
    const strippedId = targetId.startsWith('lead_') ? targetId.slice(5) : targetId;
    const isNum = /^\d+$/.test(strippedId);
    let whereClause = `((r.gathered_context -> 'extracted_variables') ->> 'callback_number' = $2 OR (r.gathered_context -> 'extracted_variables') ->> 'lead_id' = $2)`;
    let queryParams = [orgInt, String(targetId)];
    if (isNum) {
      whereClause = `(r.id = $2 OR (r.gathered_context -> 'extracted_variables') ->> 'callback_number' = $3 OR (r.gathered_context -> 'extracted_variables') ->> 'lead_id' = $3)`;
      queryParams = [orgInt, parseInt(strippedId, 10), String(targetId)];
    }

    const sql = `
      SELECT json_build_object(
        'runs', json_agg(json_build_object(
          'run_id', r.id,
          'created_at', r.created_at,
          'caller_name', (r.gathered_context -> 'extracted_variables') ->> 'caller_name',
          'callback_number', (r.gathered_context -> 'extracted_variables') ->> 'callback_number',
          'customer_type', COALESCE((r.gathered_context -> 'extracted_variables') ->> 'customer_type', 'unknown'),
          'machine_brand', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'brand', (r.gathered_context -> 'extracted_variables') ->> 'machine_brand'),
          'machine_model', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'model', (r.gathered_context -> 'extracted_variables') ->> 'machine_model'),
          'model_year', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'model_year')::integer, ((r.gathered_context -> 'extracted_variables') ->> 'model_year')::integer),
          'running_hours', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'running_hours')::integer, ((r.gathered_context -> 'extracted_variables') ->> 'running_hours')::integer),
          'application_history', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'application_history', (r.gathered_context -> 'extracted_variables') ->> 'application_history'),
          'location_city', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'location_city', (r.gathered_context -> 'extracted_variables') ->> 'location_city'),
          'location_state', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'location_state', (r.gathered_context -> 'extracted_variables') ->> 'location_state'),
          'expected_selling_price_inr', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'commercial_terms') ->> 'expected_price_inr')::bigint, ((r.gathered_context -> 'extracted_variables') ->> 'expected_selling_price_inr')::bigint, ((r.gathered_context -> 'extracted_variables') ->> 'expected_price_inr')::bigint),
          'buyer_budget_max_inr', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'commercial_terms') ->> 'budget_max_inr')::bigint, ((r.gathered_context -> 'extracted_variables') ->> 'buyer_budget_max_inr')::bigint, ((r.gathered_context -> 'extracted_variables') ->> 'budget_max_inr')::bigint),
          'price_raw', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'commercial_terms') ->> 'price_or_budget_raw', (r.gathered_context -> 'extracted_variables') ->> 'price_or_budget_raw', (r.gathered_context -> 'extracted_variables') ->> 'price_raw'),
          'yard_visit_agreed', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'commercial_terms') ->> 'yard_visit_agreed')::boolean, ((r.gathered_context -> 'extracted_variables') ->> 'yard_visit_agreed')::boolean, false),
          'lead_temperature', COALESCE((r.gathered_context -> 'extracted_variables') ->> 'lead_temperature', 'COLD'),
          'qualification_state', COALESCE((r.gathered_context -> 'extracted_variables') ->> 'qualification_state', 'UNQUALIFIED'),
          'conversation_outcome', (r.gathered_context -> 'extracted_variables') ->> 'conversation_outcome',
          'next_action', (r.gathered_context -> 'extracted_variables') ->> 'next_action',
          'follow_up_required', ((r.gathered_context -> 'extracted_variables') ->> 'follow_up_required')::boolean,
          'follow_up_datetime', (r.gathered_context -> 'extracted_variables') ->> 'follow_up_datetime',
          'dnc_requested', COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'dnc_requested')::boolean, false),
          'photos_agreed', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'evidence_readiness') ->> 'photos_agreed')::boolean, ((r.gathered_context -> 'extracted_variables') ->> 'photos_agreed')::boolean, false),
          'running_video_agreed', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'evidence_readiness') ->> 'running_video_agreed')::boolean, ((r.gathered_context -> 'extracted_variables') ->> 'running_video_agreed')::boolean, false),
          'rc_copy_agreed', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'evidence_readiness') ->> 'rc_copy_agreed')::boolean, ((r.gathered_context -> 'extracted_variables') ->> 'rc_copy_agreed')::boolean, false)
        ) ORDER BY r.id DESC)
      )
      FROM workflow_runs r
      JOIN workflows w ON r.workflow_id = w.id
      WHERE w.organization_id = $1 AND ${whereClause};
    `;

    const res = await queryPostgres(sql, queryParams);
    const runs = res && Array.isArray(res.runs) ? res.runs : [];
    if (runs.length === 0) return null;

    const latest = runs[0];
    const phone = latest.callback_number || targetId;

    // Fetch relational machine data strictly scoped by organization
    const machineSql = `
      SELECT row_to_json(m) FROM (
        SELECT machine_id, brand, model, manufacturing_year, hour_meter_reading,
               application_history, sourcing_cost_inr, target_resale_inr, status, current_location
        FROM vaani_machines
        WHERE organization_id = $1 AND source_lead_run_id = $2
        LIMIT 1
      ) m;
    `;
    const machineRow = await queryPostgres(machineSql, [orgInt, parseInt(latest.run_id, 10)]).catch(() => null);

    // Fetch relational digital evidence items strictly scoped by organization
    const evidenceSql = `
      SELECT json_agg(row_to_json(e)) FROM (
        SELECT evidence_id, media_type, media_url, evaluator_verdict, evaluator_notes, received_at
        FROM vaani_digital_evidence
        WHERE organization_id = $1 AND run_id = $2
        ORDER BY received_at ASC
      ) e;
    `;
    const evidenceRows = await queryPostgres(evidenceSql, [orgInt, parseInt(latest.run_id, 10)]).catch(() => null);

    const learned = buildExtractedVsMissing(latest);
    const journey = buildJourneyProgression(latest);
    let evidence = buildDefaultEvidenceChecklist(latest);

    if (Array.isArray(evidenceRows) && evidenceRows.length > 0) {
      const typeMap = {
        photo_boom: 'boom_photo',
        photo_undercarriage: 'undercarriage_photo',
        photo_cabin: 'cabin_photo',
        photo_meter: 'hmr_photo',
        video_running_30s: 'running_video',
        doc_rc: 'rc_copy',
        doc_noc: 'finance_noc'
      };
      evidence = evidence.map((item) => {
        const foundEv = evidenceRows.find((e) => typeMap[e.media_type] === item.key);
        if (foundEv) {
          return {
            ...item,
            status: foundEv.evaluator_verdict === 'approved' ? 'verified' : 'received',
            verified: foundEv.evaluator_verdict === 'approved',
            media_url: foundEv.media_url,
            note: foundEv.evaluator_notes || item.note
          };
        }
        return item;
      });
    }

    const timeline = await getLeadTimeline(targetId, false, orgInt);
    const isDnc = !!latest.dnc_requested || latest.customer_type === 'dnc';
    const dueTime = latest.follow_up_datetime || 'Tomorrow, 11:00 AM';

    const whatsappHistory = await vaaniWhatsapp.getLeadWhatsAppHistory(targetId, orgInt).catch(() => []);
    const fullEvidence = await vaaniWhatsapp.getLeadEvidence(targetId, orgInt).catch(() => []);
    const readiness = vaaniWhatsapp.calculateEvidenceReadiness(fullEvidence.length > 0 ? fullEvidence : (evidenceRows || []));

    const lastOutbound = (whatsappHistory || []).filter((m) => m.direction === 'OUTBOUND').slice(-1)[0] || null;
    const lastInbound = (whatsappHistory || []).filter((m) => m.direction === 'INBOUND').slice(-1)[0] || null;
    const pendingRequests = (whatsappHistory || []).filter((m) => ['QUEUED', 'SENDING', 'SENT'].includes(m.status)).length;

    return {
      is_demo: false,
      lead_id: phone || targetId,
      customer_name: latest.caller_name || 'Customer',
      primary_phone: phone,
      whatsapp_phone: phone,
      customer_type: isDnc ? 'dnc' : (latest.customer_type || 'unknown'),
      lead_temperature: latest.lead_temperature || 'WARM',
      lifecycle_stage: latest.qualification_state || 'NEW',
      qualification_state: latest.qualification_state || 'UNQUALIFIED',
      conversation_outcome: latest.conversation_outcome || 'inquiry',
      current_status: isDnc ? 'DNC Suppressed — Quarantined' : (latest.next_action ? 'Action in progress' : 'New lead received'),
      next_action: latest.next_action || (isDnc ? 'DO NOT CALL — Quarantined Number' : 'Initial qualification review'),
      owner: isDnc ? 'Compliance' : 'Vaani / Sales Operator',
      due_datetime: dueTime,
      due_display: dueTime,
      follow_up_datetime: latest.follow_up_datetime,
      call_count: runs.length,
      last_activity: timeline.length ? timeline[timeline.length - 1].title : 'Workflow session completed',
      dnc_requested: isDnc,
      raw_lead: latest,
      extracted_vs_missing: learned,
      what_vaani_learned: learned,
      journey_progression: Array.isArray(journey?.stages) ? journey.stages : (journey || []),
      sales_journey: journey,
      evidence_checklist: evidence,
      evidence_readiness: readiness,
      whatsapp: {
        status: lastOutbound ? lastOutbound.status : 'IDLE',
        last_message: lastOutbound ? (lastOutbound.body || lastOutbound.template_key) : null,
        last_inbound: lastInbound ? (lastInbound.body || lastInbound.message_type) : null,
        pending_requests: pendingRequests,
        history: whatsappHistory || [],
        is_dry_run: true,
        indicator: 'WHATSAPP: DRY RUN'
      },
      relational_machine: machineRow || null,
      relational_evidence: fullEvidence.length > 0 ? fullEvidence : (Array.isArray(evidenceRows) ? evidenceRows : []),
      evidence_integration_note: 'WhatsApp evidence engine active (DRY RUN) — Inspection media classified and indexed',
      linked_calls: runs.map((r) => ({
        run_id: r.run_id,
        created_at: r.created_at,
        customer_name: r.caller_name,
        primary_phone: r.callback_number,
        conversation_outcome: r.conversation_outcome,
        has_audio: false
      })),
      timeline
    };
  } catch (err) {
    console.error(`[VAANI SALES] Error in getLead360 for ${targetId}:`, err.message);
    return null;
  }
}

async function getLeadTimeline(leadId, isDemo = false, organizationId = null) {
  if (!leadId) return [];
  const targetId = String(leadId).trim();

  if (isDemo) {
    const demo = loadDemoData();
    if (!demo) return [];

    if (demo.lead_timelines && demo.lead_timelines[targetId]) {
      return demo.lead_timelines[targetId].map((e) => {
        const actorLower = (typeof e.actor === 'string' ? e.actor : (e.actor?.type || 'system')).toLowerCase();
        const actorLabel = e.actor_label || (typeof e.actor === 'object' && e.actor?.label) ||
          (actorLower === 'vaani' ? '🤖 VAANI' : actorLower === 'customer' ? '📞 CUSTOMER' : actorLower === 'operator' ? '👤 SALES OPERATOR' : '⚙️ SYSTEM');
        const dayVal = e.day || e.day_label || 'DAY 1';
        return {
          ...e,
          day: dayVal,
          day_label: dayVal.replace(/day/i, 'Day'),
          actor: actorLower,
          actor_label: actorLabel,
          customer_quote: e.customer_quote || null
        };
      });
    }

    const allLeads = [
      ...(demo.sellers || []),
      ...(demo.buyers || []),
      ...(demo.inbound_leads || []),
      ...(demo.dnc_registry || []).map((d) => ({ ...d, customer_type: 'dnc', dnc_requested: true }))
    ];
    const match = allLeads.find((l) => String(l.lead_id) === targetId || String(l.primary_phone) === targetId || String(l.phone_number) === targetId);
    if (!match) return [];

    const isSeller = match.customer_type === 'seller';
    const calls = (demo.calls || []).filter((c) => String(c.lead_id) === targetId || String(c.primary_phone) === String(match.primary_phone || match.phone_number));

    const events = [];
    const createdDate = calls.length ? new Date(calls[0].created_at) : (match.opted_out_at ? new Date(match.opted_out_at) : new Date());
    const formattedDate = createdDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

    events.push({
      id: `synth_${targetId}_01`,
      day: 'DAY 1',
      day_label: 'Day 1',
      timestamp: createdDate.toISOString(),
      formatted_time: `${formattedDate}, 10:00 AM`,
      activity_type: 'CALL_STARTED',
      actor: 'vaani',
      actor_label: '🤖 VAANI',
      title: 'Inbound Conversation Initiated',
      description: `Call received from ${match.primary_phone || match.phone_number} (${match.customer_name}).`
    });

    events.push({
      id: `synth_${targetId}_02`,
      day: 'DAY 1',
      day_label: 'Day 1',
      timestamp: new Date(createdDate.getTime() + 120000).toISOString(),
      formatted_time: `${formattedDate}, 10:02 AM`,
      activity_type: 'CALL_COMPLETED',
      actor: 'vaani',
      actor_label: '🤖 VAANI',
      title: 'Qualification Call Completed',
      description: `Outcome: ${match.conversation_outcome || 'lead_qualified'}. Customer identified as ${isSeller ? 'Machine Seller / Owner' : 'Excavator Buyer'}.`,
      customer_quote: match.call_notes || match.reason || null
    });

    if (match.dnc_requested) {
      events.push({
        id: `synth_${targetId}_dnc`,
        day: 'DAY 1',
        day_label: 'Day 1',
        timestamp: new Date(createdDate.getTime() + 150000).toISOString(),
        formatted_time: `${formattedDate}, 10:02 AM`,
        activity_type: 'DNC_REGISTERED',
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        title: 'Caller Opted Out — DNC Activated',
        description: 'Customer requested not to be contacted. Added to DNC compliance registry.'
      });
      return events;
    }

    events.push({
      id: `synth_${targetId}_03`,
      day: 'DAY 1',
      day_label: 'Day 1',
      timestamp: new Date(createdDate.getTime() + 180000).toISOString(),
      formatted_time: `${formattedDate}, 10:03 AM`,
      activity_type: 'INFORMATION_EXTRACTED',
      actor: 'vaani',
      actor_label: '🤖 VAANI',
      title: 'Specifications Extracted',
      description: isSeller
        ? `Machine: ${match.machine_brand || ''} ${match.machine_model || ''} (${match.model_year || ''}) | Hours: ${match.running_hours || 'N/A'} | Price: ${match.price_raw || 'N/A'}`
        : `Requirement: ${match.machine_brand || ''} ${match.required_tonnage_class || '20-Ton'} | Budget: ${match.price_raw || 'N/A'}`
    });

    events.push({
      id: `synth_${targetId}_04`,
      day: 'DAY 1',
      day_label: 'Day 1',
      timestamp: new Date(createdDate.getTime() + 240000).toISOString(),
      formatted_time: `${formattedDate}, 10:04 AM`,
      activity_type: 'LEAD_QUALIFIED',
      actor: 'vaani',
      actor_label: '🤖 VAANI',
      title: `Lead Qualified as ${match.lead_temperature || 'WARM'}`,
      description: `Lifecycle stage updated to ${match.lifecycle_stage || 'QUALIFIED'}.`
    });

    if (match.follow_up_required) {
      events.push({
        id: `synth_${targetId}_05`,
        day: 'DAY 2',
        day_label: 'Day 2',
        timestamp: new Date(createdDate.getTime() + 86400000).toISOString(),
        formatted_time: 'Next Day, 11:00 AM',
        activity_type: 'FOLLOW_UP_CREATED',
        actor: 'system',
        actor_label: '⚙️ SYSTEM',
        title: 'Follow-up Task Scheduled',
        description: `Action: ${match.next_action || 'Review and progress lead'}. Assigned to ${match.owner || 'Sales Operator'}.`
      });
    }

    return events;
  }

  // Real DB mode scoped by organization
  if (!organizationId) return [];
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return [];

  try {
    const strippedId = targetId.startsWith('lead_') ? targetId.slice(5) : targetId;
    const isNum = /^\d+$/.test(strippedId);
    let whereClause = `((r.gathered_context -> 'extracted_variables') ->> 'callback_number' = $2 OR (r.gathered_context -> 'extracted_variables') ->> 'lead_id' = $2)`;
    let queryParams = [orgInt, String(targetId)];
    if (isNum) {
      whereClause = `(r.id = $2 OR (r.gathered_context -> 'extracted_variables') ->> 'callback_number' = $3 OR (r.gathered_context -> 'extracted_variables') ->> 'lead_id' = $3)`;
      queryParams = [orgInt, parseInt(strippedId, 10), String(targetId)];
    }

    const sql = `
      SELECT json_agg(t) FROM (
        SELECT r.id, r.created_at,
               to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_time,
               (r.gathered_context -> 'extracted_variables') as vars
        FROM workflow_runs r
        JOIN workflows w ON r.workflow_id = w.id
        WHERE w.organization_id = $1 AND ${whereClause}
        ORDER BY r.id ASC
      ) t;
    `;

    const runs = await queryPostgres(sql, queryParams);
    if (!Array.isArray(runs) || runs.length === 0) return [];

    const events = [];
    runs.forEach((run, idx) => {
      const vars = run.vars || {};
      const dayLabel = `Day ${idx + 1}`;
      const baseTime = new Date(run.created_at).getTime();

      // 1. Call Started
      events.push({
        id: `run_${run.id}_start`,
        day: `DAY ${idx + 1}`,
        day_label: dayLabel,
        timestamp: new Date(baseTime).toISOString(),
        formatted_time: run.formatted_time,
        activity_type: 'CALL_STARTED',
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        title: `Inbound Call #${run.id} Started`,
        description: `Connected with ${vars.caller_name || 'caller'} from ${vars.callback_number || 'line'}.`
      });

      // 2. Call Connected
      events.push({
        id: `run_${run.id}_connected`,
        day: `DAY ${idx + 1}`,
        day_label: dayLabel,
        timestamp: new Date(baseTime + 10000).toISOString(),
        formatted_time: run.formatted_time,
        activity_type: 'CALL_CONNECTED',
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        title: `Audio Stream Connected`,
        description: `Caller audio active on line ${vars.callback_number || 'line'}. Conversational flow active.`
      });

      // 3. Information Extracted
      if (vars.machine_brand || vars.machine_model || vars.required_tonnage_class) {
        events.push({
          id: `run_${run.id}_extracted`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: new Date(baseTime + 30000).toISOString(),
          formatted_time: run.formatted_time,
          activity_type: 'INFORMATION_EXTRACTED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: 'Machine Data Extracted',
          description: `Brand: ${vars.machine_brand || 'N/A'} | Model: ${vars.machine_model || vars.required_tonnage_class || 'N/A'}`
        });
      }

      // 4. Commercial / Price Captured
      if (vars.expected_selling_price_inr || vars.buyer_budget_max_inr || vars.price_raw || (vars.commercial_terms && (vars.commercial_terms.expected_price_inr || vars.commercial_terms.budget_max_inr))) {
        const priceDisplay = vars.price_raw || (vars.commercial_terms && vars.commercial_terms.price_or_budget_raw) || vars.expected_selling_price_inr || vars.buyer_budget_max_inr || 'Disclosed';
        events.push({
          id: `run_${run.id}_price`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: new Date(baseTime + 45000).toISOString(),
          formatted_time: run.formatted_time,
          activity_type: 'PRICE_CAPTURED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: 'Commercial Terms Captured',
          description: `Price/Budget expectations captured: ${priceDisplay}.`
        });
      }

      // 5. Lead Qualified
      if (vars.qualification_state) {
        events.push({
          id: `run_${run.id}_qual`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: new Date(baseTime + 60000).toISOString(),
          formatted_time: run.formatted_time,
          activity_type: 'LEAD_QUALIFIED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: `Lead Qualified as ${vars.lead_temperature || 'WARM'}`,
          description: `State: ${vars.qualification_state}. Next action: ${vars.next_action || 'Follow up'}`
        });
      }

      // 6. Temperature Scored / Changed
      if (vars.lead_temperature && vars.lead_temperature !== 'COLD') {
        events.push({
          id: `run_${run.id}_temp`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: new Date(baseTime + 75000).toISOString(),
          formatted_time: run.formatted_time,
          activity_type: 'TEMPERATURE_CHANGED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: `Lead Priority: ${vars.lead_temperature}`,
          description: `Commercial priority assessed as ${vars.lead_temperature}.`
        });
      }

      // 7. Follow-up Scheduled
      if (vars.follow_up_required) {
        events.push({
          id: `run_${run.id}_followup`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: new Date(baseTime + 90000).toISOString(),
          formatted_time: run.formatted_time,
          activity_type: 'FOLLOW_UP_CREATED',
          actor: 'system',
          actor_label: '⚙️ SYSTEM',
          title: 'Follow-up Task Scheduled',
          description: `Action: ${vars.next_action || 'Follow up with lead'}. Scheduled for ${vars.follow_up_datetime || 'Tomorrow, 11:00 AM'}.`
        });
      }

      // 8. Call Completed
      events.push({
        id: `run_${run.id}_done`,
        day: `DAY ${idx + 1}`,
        day_label: dayLabel,
        timestamp: new Date(baseTime + 120000).toISOString(),
        formatted_time: run.formatted_time,
        activity_type: 'CALL_COMPLETED',
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        title: `Call #${run.id} Completed`,
        description: `Outcome: ${vars.conversation_outcome || 'inquiry'}. Customer type: ${vars.customer_type || 'unknown'}.`,
        customer_quote: vars.call_notes || null
      });

      // 9. DNC Opt-Out (if requested)
      if (vars.dnc_requested) {
        events.push({
          id: `run_${run.id}_dnc`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: new Date(baseTime + 130000).toISOString(),
          formatted_time: run.formatted_time,
          activity_type: 'DNC_REGISTERED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: 'DNC Request Registered',
          description: 'Caller requested not to be contacted. Number quarantined.'
        });
      }
    });

    // Append persistent follow-up tasks from vaani_follow_up_tasks
    try {
      const taskSql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT task_id, task_type, title, description, priority, status, assigned_to, due_at,
                 created_at, completed_at, completed_by, reason,
                 to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_created,
                 to_char(completed_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_completed
          FROM public.vaani_follow_up_tasks
          WHERE organization_id = $1 AND (lead_id = $2 OR lead_id = ('lead_' || $2) OR source_call_id = $3)
          ORDER BY created_at ASC
        ) t;
      `;
      const callIdParam = isNum ? parseInt(targetId, 10) : -1;
      const tasks = await queryPostgres(taskSql, [orgInt, String(targetId), callIdParam]);
      if (Array.isArray(tasks)) {
        tasks.forEach((t) => {
          events.push({
            id: `timeline_${t.task_id}_created`,
            day: 'FOLLOW-UP',
            day_label: 'Follow-up',
            timestamp: t.created_at,
            formatted_time: t.formatted_created,
            activity_type: 'FOLLOW_UP_CREATED',
            actor: 'system',
            actor_label: '⚙️ TASK ENGINE',
            title: `Task Created: ${t.title}`,
            description: `Type: ${t.task_type} | Priority: ${t.priority} | Assigned: ${t.assigned_to || 'Sales Operator'}`
          });
          if (t.status === 'IN_PROGRESS') {
            events.push({
              id: `timeline_${t.task_id}_progress`,
              day: 'FOLLOW-UP',
              day_label: 'Follow-up',
              timestamp: new Date(new Date(t.created_at).getTime() + 60000).toISOString(),
              formatted_time: t.formatted_created,
              activity_type: 'FOLLOW_UP_STARTED',
              actor: 'operator',
              actor_label: '👤 SALES OPERATOR',
              title: `Task Started: ${t.title}`,
              description: `Operator initiated action on ${t.task_type}.`
            });
          } else if (t.status === 'COMPLETED') {
            events.push({
              id: `timeline_${t.task_id}_done`,
              day: 'FOLLOW-UP',
              day_label: 'Follow-up',
              timestamp: t.completed_at || t.created_at,
              formatted_time: t.formatted_completed || t.formatted_created,
              activity_type: 'FOLLOW_UP_COMPLETED',
              actor: 'operator',
              actor_label: '👤 ' + (t.completed_by || 'SALES OPERATOR'),
              title: `Task Completed: ${t.title}`,
              description: `Completed by ${t.completed_by || 'Sales Operator'}.`
            });
          } else if (t.status === 'SKIPPED') {
            events.push({
              id: `timeline_${t.task_id}_skipped`,
              day: 'FOLLOW-UP',
              day_label: 'Follow-up',
              timestamp: t.completed_at || t.created_at,
              formatted_time: t.formatted_completed || t.formatted_created,
              activity_type: 'FOLLOW_UP_SKIPPED',
              actor: 'operator',
              actor_label: '👤 ' + (t.completed_by || 'SALES OPERATOR'),
              title: `Task Skipped: ${t.title}`,
              description: `Marked skipped by ${t.completed_by || 'Sales Operator'}.`
            });
          } else if (t.status === 'CANCELLED') {
            events.push({
              id: `timeline_${t.task_id}_cancelled`,
              day: 'FOLLOW-UP',
              day_label: 'Follow-up',
              timestamp: t.completed_at || t.created_at,
              formatted_time: t.formatted_completed || t.formatted_created,
              activity_type: 'FOLLOW_UP_CANCELLED',
              actor: 'system',
              actor_label: '⚙️ SYSTEM',
              title: `Task Cancelled: ${t.title}`,
              description: `Cancelled.`
            });
          }
        });
      }
    } catch (taskTimelineErr) {
      console.warn('[VAANI SALES] Notice loading task timeline:', taskTimelineErr.message);
    }

    // Append WhatsApp messages from vaani_whatsapp_messages
    try {
      const waSql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT message_id, COALESCE(direction, 'OUTBOUND') as direction, message_type, template_key, body, status, provider,
                 provider_message_id, created_at, sent_at, delivered_at, read_at, failed_at, error_message,
                 to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_created
          FROM public.vaani_whatsapp_messages
          WHERE organization_id = $1 AND (lead_id = $2 OR lead_id = ('lead_' || $2) OR phone_number = $2)
          ORDER BY created_at ASC
        ) t;
      `;
      const waMessages = await queryPostgres(waSql, [orgInt, String(targetId)]);
      if (Array.isArray(waMessages)) {
        waMessages.forEach((m) => {
          const isOut = m.direction !== 'INBOUND';
          let actType = 'WHATSAPP_MESSAGE_QUEUED';
          let title = `WhatsApp: ${m.template_key || m.message_type}`;
          let actor = isOut ? 'vaani' : 'customer';
          let actorLabel = isOut ? '🤖 VAANI' : '📞 CUSTOMER';
          let timeVal = m.created_at;

          if (m.status === 'SENT') {
            actType = 'WHATSAPP_MESSAGE_SENT';
            timeVal = m.sent_at || m.created_at;
          } else if (m.status === 'DELIVERED') {
            actType = 'WHATSAPP_MESSAGE_DELIVERED';
            timeVal = m.delivered_at || m.sent_at || m.created_at;
          } else if (m.status === 'READ') {
            actType = 'WHATSAPP_MESSAGE_READ';
            timeVal = m.read_at || m.delivered_at || m.created_at;
          } else if (m.status === 'FAILED') {
            actType = 'WHATSAPP_MESSAGE_FAILED';
            actor = 'system';
            actorLabel = '⚙️ SYSTEM';
            timeVal = m.failed_at || m.created_at;
          }

          events.push({
            id: `timeline_wa_${m.message_id}`,
            day: 'WHATSAPP',
            day_label: 'WhatsApp',
            timestamp: timeVal,
            formatted_time: m.formatted_created,
            activity_type: actType,
            actor: actor,
            actor_label: actorLabel,
            title: title,
            description: m.body || `WhatsApp message [${m.status}]`,
            error_message: m.error_message || null,
            provider_message_id: m.provider_message_id || null
          });
        });
      }
    } catch (waTimelineErr) {
      console.warn('[VAANI SALES] Notice loading WhatsApp timeline:', waTimelineErr.message);
    }

    // Append Digital Evidence events
    try {
      const callIdParam = isNum ? parseInt(targetId, 10) : -1;
      const evSql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT evidence_id, evidence_type, status, source, provider_message_id,
                 media_url, evaluator_verdict, evaluator_notes, received_at, verified_at, verified_by, metadata,
                 to_char(received_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_received,
                 to_char(verified_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_verified
          FROM public.vaani_digital_evidence
          WHERE organization_id = $1 AND (lead_id = $2 OR lead_id = ('lead_' || $2) OR run_id = $3)
          ORDER BY received_at ASC
        ) t;
      `;
      const evItems = await queryPostgres(evSql, [orgInt, String(targetId), callIdParam]);
      if (Array.isArray(evItems)) {
        evItems.forEach((ev) => {
          if (ev.status === 'RECEIVED') {
            events.push({
              id: `timeline_ev_${ev.evidence_id}_recv`,
              day: 'EVIDENCE',
              day_label: 'Evidence',
              timestamp: ev.received_at,
              formatted_time: ev.formatted_received,
              activity_type: 'EVIDENCE_RECEIVED',
              actor: 'customer',
              actor_label: '📞 CUSTOMER',
              title: `Evidence Received: ${ev.evidence_type}`,
              description: `Media received via ${ev.source || 'WhatsApp'}. URL/Ref: ${ev.media_url || 'N/A'}`
            });
            if (ev.metadata && ev.metadata.classified) {
              events.push({
                id: `timeline_ev_${ev.evidence_id}_class`,
                day: 'EVIDENCE',
                day_label: 'Evidence',
                timestamp: new Date(new Date(ev.received_at).getTime() + 1000).toISOString(),
                formatted_time: ev.formatted_received,
                activity_type: 'EVIDENCE_CLASSIFIED',
                actor: 'system',
                actor_label: '⚙️ EVIDENCE ENGINE',
                title: `Evidence Classified: ${ev.evidence_type}`,
                description: `Media classified as ${ev.evidence_type} (Confidence: ${ev.metadata.confidence || 0.95})`
              });
            }
          } else if (ev.status === 'VERIFIED') {
            events.push({
              id: `timeline_ev_${ev.evidence_id}_verif`,
              day: 'EVIDENCE',
              day_label: 'Evidence',
              timestamp: ev.verified_at || ev.received_at,
              formatted_time: ev.formatted_verified || ev.formatted_received,
              activity_type: 'EVIDENCE_VERIFIED',
              actor: 'operator',
              actor_label: '👤 ' + (ev.verified_by || 'SALES OPERATOR'),
              title: `Evidence Verified: ${ev.evidence_type}`,
              description: `Verified by ${ev.verified_by || 'Sales Operator'}. Notes: ${ev.evaluator_notes || 'All checks passed'}`
            });
          }
        });
      }
    } catch (evTimelineErr) {
      console.warn('[VAANI SALES] Notice loading evidence timeline:', evTimelineErr.message);
    }

    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return events;
  } catch (err) {
    console.error(`[VAANI SALES] Error generating timeline for ${targetId}:`, err.message);
    return [];
  }
}

async function getRecentActivities(limit = 15, isDemo = false, organizationId = null) {
  if (isDemo) {
    const demo = loadDemoData();
    return demo ? (demo.recent_activities || []).slice(0, limit) : [];
  }

  if (!organizationId) return [];
  const orgInt = parseInt(organizationId, 10);
  const limitInt = parseInt(limit, 10) || 15;
  if (isNaN(orgInt) || orgInt <= 0) return [];

  try {
    const sql = `
      SELECT json_agg(t) FROM (
        SELECT r.id AS run_id,
               r.created_at,
               to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'hh12:MI AM') as formatted_time,
               COALESCE((r.gathered_context -> 'extracted_variables') ->> 'caller_name', 'Caller') as caller_name,
               COALESCE((r.gathered_context -> 'extracted_variables') ->> 'callback_number', 'Line') as callback_number,
               (r.gathered_context -> 'extracted_variables') ->> 'customer_type' as customer_type,
               (r.gathered_context -> 'extracted_variables') ->> 'machine_brand' as machine_brand,
               (r.gathered_context -> 'extracted_variables') ->> 'machine_model' as machine_model,
               (r.gathered_context -> 'extracted_variables') ->> 'conversation_outcome' as conversation_outcome,
               (r.gathered_context -> 'extracted_variables') ->> 'lead_temperature' as lead_temperature,
               COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'dnc_requested')::boolean, false) as dnc_requested
        FROM workflow_runs r
        JOIN workflows w ON r.workflow_id = w.id
        WHERE w.organization_id = $1
        ORDER BY r.id DESC
        LIMIT $2
      ) t;
    `;

    const runs = await queryPostgres(sql, [orgInt, limitInt]);
    if (!Array.isArray(runs) || runs.length === 0) return [];

    return runs.map((r, idx) => {
      let actType = 'CALL_COMPLETED';
      let title = `Vaani completed call with ${r.caller_name}`;
      let desc = `${r.machine_brand || ''} ${r.machine_model || 'Excavator'} — Outcome: ${r.conversation_outcome || 'inquiry'}`;
      let badge = 'badge-qualified';

      if (r.dnc_requested) {
        actType = 'DNC_REGISTERED';
        title = `DNC Suppressed: ${r.callback_number}`;
        desc = 'Caller requested opt-out. Quarantined in compliance registry.';
        badge = 'badge-danger';
      } else if (r.lead_temperature === 'HOT') {
        badge = 'badge-hot';
      }

      return {
        id: `real_act_${r.run_id}_${idx}`,
        run_id: r.run_id,
        activity_id: `real_act_${r.run_id}_${idx}`,
        lead_id: r.run_id,
        timestamp: r.created_at,
        formatted_time: r.formatted_time,
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        activity_type: actType,
        title,
        description: desc,
        badge_class: badge
      };
    });
  } catch (err) {
    console.error('[VAANI SALES] Error querying recent activities:', err.message);
    return [];
  }
}

/* ============================================================================
 * Phase F: Production Call Lifecycle Engine, Qualification, and Idempotency
 * ============================================================================ */

const CALL_STATUSES = Object.freeze({
  INITIATED: 'INITIATED',
  CONNECTED: 'CONNECTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

/**
 * 3-Dimension Deterministic Qualification Gate:
 * Dimension 1: Target specification (Brand & Model for seller, Tonnage/Brand for buyer)
 * Dimension 2: Commercial parameter (Expected price for seller, Budget max for buyer)
 * Dimension 3: Geographic parameter (City/State identified)
 */
function evaluateQualification(customerType, machDetails = {}, commTerms = {}, city = null, dncRequested = false) {
  if (dncRequested) return 'DISQUALIFIED';

  let hasSpec = false;
  let hasComm = false;
  let hasGeo = Boolean(city && typeof city === 'string' && city.trim() && city.toLowerCase() !== 'unknown');

  if (customerType === 'seller') {
    hasSpec = Boolean(machDetails.brand && machDetails.model);
    hasComm = Boolean(
      (typeof commTerms.expected_price_inr === 'number' && commTerms.expected_price_inr > 0) ||
      (commTerms.price_or_budget_raw && String(commTerms.price_or_budget_raw).trim())
    );
  } else if (customerType === 'buyer') {
    hasSpec = Boolean(
      machDetails.brand ||
      (machDetails.tonnage_class && machDetails.tonnage_class !== 'unknown' && machDetails.tonnage_class !== 'any') ||
      machDetails.model
    );
    hasComm = Boolean(
      (typeof commTerms.budget_max_inr === 'number' && commTerms.budget_max_inr > 0) ||
      (commTerms.price_or_budget_raw && String(commTerms.price_or_budget_raw).trim())
    );
  } else {
    return 'UNQUALIFIED';
  }

  const dimensionsCount = (hasSpec ? 1 : 0) + (hasComm ? 1 : 0) + (hasGeo ? 1 : 0);
  if (dimensionsCount === 3) return 'QUALIFIED';
  if (dimensionsCount >= 1) return 'PARTIALLY_QUALIFIED';
  return 'UNQUALIFIED';
}

/**
 * Deterministic Lead Temperature Engine grounded in SELLER-BUYER-SCHEMAS.md
 */
function evaluateLeadTemperature(customerType, qualState, machDetails = {}, commTerms = {}, evReadiness = {}, dncRequested = false) {
  if (dncRequested) return 'COLD';
  if (qualState === 'DISQUALIFIED' || qualState === 'UNQUALIFIED') return 'COLD';

  if (customerType === 'seller') {
    const isCleanApp = !machDetails.application_history || machDetails.application_history === 'soil_earthwork';
    const hasMedia = Boolean(evReadiness.photos_agreed || evReadiness.running_video_agreed);
    const price = commTerms.expected_price_inr;
    const year = machDetails.model_year;

    let priceRealistic = true;
    if (typeof price === 'number' && typeof year === 'number') {
      if (year <= 2017 && price > 2500000) priceRealistic = false;
      else if (year <= 2020 && price > 3000000) priceRealistic = false;
    }

    if (qualState === 'QUALIFIED' && isCleanApp && hasMedia && priceRealistic) {
      return 'HOT';
    }
    if (qualState === 'QUALIFIED' || (qualState === 'PARTIALLY_QUALIFIED' && hasMedia)) {
      return 'WARM';
    }
    return 'COLD';
  }

  if (customerType === 'buyer') {
    if (qualState !== 'QUALIFIED') return 'COLD';

    const timeline = commTerms.purchase_timeline;
    const urgentTimeline = timeline === 'immediate_within_7_days' || timeline === 'immediate' || timeline === 'urgent' || timeline === 'within_15_30_days';
    const yardVisit = Boolean(commTerms.yard_visit_agreed);

    if (urgentTimeline || yardVisit) {
      return 'HOT';
    }
    return 'WARM';
  }

  return 'COLD';
}

/**
 * Next Action Engine producing explicit operational tasks grounded in conversation context
 */
function evaluateNextAction(customerType, qualState, temp, commTerms = {}, evReadiness = {}, dncRequested = false, existingAction = null) {
  if (dncRequested) return 'DNC_SUPPRESS';

  if (customerType === 'seller') {
    if (evReadiness.photos_agreed === false) return 'WAITING_FOR_MACHINE_PHOTOS';
    if (evReadiness.running_video_agreed === false) return 'WAITING_FOR_RUNNING_VIDEO';
    if (evReadiness.rc_copy_agreed === false) return 'WAITING_FOR_RC_NOC';
    if (temp === 'WARM') return 'NEGOTIATION_FOLLOW_UP';
    if (qualState === 'QUALIFIED') return 'FOLLOW_UP_WITH_SELLER';
    return existingAction || 'NO_ACTION_REQUIRED';
  }

  if (customerType === 'buyer') {
    if (commTerms.yard_visit_agreed) return 'SCHEDULE_YARD_VISIT';
    if (qualState === 'QUALIFIED') return 'MATCH_BUYER';
    if (qualState === 'PARTIALLY_QUALIFIED') return 'SEND_MACHINE_OPTIONS';
    return existingAction || 'NO_ACTION_REQUIRED';
  }

  return existingAction || 'NO_ACTION_REQUIRED';
}

/**
 * Follow-up Task & Handoff Scheduler
 */
function evaluateFollowUp(extractedVariables, payload = {}) {
  const isDnc = Boolean(extractedVariables.dnc_requested);
  if (isDnc) {
    return {
      follow_up_required: false,
      follow_up_datetime: null,
      follow_up_reason: 'DNC requested — suppression active',
      assigned_to: 'Compliance'
    };
  }

  const explicitRequired = payload.follow_up_required ?? extractedVariables.follow_up_required;
  const outcome = extractedVariables.conversation_outcome;
  const qual = extractedVariables.qualification_state;
  const nextAct = extractedVariables.next_action;

  const requiresFollowUp = Boolean(
    explicitRequired ||
    outcome === 'callback_requested' ||
    outcome === 'appointment_requested' ||
    outcome === 'lead_qualified' ||
    qual === 'QUALIFIED' ||
    (nextAct && !['NO_ACTION_REQUIRED', 'DNC_SUPPRESS'].includes(nextAct))
  );

  let due = payload.follow_up_datetime || extractedVariables.follow_up_datetime;
  if (requiresFollowUp && !due) {
    const nextDate = new Date(Date.now() + 86400000);
    nextDate.setHours(11, 0, 0, 0);
    due = nextDate.toISOString();
  }

  let reason = 'Review and progress lead';
  if (outcome === 'callback_requested') reason = 'Customer requested callback';
  else if (nextAct === 'WAITING_FOR_MACHINE_PHOTOS') reason = 'Verify machine photos on WhatsApp';
  else if (nextAct === 'WAITING_FOR_RUNNING_VIDEO') reason = 'Verify 30s operational running video';
  else if (nextAct === 'SCHEDULE_YARD_VISIT') reason = 'Coordinate Jaipur yard physical inspection';
  else if (nextAct === 'NEGOTIATION_FOLLOW_UP') reason = 'Commercial terms and price negotiation';
  else if (nextAct === 'MATCH_BUYER') reason = 'Match buyer requirement with available yard stock';

  return {
    follow_up_required: requiresFollowUp,
    follow_up_datetime: due,
    follow_up_reason: reason,
    assigned_to: 'Vaani / Sales Operator'
  };
}

/**
 * Clean Call Session Model Builder
 */
function createCallSession({
  runId,
  leadId,
  orgId,
  workflowId = 3,
  phone,
  customerType,
  direction = 'inbound',
  startedAt,
  connectedAt,
  endedAt,
  duration = 0,
  transcript = null,
  extractedVariables,
  qualificationState,
  leadTemperature,
  outcome,
  nextAction,
  followUp,
  status = CALL_STATUSES.COMPLETED,
  errorCode = null,
  errorMessage = null
}) {
  return {
    call_session_id: `sess_run_${runId}`,
    lead_id: leadId,
    organization_id: orgId,
    workflow_id: workflowId,
    customer_id: phone,
    direction: direction || 'inbound',
    seller_or_buyer: customerType,
    started_at: startedAt || new Date().toISOString(),
    connected_at: connectedAt || startedAt || new Date().toISOString(),
    ended_at: endedAt || new Date().toISOString(),
    duration: typeof duration === 'number' ? duration : 0,
    transcript: transcript || null,
    extracted_variables: extractedVariables,
    qualification_state: qualificationState,
    lead_temperature: leadTemperature,
    outcome: outcome || 'inquiry',
    next_action: nextAction,
    follow_up_datetime: followUp.follow_up_datetime,
    follow_up_reason: followUp.follow_up_reason,
    assigned_to: followUp.assigned_to,
    status: status || CALL_STATUSES.COMPLETED,
    error_code: errorCode,
    error_message: errorMessage
  };
}

/**
 * Ingest completed call payload from Vaani voice pipeline with full ACID transaction,
 * idempotent deduplication, deterministic lifecycle state transitions, and strict tenant security.
 */
async function ingestCallComplete(payload) {
  if (!payload || typeof payload !== 'object') {
    const err = new Error('Payload must be a valid JSON object');
    err.statusCode = 400;
    err.code = 'invalid_payload';
    err.errorCode = 'INVALID_PAYLOAD';
    throw err;
  }

  const phone = (payload.primary_phone || payload.callback_number || '').trim();
  if (!phone || phone.length < 8) {
    const err = new Error('Missing or invalid primary_phone (+91XXXXXXXXXX)');
    err.statusCode = 400;
    err.code = 'missing_primary_phone';
    err.errorCode = 'INVALID_PAYLOAD';
    throw err;
  }

  const callMeta = payload.call_metadata || {};
  const runId = callMeta.run_id ?? payload.run_id ?? payload.call_session_id;
  if (runId === undefined || runId === null || isNaN(Number(runId))) {
    const err = new Error('Missing or invalid call_metadata.run_id (integer required)');
    err.statusCode = 400;
    err.code = 'missing_run_id';
    err.errorCode = 'INVALID_PAYLOAD';
    throw err;
  }

  const numericRunId = parseInt(runId, 10);
  const wfId = parseInt(callMeta.workflow_id || payload.workflow_id || 3, 10);

  let orgId = callMeta.org_id ? parseInt(callMeta.org_id, 10) : null;
  if (!orgId) {
    const wfRow = await queryPostgres(`SELECT row_to_json(w) FROM (SELECT organization_id FROM workflows WHERE id = ${sqlEscapeInt(wfId)}) w;`);
    orgId = wfRow && wfRow.organization_id ? parseInt(wfRow.organization_id, 10) : null;
  }
  if (!orgId) {
    const err = new Error('Cannot determine organization_id for call ingestion');
    err.statusCode = 400;
    err.code = 'missing_organization_id';
    err.errorCode = 'MISSING_TENANT';
    throw err;
  }

  // Idempotency check: verify if run already exists in database
  const existingRun = await queryPostgres(
    `SELECT row_to_json(r) FROM (SELECT id, is_completed, state FROM workflow_runs WHERE id = ${sqlEscapeInt(numericRunId)}) r;`
  ).catch(() => null);

  const isDuplicate = Boolean(existingRun && (existingRun.is_completed || existingRun.state === 'completed'));

  const leadId = payload.lead_id || `lead_${numericRunId}`;
  let customerType = ['seller', 'buyer', 'other', 'unknown'].includes(payload.customer_type)
    ? payload.customer_type
    : 'unknown';

  const machDetails = { ...(payload.machine_details || {}) };
  if (!machDetails.brand && payload.machine_brand) machDetails.brand = payload.machine_brand;
  if (!machDetails.model && payload.machine_model) machDetails.model = payload.machine_model;
  if (machDetails.model_year === undefined && payload.model_year !== undefined) machDetails.model_year = payload.model_year;
  if (machDetails.running_hours === undefined && payload.running_hours !== undefined) machDetails.running_hours = payload.running_hours;

  // Normalize machine model early using canonical taxonomy
  const rawMachineQuery = [machDetails.brand, machDetails.model].filter(Boolean).join(' ');
  if (rawMachineQuery) {
    const match = vaaniExtractor.matchMachineModel(rawMachineQuery);
    if (match) {
      if (match.brand) machDetails.brand = match.brand;
      if (match.model) machDetails.model = match.model;
      if (match.tonnage_class && match.tonnage_class !== 'unknown') machDetails.tonnage_class = match.tonnage_class;
    }
  }

  if (customerType === 'unknown' && (machDetails.brand || machDetails.model)) {
    customerType = 'seller';
  }

  const commTerms = payload.commercial_terms || {};
  const evReadiness = payload.evidence_readiness || {};

  // Phase F Step 2: Auto-extract from conversation if transcript is present
  let extractionAudit = null;
  if (payload.transcript || payload.conversation) {
    const extractionResult = vaaniExtractor.extractFromConversation(payload.transcript || payload.conversation);
    extractionAudit = {
      provenance: extractionResult.provenance,
      missing_info: extractionResult.missing_info,
      correction_history: extractionResult.correction_history,
      follow_up_question: extractionResult.follow_up_question
    };

    if (customerType === 'unknown' && extractionResult.extracted.customer_type !== 'unknown') {
      customerType = extractionResult.extracted.customer_type;
    }

    const extMach = extractionResult.extracted.machine_details;
    if (!machDetails.brand && extMach.brand) machDetails.brand = extMach.brand;
    if (!machDetails.model && extMach.model) machDetails.model = extMach.model;
    if (machDetails.model_year === undefined && extMach.model_year) machDetails.model_year = extMach.model_year;
    if (machDetails.running_hours === undefined && extMach.running_hours) machDetails.running_hours = extMach.running_hours;
    if ((!machDetails.tonnage_class || machDetails.tonnage_class === 'unknown') && extMach.tonnage_class !== 'unknown') machDetails.tonnage_class = extMach.tonnage_class;
    if ((!machDetails.application_history || machDetails.application_history === 'unknown') && extMach.application_history !== 'unknown') machDetails.application_history = extMach.application_history;
    if (!machDetails.location_city && extMach.location_city) machDetails.location_city = extMach.location_city;
    if (!machDetails.location_state && extMach.location_state) machDetails.location_state = extMach.location_state;
    if ((!machDetails.document_status || machDetails.document_status === 'unknown') && extMach.document_status !== 'unknown') machDetails.document_status = extMach.document_status;

    const extComm = extractionResult.extracted.commercial_terms;
    if (commTerms.expected_price_inr === undefined && extComm.expected_price_inr) commTerms.expected_price_inr = extComm.expected_price_inr;
    if (commTerms.budget_max_inr === undefined && extComm.budget_max_inr) commTerms.budget_max_inr = extComm.budget_max_inr;
    if (!commTerms.price_or_budget_raw && extComm.price_or_budget_raw) commTerms.price_or_budget_raw = extComm.price_or_budget_raw;
    if ((!commTerms.purchase_timeline || commTerms.purchase_timeline === 'not_applicable') && extComm.purchase_timeline !== 'not_applicable') commTerms.purchase_timeline = extComm.purchase_timeline;
    if (commTerms.yard_visit_agreed === undefined && extComm.yard_visit_agreed) commTerms.yard_visit_agreed = extComm.yard_visit_agreed;

    const extEv = extractionResult.extracted.evidence_readiness;
    if (evReadiness.photos_agreed === undefined && extEv.photos_agreed) evReadiness.photos_agreed = extEv.photos_agreed;
    if (evReadiness.running_video_agreed === undefined && extEv.running_video_agreed) evReadiness.running_video_agreed = extEv.running_video_agreed;
    if (evReadiness.rc_copy_agreed === undefined && extEv.rc_copy_agreed) evReadiness.rc_copy_agreed = extEv.rc_copy_agreed;

    if (extractionResult.extracted.dnc_requested) {
      payload.dnc_requested = true;
    }
  }

  const modelYear = (typeof machDetails.model_year === 'number' && machDetails.model_year >= 2005 && machDetails.model_year <= 2026)
    ? machDetails.model_year
    : null;

  const validAppHistories = ['soil_earthwork', 'quarry_rock', 'rock_breaker', 'mixed', 'unknown'];
  const appHistory = validAppHistories.includes(machDetails.application_history)
    ? machDetails.application_history
    : 'unknown';

  const expectedPrice = typeof commTerms.expected_price_inr === 'number' ? commTerms.expected_price_inr : null;
  const budgetMax = typeof commTerms.budget_max_inr === 'number' ? commTerms.budget_max_inr : null;
  const city = machDetails.location_city || null;
  const isDnc = Boolean(payload.dnc_requested);

  // Deterministic Engines evaluation
  let qualState = (payload.qualification_state && ['QUALIFIED', 'PARTIALLY_QUALIFIED', 'UNQUALIFIED', 'DISQUALIFIED'].includes(payload.qualification_state))
    ? payload.qualification_state
    : null;
  if (!qualState) {
    if (payload.conversation_outcome === 'lead_qualified') {
      qualState = 'QUALIFIED';
    } else {
      qualState = evaluateQualification(customerType, machDetails, commTerms, city, isDnc);
    }
  }

  let leadTemp = (payload.lead_temperature && ['HOT', 'WARM', 'COLD'].includes(payload.lead_temperature))
    ? payload.lead_temperature
    : null;
  if (!leadTemp) {
    if (payload.conversation_outcome === 'lead_qualified') {
      leadTemp = 'HOT';
    } else {
      leadTemp = evaluateLeadTemperature(customerType, qualState, machDetails, commTerms, evReadiness, isDnc);
    }
  }

  const nextAction = (payload.next_action && typeof payload.next_action === 'string' && payload.next_action.trim())
    ? payload.next_action.trim()
    : evaluateNextAction(customerType, qualState, leadTemp, commTerms, evReadiness, isDnc);

  const extractedVariables = {
    caller_name: payload.customer_name || payload.caller_name || null,
    callback_number: phone,
    whatsapp_number: payload.whatsapp_phone || payload.whatsapp_number || phone,
    customer_type: customerType,
    ownership_type: payload.ownership_type || 'unknown',
    machine_details: {
      brand: machDetails.brand || null,
      model: machDetails.model || null,
      model_year: modelYear,
      running_hours: typeof machDetails.running_hours === 'number' ? machDetails.running_hours : null,
      tonnage_class: machDetails.tonnage_class || 'unknown',
      application_history: appHistory,
      machine_condition_summary: machDetails.machine_condition_summary || null,
      location_city: city,
      location_state: machDetails.location_state || null,
      document_status: machDetails.document_status || 'unknown'
    },
    commercial_terms: {
      expected_price_inr: expectedPrice,
      budget_max_inr: budgetMax,
      price_or_budget_raw: commTerms.price_or_budget_raw || null,
      purchase_timeline: commTerms.purchase_timeline || 'not_applicable',
      yard_visit_agreed: Boolean(commTerms.yard_visit_agreed),
      yard_visit_schedule: commTerms.yard_visit_schedule || null
    },
    evidence_readiness: {
      photos_agreed: Boolean(evReadiness.photos_agreed),
      running_video_agreed: Boolean(evReadiness.running_video_agreed),
      rc_copy_agreed: Boolean(evReadiness.rc_copy_agreed),
      evidence_status: evReadiness.evidence_status || 'promised'
    },
    lead_temperature: leadTemp,
    qualification_state: qualState,
    conversation_outcome: payload.conversation_outcome || 'inquiry',
    next_action: nextAction,
    follow_up_required: Boolean(payload.follow_up_required),
    follow_up_datetime: payload.follow_up_datetime || null,
    call_notes: payload.call_notes || '',
    dnc_requested: isDnc
  };

  const followUp = evaluateFollowUp(extractedVariables, payload);
  extractedVariables.follow_up_required = followUp.follow_up_required;
  extractedVariables.follow_up_datetime = followUp.follow_up_datetime;

  const durationSec = typeof callMeta.duration_seconds === 'number' ? callMeta.duration_seconds : (payload.duration || 0);
  const direction = (callMeta.direction || payload.direction || 'inbound').toLowerCase();

  const callSession = createCallSession({
    runId: numericRunId,
    leadId,
    orgId,
    workflowId: wfId,
    phone,
    customerType,
    direction,
    startedAt: callMeta.started_at || payload.started_at,
    connectedAt: callMeta.connected_at || payload.connected_at,
    endedAt: callMeta.ended_at || payload.ended_at,
    duration: durationSec,
    transcript: payload.transcript || null,
    extractedVariables,
    qualificationState: qualState,
    leadTemperature: leadTemp,
    outcome: payload.conversation_outcome || 'inquiry',
    nextAction,
    followUp,
    status: CALL_STATUSES.COMPLETED
  });

  // Machine ID deterministically generated for idempotent upsert
  const brand = extractedVariables.machine_details.brand;
  const model = extractedVariables.machine_details.model;
  let machineId = null;
  if (customerType === 'seller' && brand && model) {
    machineId = `mach_run_${numericRunId}`;
  }

  // Build ACID PostgreSQL Transaction SQL
  const txStatements = ['BEGIN;'];

  // 1. workflow_runs record
  txStatements.push(`
    INSERT INTO workflow_runs (
      id, name, workflow_id, mode, created_at, is_completed, usage_info, cost_info,
      initial_context, gathered_context, annotations, logs, storage_backend, state, call_type, extra
    ) VALUES (
      ${sqlEscapeInt(numericRunId)},
      ${sqlEscapeString('vaani-call-' + numericRunId)},
      ${sqlEscapeInt(wfId)},
      'smallwebrtc',
      CURRENT_TIMESTAMP,
      true,
      '{}'::json,
      '{}'::json,
      '{}'::json,
      json_build_object(
        'extracted_variables', ${sqlEscapeJson(extractedVariables)},
        'call_session', ${sqlEscapeJson(callSession)},
        'extraction_audit', ${sqlEscapeJson(extractionAudit || {})}
      )::json,
      '{}'::json,
      '{}'::json,
      's3',
      'completed',
      ${sqlEscapeString(direction)},
      '{}'::json
    )
    ON CONFLICT (id) DO UPDATE SET
      gathered_context = jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(workflow_runs.gathered_context::jsonb, '{}'::jsonb),
            '{extracted_variables}',
            ${sqlEscapeJson(extractedVariables)},
            true
          ),
          '{call_session}',
          ${sqlEscapeJson(callSession)},
          true
        ),
        '{extraction_audit}',
        ${sqlEscapeJson(extractionAudit || {})},
        true
      )::json,
      is_completed = true,
      state = 'completed';
  `);

  // 2. vaani_machines record (if seller with brand & model)
  if (machineId) {
    const hmr = extractedVariables.machine_details.running_hours;
    const loc = extractedVariables.machine_details.location_city || 'Jaipur Yard (Loha Mandi / VKI Area)';
    txStatements.push(`
      INSERT INTO vaani_machines (
        organization_id, machine_id, source_lead_run_id, brand, model, manufacturing_year,
        hour_meter_reading, application_history, sourcing_cost_inr, status, current_location, updated_at
      ) VALUES (
        ${sqlEscapeInt(orgId)},
        ${sqlEscapeString(machineId)},
        ${sqlEscapeInt(numericRunId)},
        ${sqlEscapeString(brand)},
        ${sqlEscapeString(model)},
        ${sqlEscapeInt(modelYear)},
        ${sqlEscapeInt(hmr)},
        ${sqlEscapeString(appHistory)},
        ${sqlEscapeInt(expectedPrice)},
        'in_sourcing_pipeline',
        ${sqlEscapeString(loc)},
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (machine_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id,
        brand = EXCLUDED.brand,
        model = EXCLUDED.model,
        manufacturing_year = EXCLUDED.manufacturing_year,
        hour_meter_reading = EXCLUDED.hour_meter_reading,
        application_history = EXCLUDED.application_history,
        sourcing_cost_inr = EXCLUDED.sourcing_cost_inr,
        current_location = EXCLUDED.current_location,
        updated_at = CURRENT_TIMESTAMP;
    `);
  }

  // 3. vaani_digital_evidence records (deterministic evidence IDs prevent duplicates)
  if (extractedVariables.evidence_readiness.photos_agreed) {
    const photoTypes = ['photo_exterior', 'photo_boom', 'photo_undercarriage', 'photo_meter'];
    for (const mType of photoTypes) {
      const evId = `ev_${numericRunId}_${mType}`;
      txStatements.push(`
        INSERT INTO vaani_digital_evidence (organization_id, evidence_id, machine_id, run_id, media_type, media_url, evaluator_notes)
        VALUES (${sqlEscapeInt(orgId)}, ${sqlEscapeString(evId)}, ${sqlEscapeString(machineId)}, ${sqlEscapeInt(numericRunId)}, ${sqlEscapeString(mType)}, 'whatsapp://pending/${mType}', 'Promised by seller on WhatsApp')
        ON CONFLICT (evidence_id) DO UPDATE SET received_at = CURRENT_TIMESTAMP;
      `);
    }
  }

  if (extractedVariables.evidence_readiness.running_video_agreed) {
    const evId = `ev_${numericRunId}_video_running_30s`;
    txStatements.push(`
      INSERT INTO vaani_digital_evidence (organization_id, evidence_id, machine_id, run_id, media_type, media_url, evaluator_notes)
      VALUES (${sqlEscapeInt(orgId)}, ${sqlEscapeString(evId)}, ${sqlEscapeString(machineId)}, ${sqlEscapeInt(numericRunId)}, 'video_running_30s', 'whatsapp://pending/video_running_30s', 'Promised 30s operational running video')
      ON CONFLICT (evidence_id) DO UPDATE SET received_at = CURRENT_TIMESTAMP;
    `);
  }

  if (extractedVariables.evidence_readiness.rc_copy_agreed) {
    const evId = `ev_${numericRunId}_doc_rc`;
    txStatements.push(`
      INSERT INTO vaani_digital_evidence (organization_id, evidence_id, machine_id, run_id, media_type, media_url, evaluator_notes)
      VALUES (${sqlEscapeInt(orgId)}, ${sqlEscapeString(evId)}, ${sqlEscapeString(machineId)}, ${sqlEscapeInt(numericRunId)}, 'doc_rc', 'whatsapp://pending/doc_rc', 'Promised RC/NOC document')
      ON CONFLICT (evidence_id) DO UPDATE SET received_at = CURRENT_TIMESTAMP;
    `);
  }

  // 4. vaani_dnc_registry record (if dnc_requested)
  if (isDnc && phone) {
    txStatements.push(`
      INSERT INTO vaani_dnc_registry (organization_id, phone_number, run_id, reason, opted_out_at, is_active)
      VALUES (
        ${sqlEscapeInt(orgId)},
        ${sqlEscapeString(phone)},
        ${sqlEscapeInt(numericRunId)},
        ${sqlEscapeString(payload.dnc_reason || 'Caller opted out during conversation')},
        CURRENT_TIMESTAMP,
        true
      )
      ON CONFLICT (organization_id, phone_number) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        reason = EXCLUDED.reason,
        opted_out_at = CURRENT_TIMESTAMP,
        is_active = true;
    `);
  }

  txStatements.push('COMMIT;');

  try {
    await queryPostgres(txStatements.join('\n'));
  } catch (dbErr) {
    const err = new Error(`Database transaction failed: ${dbErr.message}`);
    err.statusCode = 500;
    err.code = 'database_error';
    err.errorCode = 'DATABASE_ERROR';
    throw err;
  }

  // Phase F Step 3: Trigger deduplicated follow-up tasks creation
  let tasksCreated = [];
  try {
    tasksCreated = await vaaniTasks.processCallFollowUpTasks({
      organization_id: orgId,
      run_id: numericRunId,
      lead_id: leadId,
      customer_id: phone,
      customer_type: customerType,
      caller_name: extractedVariables.caller_name,
      primary_phone: phone,
      qual_state: qualState,
      lead_temp: leadTemp,
      next_action: nextAction,
      dnc_requested: isDnc,
      mach_details: extractedVariables.machine_details,
      comm_terms: extractedVariables.commercial_terms,
      ev_readiness: extractedVariables.evidence_readiness,
      follow_up_datetime: followUp.follow_up_datetime
    });
  } catch (taskErr) {
    console.warn('[VAANI SALES] Notice processing follow-up tasks:', taskErr.message);
  }

  return {
    success: true,
    lead_id: leadId,
    run_id: numericRunId,
    call_session_id: callSession.call_session_id,
    status: callSession.status,
    is_duplicate: isDuplicate,
    qualification_state: callSession.qualification_state,
    lead_temperature: callSession.lead_temperature,
    next_action: callSession.next_action,
    follow_up: {
      required: followUp.follow_up_required,
      datetime: followUp.follow_up_datetime,
      reason: followUp.follow_up_reason,
      assigned_to: followUp.assigned_to
    },
    tasks_created: tasksCreated
  };
}

async function getLeadEvidence(leadId, isDemo = false, organizationId = null) {
  if (isDemo) {
    const l360 = await getLead360(leadId, true);
    return l360?.evidence_checklist || [];
  }
  if (!organizationId) return [];
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return [];
  return vaaniWhatsapp.getLeadEvidence(leadId, orgInt);
}

async function getLeadWhatsAppHistory(leadId, isDemo = false, organizationId = null) {
  if (isDemo) {
    return [];
  }
  if (!organizationId) return [];
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return [];
  return vaaniWhatsapp.getLeadWhatsAppHistory(leadId, orgInt);
}

async function requestLeadEvidence(leadId, evidenceType, organizationId, options = {}) {
  if (!organizationId) {
    throw new Error('organization_id is required for evidence request');
  }
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) {
    throw new Error('invalid organization_id');
  }
  return vaaniWhatsapp.queueAndSendEvidenceRequest({
    organization_id: orgInt,
    lead_id: leadId,
    evidence_type: evidenceType,
    ...options
  });
}

module.exports = {
  MACHINE_MASTER_TAXONOMY,
  CALL_STATUSES,
  evaluateQualification,
  evaluateLeadTemperature,
  evaluateNextAction,
  evaluateFollowUp,
  createCallSession,
  getOverview,
  getSellers,
  getBuyers,
  getMachines,
  getDemand,
  getFollowUps,
  getCalls,
  getCallDetail,
  getDncRegistry,
  searchLeads,
  updateFollowUpStatus,
  getLead360,
  getLeadTimeline,
  getLeadEvidence,
  getLeadWhatsAppHistory,
  requestLeadEvidence,
  getRecentActivities,
  buildExtractedVsMissing,
  buildJourneyProgression,
  buildDefaultEvidenceChecklist,
  ingestCallComplete,
  queryPostgres,
  localFollowUpOverrides,
  extractFromConversation: vaaniExtractor.extractFromConversation,
  VaaniConversationExtractor: vaaniExtractor.VaaniConversationExtractor,
  matchMachineModel: vaaniExtractor.matchMachineModel,
  parseSpokenPrice: vaaniExtractor.parseSpokenPrice,
  parseModelYear: vaaniExtractor.parseModelYear,
  parseOperatingHours: vaaniExtractor.parseOperatingHours,
  vaaniTasks,
  TASK_STATUSES: vaaniTasks.TASK_STATUSES,
  TASK_PRIORITIES: vaaniTasks.TASK_PRIORITIES,
  TASK_TYPES: vaaniTasks.TASK_TYPES,
  transitionTaskStatus: vaaniTasks.transitionTaskStatus,
  markEvidenceReceived: vaaniTasks.markEvidenceReceived,
  vaaniWhatsapp,
  EVIDENCE_TYPES: vaaniWhatsapp.EVIDENCE_TYPES,
  MESSAGE_STATUSES: vaaniWhatsapp.MESSAGE_STATUSES,
  buildEvidenceRequest: vaaniWhatsapp.buildEvidenceRequest,
  MockWhatsAppProvider: vaaniWhatsapp.MockWhatsAppProvider,
  queueAndSendEvidenceRequest: vaaniWhatsapp.queueAndSendEvidenceRequest,
  processInboundWebhook: vaaniWhatsapp.processInboundWebhook,
  calculateEvidenceReadiness: vaaniWhatsapp.calculateEvidenceReadiness,
  getInternalMachines,
  classifyMediaEvidence: vaaniWhatsapp.classifyMediaEvidence
};
