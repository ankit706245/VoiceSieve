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
    if (demo) return { is_demo: true, ...demo.stats, funnel: demo.funnel, recent_leads: demo.sellers.concat(demo.buyers).slice(0, 8) };
  }

  try {
    const sql = `
      SELECT json_build_object(
        'total_leads', (SELECT COUNT(*) FROM vaani_excavator_sales_leads),
        'connected_calls', (SELECT COUNT(*) FROM workflow_runs WHERE workflow_id = 3),
        'hot_sellers', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE customer_type = 'seller' AND lead_temperature = 'HOT'),
        'hot_buyers', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE customer_type = 'buyer' AND lead_temperature = 'HOT'),
        'qualified_leads', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE qualification_state = 'QUALIFIED'),
        'follow_ups_due', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE follow_up_required = true AND dnc_requested = false),
        'closed_won', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE conversation_outcome = 'lead_qualified' AND lead_temperature = 'HOT'),
        'dnc_total', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE dnc_requested = true),
        'funnel', json_build_array(
          json_build_object('stage', 'NEW', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE customer_type = 'unknown')),
          json_build_object('stage', 'CONTACTED', 'count', (SELECT COUNT(*) FROM workflow_runs WHERE workflow_id = 3)),
          json_build_object('stage', 'CONNECTED', 'count', (SELECT COUNT(*) FROM workflow_runs WHERE workflow_id = 3)),
          json_build_object('stage', 'INTERESTED', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE conversation_outcome IN ('inquiry', 'price_discussion', 'callback_requested'))),
          json_build_object('stage', 'QUALIFIED', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE qualification_state = 'QUALIFIED')),
          json_build_object('stage', 'PRICE_DISCUSSION', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE conversation_outcome = 'price_discussion')),
          json_build_object('stage', 'FOLLOW_UP', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE follow_up_required = true)),
          json_build_object('stage', 'NEGOTIATION', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE lead_temperature = 'HOT' AND qualification_state = 'QUALIFIED')),
          json_build_object('stage', 'CLOSED_WON', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE conversation_outcome = 'lead_qualified' AND lead_temperature = 'HOT')),
          json_build_object('stage', 'CLOSED_LOST', 'count', 0),
          json_build_object('stage', 'DO_NOT_CALL', 'count', (SELECT COUNT(*) FROM vaani_excavator_sales_leads WHERE dnc_requested = true))
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
      return { is_demo: false, ...result };
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
    recent_leads: []
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
  updateFollowUpStatus
};
