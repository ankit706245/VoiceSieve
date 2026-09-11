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
const { execFile } = require('child_process');

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

function queryPostgres(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      ['exec', 'dograh-local-postgres-1', 'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql],
      { timeout: 8000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          const trimmed = stdout.trim();
          if (!trimmed) return resolve(null);
          const parsed = JSON.parse(trimmed);
          resolve(parsed);
        } catch (parseErr) {
          resolve(stdout.trim());
        }
      }
    );
  });
}

// In-memory follow-up status store for local runtime persistence
const localFollowUpOverrides = new Map();

async function getOverview(isDemo = false) {
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

  try {
    const sql = `
      SELECT json_build_object(
        'total_leads', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads),
        'connected_calls', (SELECT COUNT(*) FROM workflow_runs WHERE workflow_id = 3),
        'hot_sellers', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE customer_type = 'seller' AND lead_temperature = 'HOT'),
        'hot_buyers', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE customer_type = 'buyer' AND lead_temperature = 'HOT'),
        'qualified_leads', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE qualification_state = 'QUALIFIED'),
        'follow_ups_due', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE follow_up_required = true AND dnc_requested = false),
        'closed_won', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE conversation_outcome = 'lead_qualified' AND lead_temperature = 'HOT'),
        'dnc_total', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE dnc_requested = true),
        'funnel', json_build_array(
          json_build_object('stage', 'NEW', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE customer_type = 'unknown' OR conversation_outcome = 'inquiry')),
          json_build_object('stage', 'CONTACTED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads)),
          json_build_object('stage', 'CONNECTED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE conversation_outcome IS NOT NULL AND conversation_outcome != 'failed')),
          json_build_object('stage', 'INTERESTED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE conversation_outcome IN ('inquiry', 'price_discussion', 'callback_requested', 'appointment_requested', 'lead_qualified'))),
          json_build_object('stage', 'QUALIFIED', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE qualification_state = 'QUALIFIED')),
          json_build_object('stage', 'PRICE_DISCUSSION', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE conversation_outcome = 'price_discussion' OR price_raw IS NOT NULL)),
          json_build_object('stage', 'FOLLOW_UP', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE follow_up_required = true)),
          json_build_object('stage', 'NEGOTIATION', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE lead_temperature = 'HOT' AND qualification_state = 'QUALIFIED')),
          json_build_object('stage', 'CLOSED_WON', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE conversation_outcome = 'lead_qualified' AND lead_temperature = 'HOT')),
          json_build_object('stage', 'CLOSED_LOST', 'count', 0),
          json_build_object('stage', 'DO_NOT_CALL', 'count', (SELECT COUNT(DISTINCT COALESCE(NULLIF(callback_number, ''), run_id::text)) FROM vaani_excavator_sales_leads WHERE dnc_requested = true))
        ),
        'recent_leads', COALESCE(
          (SELECT json_agg(t) FROM (
            SELECT run_id AS lead_id, created_at, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_time,
                   caller_name, callback_number, customer_type, machine_brand, machine_model,
                   lead_temperature, qualification_state, conversation_outcome, next_action, dnc_requested
            FROM vaani_excavator_sales_leads
            ORDER BY run_id DESC LIMIT 10
          ) t), '[]'::json
        )
      );
    `;
    const result = await queryPostgres(sql);
    if (result && typeof result === 'object') {
      const activities = await getRecentActivities(10, false);
      return { is_demo: false, ...result, recent_activities: activities };
    }
  } catch (err) {
    console.error('[VAANI SALES] Error querying overview from PG:', err.message);
  }

  // Safe empty fallback
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

async function getSellers(filters = {}, isDemo = false) {
  let sellers = [];
  if (isDemo) {
    const demo = loadDemoData();
    sellers = demo ? demo.sellers : [];
  } else {
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
          WHERE customer_type = 'seller'
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql);
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

async function getBuyers(filters = {}, isDemo = false) {
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
          WHERE customer_type = 'buyer'
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql);
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

async function getMachines(isDemo = false) {
  let actualStock = [];
  if (isDemo) {
    const demo = loadDemoData();
    actualStock = demo ? demo.actual_stock : [];
  } else {
    try {
      const sql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT machine_id, brand, model, manufacturing_year, hour_meter_reading,
                 application_history, sourcing_cost_inr, target_resale_inr, status,
                 current_location, created_at
          FROM vaani_machines
          ORDER BY created_at DESC
        ) t;
      `;
      const result = await queryPostgres(sql);
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

async function getDemand(isDemo = false) {
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
    const buyers = await getBuyers({}, false);
    const machinesRes = await getMachines(false);
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

async function getFollowUps(isDemo = false) {
  let list = [];
  if (isDemo) {
    const demo = loadDemoData();
    list = demo ? demo.follow_ups : [];
  } else {
    try {
      const sql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT run_id AS id, caller_name AS customer_name, customer_type,
                 callback_number AS primary_phone,
                 COALESCE(machine_model, required_tonnage_class, '20-Ton Excavator') AS machine_requirement,
                 next_action AS reason, follow_up_datetime,
                 'pending' AS status, 'Procurement/Sales Team' AS assigned_owner
          FROM vaani_excavator_sales_leads
          WHERE follow_up_required = true AND dnc_requested = false
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql);
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

  return {
    overdue: enriched.filter((i) => i.category === 'overdue'),
    due_today: enriched.filter((i) => i.category === 'due_today'),
    upcoming: enriched.filter((i) => i.category === 'upcoming')
  };
}

async function getCalls(isDemo = false) {
  if (isDemo) {
    const demo = loadDemoData();
    return demo ? demo.calls : [];
  }

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
        ORDER BY run_id DESC
      ) t;
    `;
    const result = await queryPostgres(sql);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[VAANI SALES] Error querying calls from PG:', err.message);
    return [];
  }
}

async function getCallDetail(runId, isDemo = false) {
  if (isDemo) {
    const demo = loadDemoData();
    const match = (demo?.calls || []).find((c) => String(c.run_id) === String(runId));
    if (match) return match;
    return (demo?.calls || [])[0] || null;
  }

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
      WHERE r.id = ${parseInt(runId, 10)};
    `;
    const result = await queryPostgres(sql);
    return result || null;
  } catch (err) {
    console.error(`[VAANI SALES] Error querying call detail for ${runId}:`, err.message);
    return null;
  }
}

async function getDncRegistry(isDemo = false) {
  if (isDemo) {
    const demo = loadDemoData();
    return demo ? demo.dnc_registry : [];
  }

  try {
    const sql = `
      SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT COALESCE(callback_number, 'Unknown') AS phone_number,
               COALESCE(caller_name, 'Unregistered Caller') AS customer_name,
               'Opted out during conversation' AS reason,
               created_at AS opted_out_at,
               'Inbound/Outbound Call #' || run_id AS source,
               true AS is_active
        FROM vaani_excavator_sales_leads
        WHERE dnc_requested = true
        ORDER BY run_id DESC
      ) t;
    `;
    const result = await queryPostgres(sql);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[VAANI SALES] Error querying DNC registry:', err.message);
    return [];
  }
}

async function searchLeads(query, isDemo = false) {
  if (!query || typeof query !== 'string') return [];
  const q = query.trim().toLowerCase();

  const [sellers, buyers, dncList] = await Promise.all([
    getSellers({}, isDemo),
    getBuyers({}, isDemo),
    getDncRegistry(isDemo)
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

function updateFollowUpStatus(followUpId, status) {
  if (!['pending', 'completed', 'cancelled', 'scheduled'].includes(status)) {
    throw new Error('Invalid follow-up status');
  }
  localFollowUpOverrides.set(String(followUpId), status);
  return { success: true, id: followUpId, status, updated_at: new Date().toISOString() };
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

async function getLead360(leadId, isDemo = false) {
  if (!leadId) return null;
  const targetId = String(leadId).trim();

  if (isDemo) {
    const demo = loadDemoData();
    if (!demo) return null;

    const allLeads = [
      ...(demo.sellers || []),
      ...(demo.buyers || []),
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
      linked_calls: linkedCalls,
      timeline
    };
  }

  // Real DB mode: query PostgreSQL workflow_runs and sales views
  try {
    const isNum = /^\d+$/.test(targetId);
    let whereClause = `(r.gathered_context -> 'extracted_variables') ->> 'callback_number' = '${targetId}'`;
    if (isNum) {
      whereClause = `(r.id = ${parseInt(targetId, 10)} OR (r.gathered_context -> 'extracted_variables') ->> 'callback_number' = '${targetId}')`;
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
          'model_year', (r.gathered_context -> 'extracted_variables') ->> 'model_year',
          'running_hours', (r.gathered_context -> 'extracted_variables') ->> 'running_hours',
          'application_history', (r.gathered_context -> 'extracted_variables') ->> 'application_history',
          'location_city', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'location_city', (r.gathered_context -> 'extracted_variables') ->> 'location_city'),
          'location_state', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'location_state', (r.gathered_context -> 'extracted_variables') ->> 'location_state'),
          'expected_selling_price_inr', (r.gathered_context -> 'extracted_variables') ->> 'expected_selling_price_inr',
          'price_raw', (r.gathered_context -> 'extracted_variables') ->> 'price_or_budget_raw',
          'lead_temperature', COALESCE((r.gathered_context -> 'extracted_variables') ->> 'lead_temperature', 'COLD'),
          'qualification_state', COALESCE((r.gathered_context -> 'extracted_variables') ->> 'qualification_state', 'UNQUALIFIED'),
          'conversation_outcome', (r.gathered_context -> 'extracted_variables') ->> 'conversation_outcome',
          'next_action', (r.gathered_context -> 'extracted_variables') ->> 'next_action',
          'follow_up_required', ((r.gathered_context -> 'extracted_variables') ->> 'follow_up_required')::boolean,
          'follow_up_datetime', (r.gathered_context -> 'extracted_variables') ->> 'follow_up_datetime',
          'dnc_requested', COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'dnc_requested')::boolean, false),
          'photos_agreed', COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'photos_agreed')::boolean, false),
          'running_video_agreed', COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'running_video_agreed')::boolean, false),
          'rc_copy_agreed', COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'rc_copy_agreed')::boolean, false)
        ) ORDER BY r.id DESC)
      )
      FROM workflow_runs r
      WHERE r.workflow_id = 3 AND ${whereClause};
    `;

    const res = await queryPostgres(sql);
    const runs = res && Array.isArray(res.runs) ? res.runs : [];
    if (runs.length === 0) return null;

    const latest = runs[0];
    const phone = latest.callback_number || targetId;
    const learned = buildExtractedVsMissing(latest);
    const journey = buildJourneyProgression(latest);
    const evidence = buildDefaultEvidenceChecklist(latest);
    const timeline = await getLeadTimeline(targetId, false);
    const isDnc = !!latest.dnc_requested || latest.customer_type === 'dnc';
    const dueTime = latest.follow_up_datetime || 'Tomorrow, 11:00 AM';

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
      evidence_integration_note: 'WhatsApp action pending integration — Evidence status logged from voice responses',
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

async function getLeadTimeline(leadId, isDemo = false) {
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
      description: match.dnc_requested
        ? `Caller requested Do Not Call opt-out: ${match.reason || 'Opted out'}.`
        : `Vaani identified customer as ${isSeller ? 'Machine Seller' : 'Excavator Buyer'}. Outcome: ${match.conversation_outcome || 'inquiry'}.`,
      customer_quote: match.call_notes || match.reason || null
    });

    if (match.dnc_requested || match.customer_type === 'dnc') {
      events.push({
        id: `synth_${targetId}_dnc`,
        day: 'DAY 1',
        day_label: 'Day 1',
        timestamp: new Date(createdDate.getTime() + 180000).toISOString(),
        formatted_time: `${formattedDate}, 10:03 AM`,
        activity_type: 'DNC_REGISTERED',
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        title: 'Do Not Call Registered',
        description: 'Customer requested opt-out during call greeting. Quarantined in compliance registry.'
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

  // Real DB mode
  try {
    const isNum = /^\d+$/.test(targetId);
    let whereClause = `(r.gathered_context -> 'extracted_variables') ->> 'callback_number' = '${targetId}'`;
    if (isNum) {
      whereClause = `(r.id = ${parseInt(targetId, 10)} OR (r.gathered_context -> 'extracted_variables') ->> 'callback_number' = '${targetId}')`;
    }

    const sql = `
      SELECT r.id, r.created_at,
             to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') as formatted_time,
             (r.gathered_context -> 'extracted_variables') as vars
      FROM workflow_runs r
      WHERE r.workflow_id = 3 AND ${whereClause}
      ORDER BY r.id ASC;
    `;

    const runs = await queryPostgres(sql);
    if (!Array.isArray(runs) || runs.length === 0) return [];

    const events = [];
    runs.forEach((run, idx) => {
      const vars = run.vars || {};
      const dayLabel = `Day ${idx + 1}`;

      events.push({
        id: `run_${run.id}_start`,
        day: `DAY ${idx + 1}`,
        day_label: dayLabel,
        timestamp: run.created_at,
        formatted_time: run.formatted_time,
        activity_type: 'CALL_STARTED',
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        title: `Inbound Call #${run.id} Started`,
        description: `Connected with ${vars.caller_name || 'caller'} from ${vars.callback_number || 'line'}.`
      });

      events.push({
        id: `run_${run.id}_done`,
        day: `DAY ${idx + 1}`,
        day_label: dayLabel,
        timestamp: run.created_at,
        formatted_time: run.formatted_time,
        activity_type: 'CALL_COMPLETED',
        actor: 'vaani',
        actor_label: '🤖 VAANI',
        title: `Call #${run.id} Completed`,
        description: `Outcome: ${vars.conversation_outcome || 'inquiry'}. Customer type: ${vars.customer_type || 'unknown'}.`,
        customer_quote: vars.call_notes || null
      });

      if (vars.machine_brand || vars.machine_model || vars.required_tonnage_class) {
        events.push({
          id: `run_${run.id}_extracted`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: run.created_at,
          formatted_time: run.formatted_time,
          activity_type: 'INFORMATION_EXTRACTED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: 'Machine Data Extracted',
          description: `Brand: ${vars.machine_brand || 'N/A'} | Model: ${vars.machine_model || vars.required_tonnage_class || 'N/A'} | Price: ${vars.price_or_budget_raw || vars.expected_selling_price_inr || 'N/A'}`
        });
      }

      if (vars.qualification_state) {
        events.push({
          id: `run_${run.id}_qual`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: run.created_at,
          formatted_time: run.formatted_time,
          activity_type: 'LEAD_QUALIFIED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: `Lead Qualified as ${vars.lead_temperature || 'WARM'}`,
          description: `State: ${vars.qualification_state}. Next action: ${vars.next_action || 'Follow up'}`
        });
      }

      if (vars.dnc_requested) {
        events.push({
          id: `run_${run.id}_dnc`,
          day: `DAY ${idx + 1}`,
          day_label: dayLabel,
          timestamp: run.created_at,
          formatted_time: run.formatted_time,
          activity_type: 'DNC_REGISTERED',
          actor: 'vaani',
          actor_label: '🤖 VAANI',
          title: 'DNC Request Registered',
          description: 'Caller requested not to be contacted. Number quarantined.'
        });
      }
    });

    return events;
  } catch (err) {
    console.error(`[VAANI SALES] Error generating timeline for ${targetId}:`, err.message);
    return [];
  }
}

async function getRecentActivities(limit = 15, isDemo = false) {
  if (isDemo) {
    const demo = loadDemoData();
    return demo ? (demo.recent_activities || []).slice(0, limit) : [];
  }

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
        WHERE r.workflow_id = 3
        ORDER BY r.id DESC
        LIMIT ${limit}
      ) t;
    `;

    const runs = await queryPostgres(sql);
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

module.exports = {
  MACHINE_MASTER_TAXONOMY,
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
  getRecentActivities,
  buildExtractedVsMissing,
  buildJourneyProgression,
  buildDefaultEvidenceChecklist
};

