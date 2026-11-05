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
const supadb = require('./supadb');
const vaaniExtractor = require('./vaani-extractor');
const { extractFromConversationLLM } = require('./vaani-llm-extractor');
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


// Controlled normalization for matching only: trim, collapse inner
// whitespace, lowercase. No fuzzy logic: anything else must not match.
function normMatchToken(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Resolve a model string to its taxonomy canonical form when a known alias
// matches; otherwise return the normalized raw string. Both sides resolve
// through the same table, so "jcb 205" and "JS 205" meet deterministically.
function canonicalMatchModel(v) {
  const norm = normMatchToken(v);
  if (!norm) return '';
  for (const entry of MACHINE_MASTER_TAXONOMY) {
    const candidates = [entry.canonical_model, ...(entry.aliases || []), entry.brand];
    for (const c of candidates) {
      if (normMatchToken(c) === norm || normMatchToken(c).endsWith(' ' + norm) || norm.endsWith(' ' + normMatchToken(c))) {
        return normMatchToken(entry.canonical_model);
      }
    }
  }
  return norm;
}

function formatLakhINR(paise) {
  if (paise === null || paise === undefined || paise === '') return 'unknown';
  const n = Number(paise);
  if (!Number.isFinite(n)) return String(paise);
  return '₹' + (n / 100000).toFixed(2).replace(/\.00$/, '') + 'L';
}

// Deterministic inventory match score, documented formula (Goal 25):
// start at 100; alternative model within same brand -10; location
// mismatch -8; budget overrun within 10% tolerance -5; year +/-1
// tolerance -3; unknown dimensions never deduct. Clamped to >= 0.
// EXACT_MATCH iff score is 100 (no tolerance used). This is an inventory
// suitability score, NOT a lead score, temperature, or probability.
function evaluateBuyerMatches(buyer, stock) {
  const results = [];
  const targetBrand = normMatchToken(buyer.machine_brand);
  const targetModel = canonicalMatchModel(buyer.machine_model);
  const targetType = normMatchToken(buyer.machine_type);
  const budgetMax = parseInt(buyer.budget_max_inr ?? buyer.buyer_budget_max_inr, 10) || null;
  const budgetMin = parseInt(buyer.budget_min ?? buyer.budget_min_inr, 10) || null;
  const yearMin = parseInt(buyer.model_year_min, 10) || null;
  const yearMax = parseInt(buyer.model_year_max, 10) || null;
  const hoursMax = parseInt(buyer.max_hours ?? buyer.running_hours_max, 10) || null;
  const targetCity = normMatchToken(buyer.preferred_city);
  const targetNewUsed = normMatchToken(buyer.new_or_used);

  for (const machine of stock) {
    if (['sold', 'reserved'].includes(machine.status)) continue;

    let isExact = true;
    let isAlternative = false;
    const evidence = {};
    const matchedFields = [];
    const mismatchedFields = [];
    const missingRequirementFields = [];
    let isMatch = true;
    let score = 100;
    const deduct = (n) => { score = Math.max(0, score - n); };

    // Machine type (hard, only when both sides known; inventory has no
    // type column today, so this records unknown instead of penalizing).
    if (targetType) {
      evidence.machine_type = 'machine type not tracked in inventory';
      missingRequirementFields.push('machine_type_inventory_unknown');
    }

    // Brand & Model (existing business rule preserved: brand mismatch
    // excludes; same-brand model mismatch is an alternative).
    const machineBrand = normMatchToken(machine.brand);
    const machineModel = canonicalMatchModel(machine.model);
    if (targetBrand && targetBrand !== 'any') {
      if (machineBrand === targetBrand) {
        evidence.brand = 'canonical brand matched';
        matchedFields.push('brand');
        if (targetModel) {
          if (machineModel === targetModel) {
            evidence.model = 'canonical model matched';
            matchedFields.push('model');
          } else {
            // Alternative model for same brand (simple fallback)
            evidence.model = 'brand matched, alternative model';
            mismatchedFields.push('model');
            isExact = false;
            isAlternative = true;
            deduct(10);
          }
        } else {
          missingRequirementFields.push('model');
        }
      } else {
        isMatch = false; // Brand mismatch
      }
    } else if (targetModel) {
      if (machineBrand && machineModel === targetModel) {
        evidence.model = 'canonical model matched';
        matchedFields.push('brand');
        matchedFields.push('model');
      } else {
        isMatch = false;
      }
    } else {
      missingRequirementFields.push('brand');
      missingRequirementFields.push('model');
    }

    if (!isMatch) {
      // Check if it's a completely different brand but same tonnage, business logic says ALTERNATIVE_MATCH?
      // According to contract: "Do NOT invent arbitrary substitutions. Hyundai != JCB unless defined."
      // Since it's not defined here, we keep NO_MATCH.
      continue;
    }

    // Budget (hard ceiling; within-10% overrun is an explained alternative).
    const machinePrice = parseInt(machine.target_resale_inr, 10);
    if (budgetMax) {
      if (Number.isFinite(machinePrice) && machinePrice <= budgetMax) {
        evidence.budget = 'price satisfies budget';
        matchedFields.push('budget');
      } else if (Number.isFinite(machinePrice) && machinePrice <= budgetMax * 1.1) {
        evidence.budget = `price exceeds budget by ${formatLakhINR(machinePrice - budgetMax)} (within 10% tolerance)`;
        mismatchedFields.push('budget');
        isExact = false;
        isAlternative = true;
        deduct(5);
      } else {
        continue;
      }
    } else {
      evidence.budget = 'UNKNOWN / REQUIRES_VERIFICATION';
      missingRequirementFields.push('budget');
    }
    if (budgetMin) {
      evidence.budget_min = `buyer minimum ${formatLakhINR(budgetMin)} noted`;
    }

    // Year (hard range; +/-1 tolerance is an explained alternative).
    if (yearMin || yearMax) {
      const mYear = parseInt(machine.manufacturing_year, 10);
      if (mYear) {
        const yMin = yearMin || 2000;
        const yMax = yearMax || 2050;
        if (mYear >= yMin && mYear <= yMax) {
          evidence.year = 'year satisfies requirement';
          matchedFields.push('year');
        } else if (mYear >= yMin - 1 && mYear <= yMax + 1) {
          evidence.year = 'year within +/- 1 tolerance';
          mismatchedFields.push('year');
          isExact = false;
          isAlternative = true;
          deduct(3);
        } else {
          continue;
        }
      } else {
         evidence.year = 'UNKNOWN / REQUIRES_VERIFICATION';
      }
    } else {
      missingRequirementFields.push('year');
    }

    // Hours (hard cap; unknown on either side never penalizes).
    if (hoursMax) {
      const mHours = parseInt(machine.hour_meter_reading, 10);
      if (mHours) {
        if (mHours <= hoursMax) {
           evidence.hours = 'hours satisfy requirement';
           matchedFields.push('hours');
        } else {
           continue;
        }
      } else {
         evidence.hours = 'UNKNOWN / REQUIRES_VERIFICATION';
      }
    } else {
       evidence.hours = 'UNKNOWN / REQUIRES_VERIFICATION';
       missingRequirementFields.push('hours');
    }

    // Location preference (soft: mismatch is an explained alternative).
    const machineCity = normMatchToken(machine.current_location);
    if (targetCity) {
      if (machineCity && machineCity === targetCity) {
        evidence.location = 'location matched';
        matchedFields.push('location');
      } else if (machineCity) {
        evidence.location = `machine is in ${machine.current_location} instead of buyer city`;
        mismatchedFields.push('location');
        isExact = false;
        isAlternative = true;
        deduct(8);
      } else {
        evidence.location = 'UNKNOWN / REQUIRES_VERIFICATION';
      }
    }

    // New/Used preference (soft information only: inventory carries no
    // new/used column, so this can never exclude or penalize).
    if (targetNewUsed) {
      evidence.new_or_used = 'buyer prefers ' + targetNewUsed + '; inventory new/used not tracked';
    }

    // Application
    if (buyer.application_history) {
      if (machine.application_history === buyer.application_history) {
        evidence.application = 'application matched';
      } else if (machine.application_history === 'mixed') {
        evidence.application = 'mixed application satisfies requirement';
      } else {
        continue;
      }
    }

    evidence.availability = 'availability confirmed';

    // Format output without sensitive fields (no seller PII exists on stock
    // rows; resale price is owner-CRM data inside the same organization).
    const safeMachine = {
      machine_id: machine.machine_id,
      brand: machine.brand,
      model: machine.model,
      manufacturing_year: machine.manufacturing_year,
      hour_meter_reading: machine.hour_meter_reading,
      application_history: machine.application_history,
      status: machine.status,
      current_location: machine.current_location,
      target_resale_inr: machine.target_resale_inr,
      organization_id: machine.organization_id
    };

    const matchType = isExact ? 'EXACT_MATCH' : 'ALTERNATIVE_MATCH';
    const explanationLines = [];
    for (const [k, v] of Object.entries(evidence)) {
      explanationLines.push(`${k}: ${v}`);
    }
    results.push({
      match_type: matchType,
      match_score: score,
      matched: true,
      machine_id: machine.machine_id,
      machine: safeMachine,
      evidence: evidence,
      matched_fields: matchedFields,
      mismatched_fields: mismatchedFields,
      missing_requirement_fields: missingRequirementFields,
      match_explanation: (matchType === 'EXACT_MATCH' ? 'MATCHED' : 'PARTIAL MATCH') +
        ' (score ' + score + ')' +
        (explanationLines.length ? ' — ' + explanationLines.join('; ') : '')
    });
  }
  
  // Sort priority: EXACT first, then higher score, then stable machine order.
  results.sort((a, b) => {
    if (a.match_type === 'EXACT_MATCH' && b.match_type !== 'EXACT_MATCH') return -1;
    if (b.match_type === 'EXACT_MATCH' && a.match_type !== 'EXACT_MATCH') return 1;
    if (b.match_score !== a.match_score) return b.match_score - a.match_score;
    return String(a.machine_id).localeCompare(String(b.machine_id));
  });

  return results;
}

// ---------------------------------------------------------------------------
// Goal 33 Sales Pipeline: deterministic read-only derivation over existing
// structured outputs. Precedence is fixed and documented: explicit terminal
// or lifecycle states first, then owner review, follow-up, matches,
// completeness, and finally NEW. Nothing is inferred beyond these rules:
// no closed/lost/negotiation without explicit state, no commitments.
// ---------------------------------------------------------------------------

const BUYER_PIPELINE_STAGES = Object.freeze([
  'NEW', 'QUALIFICATION', 'REQUIREMENT_CAPTURED', 'MATCH_FOUND',
  'FOLLOW_UP', 'OWNER_REVIEW', 'NEGOTIATION', 'DEAL_CLOSED', 'LOST',
]);
const SELLER_PIPELINE_STAGES = Object.freeze([
  'NEW', 'MACHINE_INFORMATION', 'MACHINE_REVIEW', 'BUYER_MATCH_FOUND',
  'FOLLOW_UP', 'OWNER_REVIEW', 'NEGOTIATION', 'DEAL_CLOSED', 'LOST',
]);

function derivePipelineStage(input) {
  const src = input && typeof input === 'object' ? input : {};
  const customerType = src.customer_type === 'buyer' || src.customer_type === 'seller'
    ? src.customer_type : 'unknown';
  const lifecycle = typeof src.lifecycleStage === 'string' ? src.lifecycleStage : '';
  if (lifecycle === 'CLOSED_WON' || lifecycle === 'DEAL') {
    return { stage: 'DEAL_CLOSED', stage_reason: 'explicit lifecycle state: ' + lifecycle };
  }
  if (src.isLost === true) {
    return { stage: 'LOST', stage_reason: 'explicitly marked lost' };
  }
  if (src.dnc_requested === true) {
    return { stage: 'LOST', stage_reason: 'DNC opt-out recorded' };
  }
  if (lifecycle === 'NEGOTIATION') {
    return { stage: 'NEGOTIATION', stage_reason: 'explicit lifecycle state: NEGOTIATION' };
  }
  if (src.ownerReviewNeeded === true) {
    return { stage: 'OWNER_REVIEW', stage_reason: src.ownerReviewReason || 'owner review required' };
  }
  if (src.followupNeeded === true) {
    return { stage: 'FOLLOW_UP', stage_reason: src.followupReason || 'active follow-up' };
  }
  if (customerType === 'buyer') {
    if (src.hasMatches === true) {
      return { stage: 'MATCH_FOUND', stage_reason: src.matchDetail || 'compatible inventory available' };
    }
    if (src.isComplete === true) {
      return { stage: 'REQUIREMENT_CAPTURED', stage_reason: 'requirement complete, no matches yet' };
    }
    if (src.hasPartial === true) {
      return { stage: 'QUALIFICATION', stage_reason: 'qualification incomplete' };
    }
    return { stage: 'NEW', stage_reason: 'no meaningful information yet' };
  }
  if (customerType === 'seller') {
    if (src.hasMatches === true) {
      return { stage: 'BUYER_MATCH_FOUND', stage_reason: src.matchDetail || 'potential buyers available' };
    }
    if (src.isComplete === true) {
      return { stage: 'MACHINE_REVIEW', stage_reason: 'machine information complete' };
    }
    return { stage: 'MACHINE_INFORMATION', stage_reason: 'machine information incomplete' };
  }
  return { stage: 'NEW', stage_reason: 'unknown customer type' };
}

// Map Goal 25 match types onto the bidirectional status contract.
function matchTypeToStatus(matchType) {
  if (matchType === 'EXACT_MATCH') return 'MATCH';
  if (matchType === 'ALTERNATIVE_MATCH') return 'POTENTIAL_MATCH';
  return 'NO_MATCH';
}

// A potential match needs owner verification when it is not a clean MATCH
// or when required dimensions are unknown on either side.
function isReviewRequired(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.match_status !== 'MATCH') return true;
  const missing = Array.isArray(result.missing_fields) ? result.missing_fields : [];
  return missing.length > 0;
}

// Seller/machine -> buyer matching (Goal 32): mirror image of
// evaluateBuyerMatches with the same deterministic rules, scoring scale,
// and explanation style. Unknown on either side never excludes; known hard
// conflicts exclude with named hard_failures. Sold/reserved machines never
// match. Pure: inputs untouched, no I/O.
function evaluateMachineBuyers(machine, buyers) {
  const results = [];
  const m = machine && typeof machine === 'object' ? machine : {};
  if (['sold', 'reserved'].includes(m.status)) return results;
  const machineBrand = normMatchToken(m.brand);
  const machineModel = canonicalMatchModel(m.model);
  const machineType = normMatchToken(m.machine_type);
  const machineYear = parseInt(m.year ?? m.manufacturing_year, 10) || null;
  const machineHours = parseInt(m.hours ?? m.hour_meter_reading, 10) || null;
  const machinePrice = parseInt(m.asking_price ?? m.target_resale_inr, 10) || null;
  const machineCity = normMatchToken(m.machine_location ?? m.current_location);
  const machineNewUsed = normMatchToken(m.new_or_used);
  const list = Array.isArray(buyers) ? buyers : [];
  // A machine descriptor with no identity at all cannot match anything.
  const hasMachineIdentity = m.machine_id || machineBrand || machineModel;
  if (!hasMachineIdentity) return results;

  for (const buyer of list) {
    const b = buyer && typeof buyer === 'object' ? buyer : {};
    const wantBrand = normMatchToken(b.machine_brand);
    const wantModel = canonicalMatchModel(b.machine_model);
    const wantType = normMatchToken(b.machine_type);
    const budgetMax = parseInt(b.budget_max_inr ?? b.buyer_budget_max_inr, 10) || null;
    const yearMin = parseInt(b.model_year_min, 10) || null;
    const yearMax = parseInt(b.model_year_max, 10) || null;
    const hoursMax = parseInt(b.max_hours ?? b.running_hours_max, 10) || null;
    const wantCity = normMatchToken(b.preferred_city);
    const wantNewUsed = normMatchToken(b.new_or_used);

    let isExact = true;
    const evidence = {};
    const matchedFields = [];
    const mismatchedFields = [];
    const missingFields = [];
    const hardFailures = [];
    let isMatch = true;
    let score = 100;
    const deduct = (n) => { score = Math.max(0, score - n); };
    const unknown = (dim) => { evidence[dim] = 'UNKNOWN / REQUIRES_VERIFICATION'; };

    // Machine type (hard only when both sides known).
    if (wantType) {
      if (machineType && machineType !== wantType) {
        hardFailures.push('machine_type');
        isMatch = false;
      } else if (machineType) {
        evidence.machine_type = 'machine type matched';
        matchedFields.push('machine_type');
      } else {
        unknown('machine_type');
        missingFields.push('machine_type');
      }
    }

    // Brand (hard on known conflict, mirroring buyer-side rule).
    if (wantBrand && wantBrand !== 'any') {
      if (machineBrand && machineBrand === wantBrand) {
        evidence.brand = 'canonical brand matched';
        matchedFields.push('brand');
      } else if (machineBrand) {
        hardFailures.push('brand');
        isMatch = false;
      } else {
        unknown('brand');
        missingFields.push('brand');
      }
    }

    // Model (hard on known conflict after canonical resolution).
    if (wantModel) {
      if (machineModel && machineModel === wantModel) {
        evidence.model = 'canonical model matched';
        matchedFields.push('model');
      } else if (machineModel) {
        hardFailures.push('model');
        isMatch = false;
      } else {
        unknown('model');
        missingFields.push('model');
      }
    }

    if (!isMatch) continue;

    // Budget ceiling (hard; 10% tolerance is an explained alternative).
    if (budgetMax) {
      if (machinePrice && machinePrice <= budgetMax) {
        evidence.budget = 'price satisfies budget';
        matchedFields.push('budget');
      } else if (machinePrice && machinePrice <= budgetMax * 1.1) {
        evidence.budget = `price exceeds budget by ${formatLakhINR(machinePrice - budgetMax)} (within 10% tolerance)`;
        mismatchedFields.push('budget');
        isExact = false;
        deduct(5);
      } else if (machinePrice) {
        hardFailures.push('budget');
        isMatch = false;
      } else {
        unknown('budget');
        missingFields.push('budget');
      }
    } else {
      missingFields.push('budget');
    }
    if (!isMatch) continue;

    // Year range (hard; +/-1 tolerance is an explained alternative).
    if (yearMin || yearMax) {
      if (machineYear) {
        const yMin = yearMin || 2000;
        const yMax = yearMax || 2050;
        if (machineYear >= yMin && machineYear <= yMax) {
          evidence.year = 'year satisfies requirement';
          matchedFields.push('year');
        } else if (machineYear >= yMin - 1 && machineYear <= yMax + 1) {
          evidence.year = 'year within +/- 1 tolerance';
          mismatchedFields.push('year');
          isExact = false;
          deduct(3);
        } else {
          hardFailures.push('year');
          isMatch = false;
        }
      } else {
        unknown('year');
        missingFields.push('year');
      }
    }
    if (!isMatch) continue;

    // Max hours (hard when both known).
    if (hoursMax) {
      if (machineHours) {
        if (machineHours <= hoursMax) {
          evidence.hours = 'hours satisfy requirement';
          matchedFields.push('hours');
        } else {
          hardFailures.push('hours');
          isMatch = false;
        }
      } else {
        unknown('hours');
        missingFields.push('hours');
      }
    }
    if (!isMatch) continue;

    // Location (soft preference).
    if (wantCity) {
      if (machineCity && machineCity === wantCity) {
        evidence.location = 'location matched';
        matchedFields.push('location');
      } else if (machineCity) {
        evidence.location = `machine is in ${m.current_location || m.machine_location} instead of buyer city`;
        mismatchedFields.push('location');
        isExact = false;
        deduct(8);
      } else {
        unknown('location');
        missingFields.push('location');
      }
    }

    // New/used (soft information only: no inventory column proves it).
    if (wantNewUsed) {
      evidence.new_or_used = 'new/used preference noted; inventory new/used not tracked';
    }

    if (!isMatch) continue;

    const matchType = isExact ? 'EXACT_MATCH' : 'ALTERNATIVE_MATCH';
    const matchStatus = matchTypeToStatus(matchType);
    const explanationLines = [];
    for (const [k, v] of Object.entries(evidence)) {
      explanationLines.push(`${k}: ${v}`);
    }
    const result = {
      match_status: matchStatus,
      direction: 'machine_to_buyer',
      buyer_id: b.buyer_id ?? b.run_id ?? b.lead_id ?? null,
      machine_id: m.machine_id ?? null,
      seller_id: m.seller_id ?? null,
      matched_fields: matchedFields,
      mismatched_fields: mismatchedFields,
      missing_fields: missingFields,
      hard_failures: hardFailures,
      match_type: matchType,
      match_score: score,
      matched: true,
      evidence,
      match_explanation: (matchStatus === 'MATCH' ? 'MATCHED' : 'POTENTIAL MATCH') +
        ` (score ${score})` +
        (explanationLines.length ? ' — ' + explanationLines.join('; ') : ''),
    };
    result.owner_review_required = isReviewRequired(result);
    results.push(result);
  }

  results.sort((a, b) => {
    const rank = (s) => (s === 'MATCH' ? 0 : 1);
    if (rank(a.match_status) !== rank(b.match_status)) return rank(a.match_status) - rank(b.match_status);
    if (b.match_score !== a.match_score) return b.match_score - a.match_score;
    return String(a.buyer_id).localeCompare(String(b.buyer_id));
  });

  return results;
}

// Build the canonical buyer-requirement object for matching from a leads
// row (legacy view columns plus raw extracted-variables JSON). Single source
// of truth for requirement shape; missing keys stay null (unknown).
function buildMatchRequirement(row) {
  const r = row && typeof row === 'object' ? row : {};
  const ev = asVarsObject(r.raw_extracted_variables);
  const md = asVarsObject(ev.machine_details);
  const ct = asVarsObject(ev.commercial_terms);
  return {
    machine_brand: r.machine_brand ?? null,
    machine_model: r.machine_model ?? null,
    required_tonnage_class: r.required_tonnage_class ?? null,
    buyer_budget_max_inr: r.buyer_budget_max_inr ?? ct.budget_max_inr ?? null,
    application_history: r.application_history ?? null,
    purchase_timeline: r.purchase_timeline ?? ct.purchase_timeline ?? null,
    machine_type: md.machine_type ?? null,
    budget_min: ct.budget_min_inr ?? null,
    model_year_min: md.model_year_min ?? null,
    model_year_max: md.model_year_max ?? null,
    max_hours: md.max_hours ?? null,
    preferred_city: md.preferred_city ?? r.machine_location_city ?? null,
    new_or_used: md.new_or_used ?? null,
    lead_status: ev.lead_status ?? null,
  };
}

// Active sellable inventory for one organization (source of truth for
// matching). Availability follows existing status semantics; unknown
// statuses are never treated as available.
async function loadMatchStock(organizationId) {
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return [];
  try {
      const sql = `
        SELECT COALESCE(json_agg(t), '[]'::json) FROM (
          SELECT machine_id, brand, model, manufacturing_year, hour_meter_reading,
                 application_history, target_resale_inr, status, current_location, organization_id
          FROM vaani_machines
          WHERE organization_id = $1 AND status IN ('in_sourcing_pipeline', 'certified_ready_in_yard')
        ) t
      `;
      return await queryPostgres(sql, [orgInt]) || [];
  } catch (err) {
      console.error('[VAANI SALES] Error fetching stock for matching:', err);
      return [];
  }
}

async function runIntelligentMatching(organizationId, buyerRunId, buyerRequirement) {
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) throw new Error("Invalid organization ID");

  // Load active inventory WITH target_resale_inr (internal use only)
  const stock = await loadMatchStock(orgInt);

  // Evaluate
  const matches = evaluateBuyerMatches(buyerRequirement, stock);
  
  if (matches.length > 0) {
    // Persist matches (score block embedded in evidence_json: no migration)
    for (const m of matches) {
      const buyerRunInt = parseInt(buyerRunId, 10);
      // Idempotency guard: the relay replays the same payload on a transient
      // failure, so an identical match must never be stored twice. The table
      // has no unique constraint (adding one would be a migration), so the
      // check is explicit and code-only.
      const existing = await queryPostgres(
        `SELECT id FROM vaani_buyer_machine_matches
         WHERE organization_id = $1 AND buyer_run_id = $2 AND inventory_machine_id = $3 AND match_type = $4
         LIMIT 1;`,
        [orgInt, buyerRunInt, m.machine_id, m.match_type]
      ).catch(() => null);
      if (existing !== null && existing !== undefined && String(existing).trim() !== '') {
        continue; // already stored for this run — do not duplicate it
      }
      const insertSql = `
        INSERT INTO vaani_buyer_machine_matches
        (organization_id, buyer_run_id, inventory_machine_id, match_type, evidence_json)
        VALUES ($1, $2, $3, $4, $5)
      `;
      const storedEvidence = {
        ...m.evidence,
        match_score: m.match_score,
        matched_fields: m.matched_fields,
        mismatched_fields: m.mismatched_fields,
        missing_requirement_fields: m.missing_requirement_fields,
        match_explanation: m.match_explanation,
      };
      await queryPostgres(insertSql, [orgInt, buyerRunInt, m.machine_id, m.match_type, JSON.stringify(storedEvidence)]).catch(e => {
        console.error("Error inserting match:", e.message);
      });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Goal 33 Sales Pipeline: read-only derived operational view. buildSalesPipeline
// is pure assembly over pre-loaded org-scoped arrays (buyers, sellers, stock,
// transcripts grouped by run id, latest call per run); getSalesPipeline
// performs the small fixed set of batched reads (no N+1) and never writes.
// ---------------------------------------------------------------------------

function buildSalesPipelineRow(side, row, ctx) {
  const r = row && typeof row === 'object' ? row : {};
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const runId = r.run_id ?? r.lead_id ?? null;
  const name = r.caller_name || r.customer_name || null;
  const phone = r.callback_number || r.primary_phone || r.phone_number || null;
  const qual = evaluateQualificationCompleteness(
    side, resolveQualificationFields(side, r), r.dnc_requested === true
  );
  const matches = side === 'buyer'
    ? evaluateBuyerMatches(buildMatchRequirement(r), c.stock || [])
    : [];
  const potentialBuyers = side === 'seller' && c.sellersMachine
    ? evaluateMachineBuyers(c.sellersMachine, [r]).filter((m) => m.match_status !== 'NO_MATCH')
    : (side === 'seller' && Array.isArray(c.sellerMatches) ? c.sellerMatches : []);
  const segs = (c.transcriptsByRun && runId !== null && runId !== undefined)
    ? (c.transcriptsByRun[String(runId)] || []) : [];
  const best = matches.length ? matches[0] : null;
  const objections = detectObjections(side, segs, {
    budget: r.buyer_budget_max_inr ?? null,
    inventory_price: best && best.machine ? (best.machine.target_resale_inr ?? null) : null,
  });
  const ownerObjections = objections.filter((o) => o.owner_needed === true);
  const followup = buildFollowUpRecommendation({
    customer_type: side,
    qualification: qual,
    objections,
    matches,
    phone,
    existingNextAction: r.next_action || null,
    followUpDatetime: r.follow_up_datetime || null,
    dnc_requested: r.dnc_requested === true,
  });
  const lastCall = (c.callsByRun && runId !== null && runId !== undefined)
    ? (c.callsByRun[String(runId)] || null) : null;
  const stageInput = {
    customer_type: side,
    lifecycleStage: r.lifecycle_stage || null,
    isLost: false,
    dnc_requested: r.dnc_requested === true,
    ownerReviewNeeded: ownerObjections.length > 0,
    ownerReviewReason: ownerObjections.length
      ? `owner-needed open objection: ${[...new Set(ownerObjections.map((o) => o.type))].join(', ')}` : null,
    followupNeeded: followup.needed && !followup.owner_required,
    followupReason: followup.needed && !followup.owner_required ? followup.reason : null,
    hasMatches: side === 'buyer' ? matches.length > 0 : potentialBuyers.length > 0,
    matchDetail: side === 'buyer'
      ? (best ? `${matches.length} compatible machine${matches.length === 1 ? '' : 's'}` : null)
      : (potentialBuyers.length ? `${potentialBuyers.length} potential buyer${potentialBuyers.length === 1 ? '' : 's'}` : null),
    isComplete: qual.status === 'QUALIFIED',
    hasPartial: qual.status === 'PARTIALLY_QUALIFIED',
  };
  const { stage, stage_reason } = derivePipelineStage(stageInput);
  return {
    lead_id: runId,
    run_id: runId,
    customer_type: side,
    name,
    phone,
    stage,
    stage_reason,
    qualification_status: qual.status,
    collected_fields: qual.collected_fields,
    missing_fields: qual.missing_fields,
    match_count: side === 'buyer' ? matches.length : potentialBuyers.length,
    best_match: best ? {
      machine_id: best.machine_id ?? null,
      brand: best.machine ? best.machine.brand : null,
      model: best.machine ? best.machine.model : null,
      match_score: best.match_score ?? null,
      match_type: best.match_type ?? null,
    } : null,
    owner_review_required: ownerObjections.length > 0,
    followup_needed: followup.needed,
    followup_priority: followup.needed ? followup.priority : null,
    next_action: followup.needed ? followup.recommended_action : (r.next_action || null),
    last_activity: (lastCall && (lastCall.created_at || lastCall.ended_at)) || r.created_at || null,
    last_call_status: (lastCall && lastCall.status) || null,
    last_call_outcome: (lastCall && lastCall.outcome) || r.conversation_outcome || null,
  };
}

function buildSalesPipeline({ buyers, sellers, stock, transcriptsByRun, callsByRun, sellerMatchesByRun }) {
  const c = {
    stock: Array.isArray(stock) ? stock : [],
    transcriptsByRun: transcriptsByRun && typeof transcriptsByRun === 'object' ? transcriptsByRun : {},
    callsByRun: callsByRun && typeof callsByRun === 'object' ? callsByRun : {},
    sellersMachine: null,
  };
  const buyerRows = (Array.isArray(buyers) ? buyers : []).map((r) => buildSalesPipelineRow('buyer', r, c));
  const sellerBase = { ...c };
  const sellerRows = (Array.isArray(sellers) ? sellers : []).map((r) => {
    const machineDesc = {
      machine_id: null,
      brand: r.machine_brand || null,
      model: r.machine_model || null,
      machine_type: r.machine_type ?? null,
      manufacturing_year: r.model_year ?? null,
      hour_meter_reading: r.running_hours ?? null,
      target_resale_inr: r.expected_selling_price_inr ?? null,
      current_location: r.machine_location_city || r.location_city || null,
      status: 'in_sourcing_pipeline',
      // B4: informational passthrough of stored attributes. The matching
      // engine only scores fields it explicitly reads; the rest travel
      // harmlessly for display/debugging and future use.
      application_history: r.application_history ?? null,
      condition: r.condition ?? null,
      tonnage_class: r.tonnage_class ?? null,
      machine_condition_summary: r.machine_condition_summary ?? null,
    };
    const withMachine = { ...sellerBase, sellersMachine: null };
    const base = buildSalesPipelineRow('seller', r, withMachine);
    const potentials = evaluateMachineBuyers(machineDesc, Array.isArray(buyers) ? buyers : []);
    const openObjections = detectObjections('seller', ((withMachine.transcriptsByRun || {})[String(r.run_id ?? r.lead_id)] || []), {});
    const ownerNeeded = openObjections.some((o) => o.owner_needed);
    const followup = buildFollowUpRecommendation({
      customer_type: 'seller',
      qualification: { status: base.qualification_status, collected_fields: base.collected_fields, missing_fields: base.missing_fields },
      objections: openObjections,
      matches: [],
      phone: base.phone,
      existingNextAction: r.next_action || null,
      followUpDatetime: r.follow_up_datetime || null,
      dnc_requested: r.dnc_requested === true,
    });
    const restaged = derivePipelineStage({
      customer_type: 'seller',
      lifecycleStage: r.lifecycle_stage || null,
      isLost: false,
      dnc_requested: r.dnc_requested === true,
      ownerReviewNeeded: ownerNeeded,
      ownerReviewReason: ownerNeeded ? 'owner-needed open objection' : null,
      followupNeeded: followup.needed && !followup.owner_required,
      followupReason: followup.needed && !followup.owner_required ? followup.reason : null,
      hasMatches: potentials.length > 0,
      matchDetail: potentials.length ? `${potentials.length} potential buyer${potentials.length === 1 ? '' : 's'}` : null,
      isComplete: base.qualification_status === 'QUALIFIED',
      hasPartial: base.qualification_status === 'PARTIALLY_QUALIFIED',
    });
    return {
      ...base,
      stage: restaged.stage,
      stage_reason: restaged.stage_reason,
      match_count: potentials.length,
      best_match: null,
      potential_buyers: potentials.slice(0, 5).map((m, i) => ({
        buyer_label: 'Buyer ' + String.fromCharCode(65 + i),
        match_status: m.match_status,
        match_score: m.match_score,
        matched_fields: m.matched_fields,
        mismatched_fields: m.mismatched_fields,
        owner_review_required: m.owner_review_required,
      })),
      owner_review_required: ownerNeeded,
      followup_needed: followup.needed,
      followup_priority: followup.needed ? followup.priority : null,
      next_action: followup.needed ? followup.recommended_action : base.next_action,
    };
  });
  return { buyers: buyerRows, sellers: sellerRows };
}

// Batched loader for the pipeline view: fixed small query set over
// org-scoped data (buyers, sellers, stock, transcripts grouped by run,
// latest call per run). Read-only: zero writes by construction.
async function getSalesPipeline(organizationId, queryFn) {
  const q = queryFn || queryPostgres;
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) throw new Error('Organization not linked');
  const buyers = await getBuyers({}, false, orgInt);
  const sellers = await getSellers({}, false, orgInt);
  const stock = await loadMatchStock(orgInt);
  const txRows = await q(`
    SELECT COALESCE(json_agg(t ORDER BY t.ts ASC NULLS LAST, t.sid ASC), '[]'::json) FROM (
      SELECT c.dograh_call_id AS run_id, t.id AS sid, t.speaker, t.message, t.timestamp AS ts
      FROM vaani_transcripts t JOIN vaani_calls c ON c.id = t.call_id
      JOIN workflow_runs r ON r.id = (CASE WHEN c.dograh_call_id ~ '^[0-9]+$' THEN c.dograh_call_id::int ELSE NULL END)
      JOIN workflows w ON w.id = r.workflow_id
      WHERE w.organization_id = $1
      ORDER BY t.timestamp ASC NULLS LAST, t.id ASC LIMIT 5000
    ) t;
  `, [orgInt]).catch(() => []);
  const transcriptsByRun = {};
  for (const row of (Array.isArray(txRows) ? txRows : [])) {
    if (!row || row.run_id === undefined || row.run_id === null) continue;
    const k = String(row.run_id);
    (transcriptsByRun[k] = transcriptsByRun[k] || []).push({ speaker: row.speaker, message: row.message, timestamp: row.ts });
  }
  const callRows = await q(`
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT DISTINCT ON (c.dograh_call_id) c.dograh_call_id AS run_id, c.status, c.ended_at, c.created_at,
             s.outcome, s.next_action
      FROM vaani_calls c
      LEFT JOIN vaani_call_summaries s ON s.call_id = c.id
      JOIN workflow_runs r ON r.id = (CASE WHEN c.dograh_call_id ~ '^[0-9]+$' THEN c.dograh_call_id::int ELSE NULL END)
      JOIN workflows w ON w.id = r.workflow_id
      WHERE w.organization_id = $1 AND c.dograh_call_id IS NOT NULL AND c.dograh_call_id <> ''
      ORDER BY c.dograh_call_id, c.id DESC
    ) t;
  `, [orgInt]).catch(() => []);
  const callsByRun = {};
  for (const row of (Array.isArray(callRows) ? callRows : [])) {
    if (row && row.run_id !== undefined && row.run_id !== null) callsByRun[String(row.run_id)] = row;
  }
  return buildSalesPipeline({ buyers, sellers, stock, transcriptsByRun, callsByRun });
}

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

function queryPostgres(sql, params = []) {
  const timeout = 8000;

  const parseResponse = (stdout) => {
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
          try {
            return JSON.parse(line);
          } catch (_) {}
        }
      }
      return trimmed;
    }
  };

  // Supabase only. queryParams fails closed when VAANI_DATABASE_URL is unset.
  return new Promise((resolve, reject) => {
    supadb.queryParams(sql, params, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      try {
        resolve(parseResponse(stdout));
      } catch (parseErr) {
        resolve(stdout.trim());
      }
    });
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
                 next_action, follow_up_required, follow_up_datetime, call_notes, dnc_requested,
                 raw_extracted_variables
          FROM vaani_excavator_sales_leads
          WHERE organization_id = $1 AND customer_type = 'seller'
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql, [orgInt]);
      sellers = (Array.isArray(result) ? result : []).map(projectStructuredSellerFields);
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

// Read a possibly-stringified extracted-variables blob as an object.
function asVarsObject(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    const p = JSON.parse(v);
    return p && typeof p === 'object' ? p : {};
  } catch (_) {
    return {};
  }
}

// Project structured requirement fields from the raw extracted-variables
// JSON onto buyer rows. Missing keys stay null (unknown), never fabricated.
// View-level columns keep precedence where present.
function projectStructuredBuyerFields(b) {
  const ev = asVarsObject(b.raw_extracted_variables);
  const md = asVarsObject(ev.machine_details);
  const ct = asVarsObject(ev.commercial_terms);
  return {
    ...b,
    // B4: read-only JSON fallbacks for stored spec fields (no SQL change).
    application_history: b.application_history ?? md.application_history ?? null,
    machine_type: md.machine_type ?? null,
    budget_min: ct.budget_min_inr ?? null,
    budget_max: ct.budget_max_inr ?? b.buyer_budget_max_inr ?? null,
    year_min: md.model_year_min ?? null,
    year_max: md.model_year_max ?? null,
    max_hours: md.max_hours ?? null,
    preferred_city: md.preferred_city ?? null,
    purchase_timeline: b.purchase_timeline ?? ct.purchase_timeline ?? null,
    lead_status: ev.lead_status ?? null,
    deal_readiness: b.deal_readiness ?? ev.deal_readiness ?? null,
    sales_priority: b.sales_priority ?? ev.sales_priority ?? null,
  };
}

// Same projection for seller rows: machine/condition/availability context
// with view columns taking precedence where present.
function projectStructuredSellerFields(b) {
  const ev = asVarsObject(b.raw_extracted_variables);
  const md = asVarsObject(ev.machine_details);
  const ct = asVarsObject(ev.commercial_terms);
  return {
    ...b,
    // B4: read-only JSON fallbacks for stored spec fields (no SQL change).
    application_history: b.application_history ?? md.application_history ?? null,
    tonnage_class: md.tonnage_class ?? null,
    machine_condition_summary: md.machine_condition_summary ?? null,
    document_status: md.document_status ?? null,
    machine_type: md.machine_type ?? null,
    condition: md.condition ?? null,
    availability_status: ev.availability_status ?? null,
    year: b.model_year ?? md.model_year ?? null,
    hours: b.running_hours ?? md.running_hours ?? null,
    asking_price: b.expected_selling_price_inr ?? ct.expected_price_inr ?? null,
    machine_location: b.machine_location_city ?? md.location_city ?? null,
    deal_readiness: b.deal_readiness ?? ev.deal_readiness ?? null,
    sales_priority: b.sales_priority ?? ev.sales_priority ?? null,
  };
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
                 buyer_budget_max_inr, expected_selling_price_inr AS expected_price_inr, price_raw, purchase_timeline,
                 machine_location_city, machine_location_state,
                 yard_visit_agreed, yard_visit_schedule,
                 lead_temperature, qualification_state, conversation_outcome,
                 next_action, follow_up_required, follow_up_datetime, call_notes, dnc_requested,
                 raw_extracted_variables
          FROM vaani_excavator_sales_leads
          WHERE organization_id = $1 AND customer_type = 'buyer'
          ORDER BY run_id DESC
        ) t;
      `;
      const result = await queryPostgres(sql, [orgInt]);
      buyers = (Array.isArray(result) ? result : []).map(projectStructuredBuyerFields);
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
          SELECT m.machine_id, m.brand, m.model, m.manufacturing_year, m.hour_meter_reading,
                 m.application_history, m.sourcing_cost_inr, m.target_resale_inr, m.status,
                 m.current_location, m.created_at,
                 (SELECT r.gathered_context -> 'extracted_variables' ->> 'caller_name'
                    FROM public.workflow_runs r
                    JOIN public.workflows w ON w.id = r.workflow_id
                   WHERE r.id = m.source_lead_run_id AND w.organization_id = $1) AS seller_name
          FROM vaani_machines m
          WHERE m.organization_id = $1
          ORDER BY m.created_at DESC
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

// Buyer-available inventory allowlist. Mirrors the stock loader used by
// runIntelligentMatching: only sourced/certified machines are matchable.
// An explicit status filter overrides the default but stays org-scoped.
const INTERNAL_MACHINE_AVAILABLE_STATUSES = ['in_sourcing_pipeline', 'certified_ready_in_yard'];

// Pure query builder for the internal inventory API. The organization_id
// predicate is always first and mandatory: callers must pass a verified,
// server-resolved org id. Returns null when no valid org can be established
// so the async boundary fails closed without touching the database.
function buildInternalMachinesQuery(organizationId, filters = {}) {
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return null;
  const conditions = [`organization_id = $1`];
  const params = [orgInt];
  let paramIndex = 2;

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
  } else {
    conditions.push(`status IN ('in_sourcing_pipeline', 'certified_ready_in_yard')`);
  }

  // Explicitly excluding sourcing_cost_inr and target_resale_inr
  const sql = `
      SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT machine_id, brand, model, manufacturing_year, status, current_location
        FROM vaani_machines
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT 50
      ) t;
    `;
  return { sql, params, organizationId: orgInt };
}

async function getInternalMachines(organizationId, filters = {}) {
  const built = buildInternalMachinesQuery(organizationId, filters);
  if (!built) return [];
  try {
    const result = await queryPostgres(built.sql, built.params);
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

    // Intelligent Matching
    const matches = buyers.map((b) => {
      const intelligentMatches = evaluateBuyerMatches(b, stock);
      return {
        buyer_lead_id: b.lead_id,
        buyer_name: b.customer_name,
        buyer_phone: b.primary_phone,
        requested_machine: b.machine_brand || b.required_tonnage_class,
        budget_max_inr: b.buyer_budget_max_inr,
        matching_stock: intelligentMatches.map(m => m.machine),
        intelligent_matches: intelligentMatches
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
      const intelligentMatches = evaluateBuyerMatches(b, stock);
      return {
        buyer_lead_id: b.lead_id,
        buyer_name: b.customer_name,
        buyer_phone: b.primary_phone,
        requested_machine: b.machine_brand || b.required_tonnage_class,
        budget_max_inr: b.buyer_budget_max_inr,
        matching_stock: intelligentMatches.map(m => m.machine),
        intelligent_matches: intelligentMatches
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
      if (list.length) {
        // Follow-up status lives in workflow_runs.annotations so it survives restarts.
        const ids = list.map((item) => parseInt(item.id, 10)).filter((id) => !isNaN(id));
        if (ids.length) {
          const statusJson = await queryPostgres(
            `SELECT COALESCE(json_object_agg(id, COALESCE(annotations::jsonb ->> 'vaani_follow_up_status', 'pending')), '{}'::json)
             FROM workflow_runs WHERE id = ANY($1::int[]);`,
            [ids]
          );
          if (statusJson && typeof statusJson === 'object') {
            for (const item of list) {
              if (statusJson[String(item.id)]) item.status = statusJson[String(item.id)];
            }
          }
        }
      }
    } catch (err) {
      console.error('[VAANI SALES] Error querying follow-ups from PG:', err.message);
      list = [];
    }
  }

  // Demo mode still uses the in-memory overlay; real rows persist in Supabase.
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
    // The Calls tab reads workflow_runs directly: it is the single source the
    // Buyers/Sellers tabs and the Lead 360 drawer already use. vaani_calls is
    // legacy and is not written by ingestion.
    const sql = `
      SELECT COALESCE(json_agg(t ORDER BY t.created_at DESC), '[]'::json) FROM (
        SELECT r.id AS call_id,
               r.id AS run_id,
               r.created_at,
               to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY, hh12:MI AM') AS formatted_time,
               COALESCE(r.gc -> 'call_session' ->> 'direction', 'inbound') AS direction,
               COALESCE(r.gc -> 'call_session' ->> 'status', 'completed') AS status,
               COALESCE((r.gc -> 'call_session' ->> 'duration')::int, 0) AS duration,
               r.gc -> 'call_session' ->> 'started_at' AS started_at,
               r.gc -> 'call_session' ->> 'ended_at' AS ended_at,
               r.gc -> 'extracted_variables' ->> 'caller_name' AS customer_name,
               r.gc -> 'extracted_variables' ->> 'caller_name' AS caller_name,
               r.gc -> 'extracted_variables' ->> 'callback_number' AS primary_phone,
               COALESCE(r.gc -> 'extracted_variables' ->> 'customer_type', 'unknown') AS customer_type,
               COALESCE(r.gc -> 'extracted_variables' ->> 'conversation_outcome', r.gc -> 'call_session' ->> 'outcome', 'unknown') AS conversation_outcome,
               COALESCE(r.gc -> 'extracted_variables' ->> 'lead_temperature', r.gc -> 'call_session' ->> 'lead_temperature', 'unknown') AS lead_temperature,
               COALESCE(r.gc -> 'extracted_variables' ->> 'qualification_state', 'unknown') AS qualification_state,
               COALESCE(r.gc -> 'extracted_variables' ->> 'next_action', '') AS next_action,
               COALESCE(r.gc -> 'extracted_variables' -> 'machine_details' ->> 'brand', '') AS machine_brand,
               COALESCE(r.gc -> 'extracted_variables' -> 'machine_details' ->> 'model', '') AS machine_model,
               r.recording_url,
               r.transcript_url,
               (r.recording_url IS NOT NULL AND r.recording_url <> '') AS has_audio,
               r.gc -> 'call_session' -> 'transcript' AS transcript
        FROM (
          SELECT r.*, r.gathered_context::jsonb AS gc
          FROM workflow_runs r
          JOIN workflows w ON w.id = r.workflow_id
          WHERE w.organization_id = $1 AND COALESCE(r.mode, '') <> 'manual'
        ) r
      ) t;
    `;
    const result = await queryPostgres(sql, [orgInt]);
    const calls = Array.isArray(result) ? result : [];
    // Reuse the existing helpers so the transcript rows and the stored summary
    // come from exactly the same place the Lead 360 view reads them.
    const withTranscripts = await attachCallTranscripts(calls, orgInt);
    const withSummaries = await attachCallSummaries(withTranscripts);
    return withSummaries.map((c) => ({
      ...c,
      recording_url: resolveArtifactUrl(c.recording_url),
      transcript_url: resolveArtifactUrl(c.transcript_url),
      has_transcript: Array.isArray(c.transcript) ? c.transcript.length > 0 : false,
      transcript_count: Array.isArray(c.transcript) ? c.transcript.length : 0,
      machine_summary: [c.machine_brand, c.machine_model].filter(Boolean).join(' '),
      run_linked: true,
    }));
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
        'customer_name', r.gathered_context::jsonb -> 'extracted_variables' ->> 'caller_name',
        'primary_phone', r.gathered_context::jsonb -> 'extracted_variables' ->> 'callback_number',
        'customer_type', COALESCE(r.gathered_context::jsonb -> 'extracted_variables' ->> 'customer_type', 'unknown'),
        'conversation_outcome', r.gathered_context::jsonb -> 'extracted_variables' ->> 'conversation_outcome',
        'lead_temperature', r.gathered_context::jsonb -> 'extracted_variables' ->> 'lead_temperature',
        'qualification_state', r.gathered_context::jsonb -> 'extracted_variables' ->> 'qualification_state',
        'next_action', r.gathered_context::jsonb -> 'extracted_variables' ->> 'next_action',
        'dnc_requested', COALESCE((r.gathered_context::jsonb -> 'extracted_variables' ->> 'dnc_requested')::boolean, false),
        'extracted_variables', r.gathered_context::jsonb -> 'extracted_variables',
        'recording_url', r.recording_url,
        'transcript_url', r.transcript_url,
        'transcript', r.gathered_context::jsonb -> 'call_session' -> 'transcript',
        'has_audio', (r.recording_url IS NOT NULL AND r.recording_url <> ''),
        'call_id', (SELECT vc.id FROM vaani_calls vc WHERE vc.dograh_call_id = r.id::text ORDER BY vc.id DESC LIMIT 1),
        'call_status', (SELECT vc.status FROM vaani_calls vc WHERE vc.dograh_call_id = r.id::text ORDER BY vc.id DESC LIMIT 1),
        'direction', (SELECT vc.direction FROM vaani_calls vc WHERE vc.dograh_call_id = r.id::text ORDER BY vc.id DESC LIMIT 1),
        'duration', (SELECT vc.duration FROM vaani_calls vc WHERE vc.dograh_call_id = r.id::text ORDER BY vc.id DESC LIMIT 1),
        'started_at', (SELECT vc.started_at FROM vaani_calls vc WHERE vc.dograh_call_id = r.id::text ORDER BY vc.id DESC LIMIT 1),
        'ended_at', (SELECT vc.ended_at FROM vaani_calls vc WHERE vc.dograh_call_id = r.id::text ORDER BY vc.id DESC LIMIT 1)
      )
      FROM workflow_runs r
      JOIN workflows w ON r.workflow_id = w.id
      WHERE r.id = $1 AND w.organization_id = $2;
    `;
    const result = await queryPostgres(sql, [runInt, orgInt]);
    if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
    // Reuse the existing helpers for the real transcript rows and the stored
    // summary, exactly like the Lead 360 view does.
    const runKey = String(runInt);
    const [withTranscript] = await attachCallTranscripts([{ run_id: runKey }], orgInt);
    const [withSummary] = await attachCallSummaries([{ run_id: runKey }]);
    return {
      ...result,
      transcript: (Array.isArray(result.transcript) && result.transcript.length)
        ? result.transcript
        : ((withTranscript && Array.isArray(withTranscript.transcript)) ? withTranscript.transcript : []),
      summary: (withSummary && withSummary.summary) ? withSummary.summary : null,
      recording_url: resolveArtifactUrl(result.recording_url),
      transcript_url: resolveArtifactUrl(result.transcript_url),
      has_audio: Boolean(result.has_audio),
    };
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
    const updated = await queryPostgres(
      `UPDATE workflow_runs
       SET annotations = jsonb_set(COALESCE(annotations::jsonb, '{}'::jsonb), '{vaani_follow_up_status}', to_jsonb($3::text))
       WHERE id = $1 AND workflow_id IN (SELECT id FROM workflows WHERE organization_id = $2)
       RETURNING id;`,
      [runInt, orgInt, lowerStatus]
    );
    if (!updated) {
      const err = new Error('Follow-up record not found for organization');
      err.code = 'not_found';
      throw err;
    }
    return { success: true, id: followUpId, status: lowerStatus, updated_at: new Date().toISOString() };
  }

  // Demo mode has no organization, so the overlay is intentionally in-memory.
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

  // Goal 24 deterministic qualification: status + per-requirement gaps for
  // keys without a dedicated entry above. Same arrays, no parallel system.
  // Labels/hints only; values below come straight from resolved lead fields.
  const QUALIFICATION_LABELS = {
    machine_type: ['Machine Type', 'Ask machine category (Excavator, Backhoe, Crane)'],
    budget: ['Budget Range', 'Establish min/max investment budget'],
    budget_min: ['Budget Min', 'Establish minimum investment budget'],
    preferred_city: ['Preferred City', 'Confirm preferred machine city'],
    new_or_used: ['New / Used', 'Clarify new vs used preference'],
    purchase_timeline: ['Purchase Timeline', 'Clarify buying urgency'],
    finance_required: ['Finance Required', 'Ask if finance is needed'],
    payment_mode: ['Payment Mode', 'Ask finance vs full payment'],
    brand: ['Make', 'Ask preferred make'],
    model: ['Model', 'Ask exact model'],
    year: ['Model Year', 'Inquire model year'],
    hours: ['Operating Hours', 'Request current meter reading'],
    condition: ['Machine Condition', 'Verify overall machine condition'],
    availability_status: ['Availability', 'Confirm machine availability status'],
    asking_price: ['Asking Price', 'Explore expected in-hand amount'],
    machine_location: ['Machine Location', 'Clarify yard/site location'],
    lead_status: ['Lead Status', 'Confirm current lead status'],
  };
  const qualFields = resolveQualificationFields(lead.customer_type, lead);
  const completeness = evaluateQualificationCompleteness(lead.customer_type, qualFields, false);
  captured.push({
    field: 'AI Qualification', key: 'ai_qualification_status', label: 'AI Qualification',
    value: `${completeness.status} (${completeness.collected_fields.length}/${completeness.collected_fields.length + completeness.missing_fields.length} requirement fields)`,
  });
  const coveredKeys = new Set([...captured.map((c) => c.key), ...missing.map((m) => m.key)]);
  // Alias equivalence: a requirement already covered under a legacy entry key
  // must not produce a second gap entry for the same information.
  const QUALIFICATION_COVERED_BY = {
    brand: ['machine_brand'], model: ['machine_model'], year: ['model_year'],
    hours: ['running_hours'], machine_location: ['location'], asking_price: ['expected_price'],
    preferred_city: ['location'], budget: ['budget'], new_or_used: ['used_or_refurbished'],
    purchase_timeline: ['purchase_timeline'],
  };
  for (const key of completeness.missing_fields) {
    const entryKey = 'ai_missing_' + key;
    const aliases = QUALIFICATION_COVERED_BY[key] || [];
    if (coveredKeys.has(key) || coveredKeys.has(entryKey) || aliases.some((a) => coveredKeys.has(a))) continue;
    const [label, hint] = QUALIFICATION_LABELS[key] || [key, 'Collect during qualification'];
    missing.push({ field: label, key: entryKey, label, hint });
  }

  return { captured, missing, qualification: completeness };
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

// Attach stored transcript segments to linked calls in one query. Segments
// inherit the lead's organization: only transcripts whose call resolves to
// the same org are attached. Calls without stored segments get [].
async function attachCallTranscripts(calls, organizationId) {
  if (!Array.isArray(calls) || !calls.length) return calls;
  try {
    const orgInt = parseInt(organizationId, 10);
    const runKeys = [...new Set(calls
      .map((c) => (c && c.run_id !== undefined && c.run_id !== null ? String(c.run_id).trim() : ''))
      .filter(Boolean))];
    if (!runKeys.length) return calls.map((c) => ({ ...c, transcript: [] }));
    const quoted = runKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(',');
    const rows = await queryPostgres(`
      SELECT COALESCE(json_agg(t ORDER BY t.run_id, t.ts ASC NULLS LAST, t.speaker), '[]'::json) FROM (
        SELECT c.dograh_call_id AS run_id, t.speaker, t.message, t.timestamp AS ts, w.organization_id AS org
        FROM vaani_transcripts t JOIN vaani_calls c ON c.id = t.call_id
        LEFT JOIN workflow_runs r ON r.id = (CASE WHEN c.dograh_call_id ~ '^[0-9]+$' THEN c.dograh_call_id::int ELSE NULL END)
        LEFT JOIN workflows w ON w.id = r.workflow_id
      ) t WHERE t.run_id IN (${quoted});
    `).catch(() => []);
    const byRun = {};
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!row || row.run_id === undefined || row.run_id === null) continue;
      if (!isNaN(orgInt) && row.org !== null && row.org !== undefined && parseInt(row.org, 10) !== orgInt) continue;
      (byRun[String(row.run_id)] = byRun[String(row.run_id)] || []).push({
        speaker: row.speaker || null,
        message: row.message || '',
        timestamp: row.ts || null,
      });
    }
    return calls.map((c) => ({
      ...c,
      transcript: Array.isArray(c.transcript) && c.transcript.length
        ? c.transcript
        : (byRun[String(c.run_id)] || []),
    }));
  } catch (e) {
    return calls.map((c) => ({ ...c, transcript: c.transcript || [] }));
  }
}

// Attach persisted summary outcome/next-action to linked calls in one
// query. Calls without a stored summary get summary: null (never faked).
async function attachCallSummaries(calls) {
  if (!Array.isArray(calls) || !calls.length) return calls;
  try {
    const runKeys = [...new Set(calls
      .map((c) => (c && c.run_id !== undefined && c.run_id !== null ? String(c.run_id).trim() : ''))
      .filter(Boolean))];
    if (!runKeys.length) return calls.map((c) => ({ ...c, summary: null }));
    const quoted = runKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(',');
    const rows = await queryPostgres(`
      SELECT COALESCE(json_agg(t), '[]'::json) FROM (
        SELECT c.dograh_call_id AS run_id, s.customer_requirement, s.machine_discussed,
               s.interest_level, s.budget, s.customer_intent, s.outcome, s.next_action
        FROM vaani_call_summaries s JOIN vaani_calls c ON c.id = s.call_id
        WHERE c.dograh_call_id IN (${quoted})
      ) t;
    `).catch(() => []);
    const byRun = {};
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (row && row.run_id !== undefined && row.run_id !== null) {
        byRun[String(row.run_id)] = {
          customer_requirement: row.customer_requirement || null,
          machine_discussed: row.machine_discussed || null,
          interest_level: row.interest_level || null,
          budget: row.budget || null,
          customer_intent: row.customer_intent || null,
          outcome: row.outcome || null,
          next_action: row.next_action || null,
        };
      }
    }
    return calls.map((c) => ({ ...c, summary: byRun[String(c.run_id)] || null }));
  } catch (e) {
    return calls.map((c) => ({ ...c, summary: (c && c.summary) || null }));
  }
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
          'recording_url', r.recording_url,
          'transcript', r.gathered_context -> 'call_session' -> 'transcript',
          'raw_extracted_variables', r.gathered_context -> 'extracted_variables',
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
          'budget_min_inr', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'commercial_terms') ->> 'budget_min_inr')::bigint, ((r.gathered_context -> 'extracted_variables') ->> 'budget_min_inr')::bigint),
          'machine_type', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'machine_type', (r.gathered_context -> 'extracted_variables') ->> 'machine_type'),
          'model_year_min', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'model_year_min')::integer, ((r.gathered_context -> 'extracted_variables') ->> 'model_year_min')::integer),
          'model_year_max', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'model_year_max')::integer, ((r.gathered_context -> 'extracted_variables') ->> 'model_year_max')::integer),
          'max_hours', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'max_hours')::integer, ((r.gathered_context -> 'extracted_variables') ->> 'max_hours')::integer),
          'preferred_city', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'preferred_city', (r.gathered_context -> 'extracted_variables') ->> 'preferred_city'),
          'new_or_used', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'new_or_used', (r.gathered_context -> 'extracted_variables') ->> 'new_or_used'),
          'condition', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'condition', (r.gathered_context -> 'extracted_variables') ->> 'condition'),
          'availability_status', (r.gathered_context -> 'extracted_variables') ->> 'availability_status',
          'finance_required', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'commercial_terms') ->> 'finance_required')::boolean, ((r.gathered_context -> 'extracted_variables') ->> 'finance_required')::boolean),
          'payment_mode', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'commercial_terms') ->> 'payment_mode', (r.gathered_context -> 'extracted_variables') ->> 'payment_mode'),
          'lead_status', (r.gathered_context -> 'extracted_variables') ->> 'lead_status',
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
          'rc_copy_agreed', COALESCE((((r.gathered_context -> 'extracted_variables') -> 'evidence_readiness') ->> 'rc_copy_agreed')::boolean, ((r.gathered_context -> 'extracted_variables') ->> 'rc_copy_agreed')::boolean, false),
          'seller_concerns', COALESCE((r.gathered_context -> 'extracted_variables') -> 'seller_concerns', '[]'::json),
          'price_negotiable', ((r.gathered_context -> 'extracted_variables') -> 'commercial_terms' ->> 'price_negotiable')::boolean,
          'sale_urgency', (r.gathered_context -> 'extracted_variables') -> 'commercial_terms' ->> 'sale_urgency',
          'whatsapp_number', (r.gathered_context -> 'extracted_variables') ->> 'whatsapp_number',
          'document_status', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'document_status', (r.gathered_context -> 'extracted_variables') ->> 'document_status'),
          'tonnage_class', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'tonnage_class', (r.gathered_context -> 'extracted_variables') ->> 'tonnage_class'),
          'machine_condition_summary', COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'machine_condition_summary', (r.gathered_context -> 'extracted_variables') ->> 'machine_condition_summary')
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

    // Buyer inventory matches, computed fresh (no persistence on read) from
    // the org-scoped stock. Empty when no stock, no requirement, or no match.
    let inventoryMatches = [];
    try {
      const leadType = isDnc ? 'dnc' : (latest.customer_type || 'unknown');
      if (leadType === 'buyer') {
        const stock = await loadMatchStock(orgInt);
        const req = buildMatchRequirement(latest);
        inventoryMatches = evaluateBuyerMatches(req, stock).slice(0, 5).map((m) => ({
          machine_id: m.machine_id,
          brand: m.machine.brand,
          model: m.machine.model,
          manufacturing_year: m.machine.manufacturing_year,
          hour_meter_reading: m.machine.hour_meter_reading,
          current_location: m.machine.current_location,
          asking_price: m.machine.target_resale_inr ?? null,
          match_type: m.match_type,
          match_score: m.match_score,
          matched_fields: m.matched_fields,
          mismatched_fields: m.mismatched_fields,
          missing_requirement_fields: m.missing_requirement_fields,
          match_explanation: m.match_explanation,
        }));
      }
    } catch (_) {
      inventoryMatches = [];
    }

    // Goal 32 seller side: potential buyers for this seller's machine,
    // computed fresh (no persistence on read) from org-scoped buyer leads.
    // Buyer identities stay letter-coded (Buyer A/B/C): no PII in matching.
    let potentialBuyers = [];
    try {
      const sellerLeadType = isDnc ? 'dnc' : (latest.customer_type || 'unknown');
      if (sellerLeadType === 'seller') {
        const buyerRows = await getBuyers({}, false, orgInt);
        const machineDesc = {
          machine_id: null,
          brand: latest.machine_brand || null,
          model: latest.machine_model || null,
          machine_type: latest.machine_type ?? null,
          manufacturing_year: latest.model_year ?? null,
          hour_meter_reading: latest.running_hours ?? null,
          target_resale_inr: latest.expected_selling_price_inr ?? null,
          current_location: latest.machine_location_city || latest.location_city || null,
          status: 'in_sourcing_pipeline',
          // B4: informational passthrough, same contract as pipeline path.
          application_history: latest.application_history ?? null,
          condition: latest.condition ?? null,
          tonnage_class: latest.tonnage_class ?? null,
          machine_condition_summary: latest.machine_condition_summary ?? null,
        };
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        potentialBuyers = evaluateMachineBuyers(machineDesc, buyerRows).slice(0, 5).map((r, i) => {
          const brow = buyerRows.find((b) => String(b.run_id ?? b.lead_id ?? b.buyer_id) === String(r.buyer_id)) || {};
          return {
            buyer_label: 'Buyer ' + (letters[i] || ('#' + (i + 1))),
            requirement: [brow.machine_brand, brow.machine_model].filter(Boolean).join(' ') || null,
            budget: brow.buyer_budget_max_inr ?? brow.budget_max_inr ?? null,
            preferred_city: brow.preferred_city ?? brow.machine_location_city ?? null,
            match_status: r.match_status,
            matched_fields: r.matched_fields,
            mismatched_fields: r.mismatched_fields,
            missing_fields: r.missing_fields,
            hard_failures: r.hard_failures,
            match_explanation: r.match_explanation,
            owner_review_required: r.owner_review_required,
          };
        });
      }
    } catch (_) {
      potentialBuyers = [];
    }

    // Goal 26 Sales Brain: deterministic context from already-known data
    // (identity, requirement, qualification, matches, linked-call history).
    // No scores, no predictions, no new data collection.
    const linkedCallsData = await attachCallSummaries(await attachCallTranscripts(runs.map((r) => ({
      run_id: r.run_id,
      created_at: r.created_at,
      customer_name: r.caller_name,
      primary_phone: r.callback_number,
      conversation_outcome: r.conversation_outcome,
      recording_url: r.recording_url || null,
      has_audio: Boolean(r.recording_url),
      transcript: Array.isArray(r.transcript) ? r.transcript : []
    })), organizationId));
    const brainType = isDnc ? 'dnc' : (latest.customer_type || 'unknown');
    const salesBrainData = buildSalesBrain({
      customer_type: brainType,
      identity: {
        name: latest.caller_name || null,
        phone: latest.callback_number || null,
        city: latest.machine_location_city || latest.location_city || null,
      },
      requirement: resolveQualificationFields(brainType, latest),
      qualification: learned.qualification || null,
      inventory_matches: inventoryMatches,
      calls: linkedCallsData,
    });
    // Goal 27 objections, computed from the same Sales Brain inputs (no
    // second memory system). Best-effort: never fails lead360.
    let objectionGroups = { current: [], unresolved: [], owner_needed: [] };
    try {
      objectionGroups = detectLeadObjections({
        customer_type: salesBrainData.customer_type,
        requirement: salesBrainData.requirement,
        qualification: salesBrainData.qualification,
        inventory_matches: salesBrainData.inventory_context.matches,
        calls: linkedCallsData,
      });
    } catch (_) {
      objectionGroups = { current: [], unresolved: [], owner_needed: [] };
    }
    // Goal 30 snapshot: buyer-only consolidation, null otherwise (UI hides).
    const buyer360Data = buildBuyer360Snapshot({
      customer_type: salesBrainData.customer_type,
      identity: salesBrainData.customer_identity,
      requirement: salesBrainData.requirement,
      qualification: salesBrainData.qualification,
      inventory_matches: salesBrainData.inventory_context.matches,
      objections: objectionGroups.current,
      calls: linkedCallsData,
      stage: (salesBrainData.sales_focus || {}).current_stage || null,
      lead_id: phone || targetId,
    });
    // Goal 31 follow-up recommendation: pure planning over the same inputs
    // (no persistence, no contact). Computed for buyer and seller leads;
    // DNC leads always resolve to not_needed inside the builder.
    const followUpRec = buildFollowUpRecommendation({
      customer_type: latest.customer_type || 'unknown',
      qualification: (learned && learned.qualification) || null,
      objections: objectionGroups.current,
      matches: salesBrainData.customer_type === 'buyer' ? inventoryMatches : [],
      phone,
      existingNextAction: latest.next_action || null,
      followUpDatetime: latest.follow_up_datetime || null,
      dnc_requested: isDnc,
    });
    if (buyer360Data) buyer360Data.follow_up = followUpRec;

    return {
      is_demo: false,
      lead_id: phone || targetId,
      customer_name: latest.caller_name || 'Customer',
      primary_phone: phone,
      whatsapp_phone: latest.whatsapp_number || phone,
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
      inventory_matches: inventoryMatches,
      objections: objectionGroups,
      seller_concerns: ((!isDnc && (latest.customer_type || 'unknown') === 'seller' && Array.isArray(latest.seller_concerns)) ? latest.seller_concerns : []),
      buyer_360: buyer360Data,
      follow_up: followUpRec,
      potential_buyers: potentialBuyers,
      extracted_vs_missing: learned,
      what_vaani_learned: learned,
      qualification: learned.qualification || null,
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
      linked_calls: linkedCallsData,
      sales_brain: salesBrainData,
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
      const callIdParam = isNum ? parseInt(strippedId, 10) : -1;
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
      const callIdParam = isNum ? parseInt(strippedId, 10) : -1;
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
function hasCollectedValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0;
  if (typeof v === 'boolean') return true;
  const s = String(v).trim();
  return s !== '' && s.toLowerCase() !== 'unknown';
}

// Required field sets for factual completeness (Goal 24). No scores,
// no temperatures, no predictions: collected vs missing only.
// Business rule (Phase 2 Step 2): all yard stock is refurbished used
// machinery, so new_or_used is never asked of buyers and never gates buyer
// qualification. The field remains optional for history/compatibility.
const BUYER_REQUIRED_FIELDS = Object.freeze([
  'machine_type', 'budget', 'preferred_city', 'purchase_timeline',
]);
const SELLER_REQUIRED_FIELDS = Object.freeze([
  'machine_type', 'brand', 'model', 'year', 'hours', 'condition',
  'availability_status', 'asking_price', 'machine_location',
]);

// Deterministic qualification completeness over explicitly supplied fields.
// Reuses the existing status vocabulary (QUALIFIED / PARTIALLY_QUALIFIED /
// UNQUALIFIED, DISQUALIFIED on DNC). Never invents: absent stays missing.
function evaluateQualificationCompleteness(customerType, fields = {}, dncRequested = false) {
  if (dncRequested) return { status: 'DISQUALIFIED', collected_fields: [], missing_fields: [] };
  const f = fields && typeof fields === 'object' ? fields : {};
  let required;
  if (customerType === 'buyer') {
    const budgetOk = hasCollectedValue(f.budget_max) || hasCollectedValue(f.budget_min);
    required = [
      ['machine_type', hasCollectedValue(f.machine_type)],
      ['budget', budgetOk],
      ['preferred_city', hasCollectedValue(f.preferred_city)],
      ['purchase_timeline', hasCollectedValue(f.purchase_timeline)],
    ];
  } else if (customerType === 'seller') {
    required = [
      ['machine_type', hasCollectedValue(f.machine_type)],
      ['brand', hasCollectedValue(f.brand)],
      ['model', hasCollectedValue(f.model)],
      ['year', hasCollectedValue(f.year)],
      ['hours', hasCollectedValue(f.hours)],
      ['condition', hasCollectedValue(f.condition)],
      ['availability_status', hasCollectedValue(f.availability_status)],
      ['asking_price', hasCollectedValue(f.asking_price)],
      ['machine_location', hasCollectedValue(f.machine_location)],
    ];
  } else {
    return { status: 'UNQUALIFIED', collected_fields: [], missing_fields: [] };
  }
  const collected_fields = required.filter(([, ok]) => ok).map(([name]) => name);
  const missing_fields = required.filter(([, ok]) => !ok).map(([name]) => name);
  const status = missing_fields.length === 0 ? 'QUALIFIED'
    : (collected_fields.length > 0 ? 'PARTIALLY_QUALIFIED' : 'UNQUALIFIED');
  return { status, collected_fields, missing_fields };
}


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

// Human-readable labels and follow-up questions for requirement fields.
// Display only; the canonical keys above remain the source of truth.
const SALES_BRAIN_FIELD_LABELS = Object.freeze({
  machine_type: 'Machine Type', budget: 'Budget', preferred_city: 'Preferred City',
  new_or_used: 'New / Used', purchase_timeline: 'Purchase Timeline',
  brand: 'Make', model: 'Model', year: 'Model Year', hours: 'Operating Hours',
  condition: 'Condition', availability_status: 'Availability',
  asking_price: 'Asking Price', machine_location: 'Machine Location',
  lead_status: 'Lead Status',
});
const SALES_BRAIN_FIELD_QUESTIONS = Object.freeze({
  machine_type: 'Which machine type is needed?',
  budget: 'What is the budget range?',
  preferred_city: 'Which city should the machine be in?',
  new_or_used: 'Is a new or used machine preferred?',
  purchase_timeline: 'What is the purchase timeline?',
  brand: 'Which make is required?',
  model: 'Which model is required?',
  year: 'Which model year is acceptable?',
  hours: 'What are the maximum acceptable operating hours?',
  condition: 'What condition should the machine be in?',
  availability_status: 'When is the machine available?',
  asking_price: 'What is the asking price?',
  machine_location: 'Where is the machine located?',
  lead_status: 'What is the current lead status?',
});

// Canonical Sales Brain context (Goal 26): deterministic decision-support
// composed ONLY from already-known structured data. No scores, no
// temperatures, no predictions. Missing stays missing; nothing is inferred.
function buildSalesBrain(input) {
  const src = input && typeof input === 'object' ? input : {};
  const customerType = src.customer_type === 'buyer' || src.customer_type === 'seller'
    ? src.customer_type : 'unknown';
  const intent = customerType === 'buyer' ? 'purchase'
    : customerType === 'seller' ? 'sell' : 'unknown';
  const ident = src.identity && typeof src.identity === 'object' ? src.identity : {};
  const customer_identity = {
    name: ident.name ?? null,
    phone: ident.phone ?? null,
    city: ident.city ?? null,
  };
  const qual = src.qualification && typeof src.qualification === 'object' ? src.qualification : null;
  const collected = Array.isArray(qual?.collected_fields) ? [...qual.collected_fields] : [];
  const missing = Array.isArray(qual?.missing_fields) ? [...qual.missing_fields] : [];
  const requirement = src.requirement && typeof src.requirement === 'object' ? src.requirement : {};
  const matches = Array.isArray(src.inventory_matches) ? src.inventory_matches : [];
  const calls = Array.isArray(src.calls) ? src.calls : [];

  const fmtVal = (v) => {
    if (typeof v === 'number') {
      if (v >= 10000) return '₹' + (v / 100000).toFixed(2).replace(/\.00$/, '') + 'L';
      return v.toLocaleString('en-IN');
    }
    return String(v);
  };
  // Completeness speaks in abstract keys (budget, year, hours, ...); stored
  // requirement objects use concrete keys (budget_max, ...). Resolve with a
  // documented alias order so known facts never miss stored values.
  const REQUIREMENT_ALIASES = {
    machine_type: ['machine_type'], budget: ['budget_max', 'budget_min'],
    preferred_city: ['preferred_city'], new_or_used: ['new_or_used'],
    purchase_timeline: ['purchase_timeline'], brand: ['brand'], model: ['model'],
    year: ['year'], hours: ['hours'], condition: ['condition'],
    availability_status: ['availability_status'], asking_price: ['asking_price'],
    machine_location: ['machine_location'], lead_status: ['lead_status'],
  };
  const lookupRequirement = (key) => {
    for (const k of (REQUIREMENT_ALIASES[key] || [key])) {
      const v = requirement[k];
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'unknown')) continue;
      if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) continue;
      return v;
    }
    return undefined;
  };
  const known_facts = [];
  for (const key of collected) {
    const v = lookupRequirement(key);
    if (v === undefined) continue;
    const label = SALES_BRAIN_FIELD_LABELS[key] || key;
    known_facts.push(`${label}: ${fmtVal(v)}`);
  }
  const previous_topics = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const outcome = c.conversation_outcome;
    if (outcome && !previous_topics.includes(outcome)) previous_topics.push(outcome);
    const segs = Array.isArray(c.transcript) ? c.transcript.length : 0;
    if (segs > 0) previous_topics.push(`past call with ${segs} recorded exchanges`);
  }
  const unresolved_questions = missing.map(
    (key) => SALES_BRAIN_FIELD_QUESTIONS[key] || `What is the ${key}?`
  );

  const qualStatus = (qual && qual.status) || 'UNQUALIFIED';
  let current_stage = 'qualification';
  if (qualStatus === 'QUALIFIED' && matches.length > 0) current_stage = 'inventory_match_review';
  else if (qualStatus === 'QUALIFIED') current_stage = 'requirement_recorded';
  const relevant_topics = [];
  for (const m of matches.slice(0, 3)) {
    if (!m || typeof m !== 'object') continue;
    const desc = [m.brand, m.model].filter(Boolean).join(' ') || 'machine';
    relevant_topics.push(`${desc} (match ${m.match_score ?? ''}%)`.trim());
  }
  for (const key of missing) {
    relevant_topics.push(`collect: ${SALES_BRAIN_FIELD_LABELS[key] || key}`);
  }

  return {
    customer_type: customerType,
    customer_identity,
    intent: {
      primary: intent,
      confidence: intent === 'unknown' ? 'unknown' : 'known',
    },
    requirement: { ...requirement },
    qualification: qual
      ? { status: qual.status ?? 'UNQUALIFIED', collected_fields: collected, missing_fields: missing }
      : { status: 'UNQUALIFIED', collected_fields: [], missing_fields: [] },
    inventory_context: {
      matches,
      count: matches.length,
      best_matches: matches.slice(0, 3),
    },
    conversation_context: {
      call_count: calls.length,
      previous_topics,
      known_facts,
      unresolved_questions,
    },
    sales_focus: {
      current_stage,
      next_information_to_collect: [...missing],
      relevant_topics,
      avoid_reasking: [...collected],
    },
  };
}

// ---------------------------------------------------------------------------
// Goal 31 deterministic Follow-up Engine (planning ONLY). Pure function of
// already-known structured data: qualification gaps, owner-needed
// objections, stored next actions, inventory matches, DNC state. Produces a
// single consolidated recommendation; never contacts anyone, never
// schedules anything, never invents urgency, dates, prices, or discounts.
// ---------------------------------------------------------------------------

const FOLLOW_UP_DUE_NONE = null;

// Priority order is fixed: owner review first, then stored next actions,
// then inventory review, then qualification gaps. First match wins so one
// underlying reason never yields contradictory recommendations.
function buildFollowUpRecommendation(input) {
  const src = input && typeof input === 'object' ? input : {};
  const customerType = src.customer_type === 'buyer' || src.customer_type === 'seller'
    ? src.customer_type : 'unknown';
  const qual = src.qualification && typeof src.qualification === 'object' ? src.qualification : null;
  const missing = Array.isArray(qual?.missing_fields) ? qual.missing_fields.filter((k) => typeof k === 'string' && k) : [];
  const objections = Array.isArray(src.objections) ? src.objections.filter((o) => o && typeof o === 'object') : [];
  const matches = Array.isArray(src.matches) ? src.matches.filter((m) => m && typeof m === 'object') : [];
  const hasPhone = typeof src.phone === 'string' && src.phone.trim() !== '';
  const dnc = src.dnc_requested === true;
  const storedAction = (typeof src.existingNextAction === 'string' && src.existingNextAction.trim())
    ? src.existingNextAction.trim() : null;
  const dueAt = (typeof src.followUpDatetime === 'string' && src.followUpDatetime.trim())
    ? src.followUpDatetime.trim() : FOLLOW_UP_DUE_NONE;
  const idle = { needed: false, priority: 'NONE', reason: null, follow_up_type: 'none', recommended_channel: 'unknown', recommended_action: null, due_at: FOLLOW_UP_DUE_NONE, owner_required: false, state: 'not_needed', source: 'none' };

  const knownSomething = hasPhone || missing.length > 0
    || (qual && Array.isArray(qual.collected_fields) && qual.collected_fields.length > 0)
    || objections.length > 0 || matches.length > 0 || storedAction;
  if (customerType === 'unknown' || dnc || !knownSomething) return { ...idle };

  const ownerObjections = objections.filter((o) => o.owner_needed === true);
  if (ownerObjections.length) {
    const types = [...new Set(ownerObjections.map((o) => String(o.type || 'unknown')))];
    return {
      needed: true, priority: 'HIGH',
      reason: `Owner review required: ${types.join(', ')}`,
      follow_up_type: 'owner_review',
      recommended_channel: 'owner_review',
      recommended_action: 'Owner review required before customer follow-up.',
      due_at: dueAt, owner_required: true, state: 'owner_review', source: 'owner_objection',
    };
  }
  if (storedAction) {
    return {
      needed: true, priority: 'MEDIUM',
      reason: `Previous call left a next action: ${storedAction}`,
      follow_up_type: 'callback_action',
      recommended_channel: hasPhone ? 'phone' : 'unknown',
      recommended_action: storedAction,
      due_at: dueAt, owner_required: false, state: 'recommended', source: 'previous_next_action',
    };
  }
  if (matches.length > 0 && qual && qual.status === 'QUALIFIED') {
    return {
      needed: true, priority: 'MEDIUM',
      reason: `${matches.length} inventory match${matches.length === 1 ? '' : 'es'} awaiting owner review`,
      follow_up_type: 'inventory_review',
      recommended_channel: hasPhone ? 'phone' : 'unknown',
      recommended_action: `Review ${matches.length} matching machine${matches.length === 1 ? '' : 's'} with the owner.`,
      due_at: dueAt, owner_required: false, state: 'recommended', source: 'inventory_match',
    };
  }
  if (missing.length) {
    return {
      needed: true, priority: 'MEDIUM',
      reason: `Qualification information is incomplete: ${missing.join(', ')}`,
      follow_up_type: 'qualification',
      recommended_channel: hasPhone ? 'phone' : 'unknown',
      recommended_action: `Collect ${missing.join(' and ')}.`,
      due_at: dueAt, owner_required: false, state: 'recommended', source: 'qualification_gap',
    };
  }
  return { ...idle, source: 'complete' };
}

// Normalize optional qualification enums. Unknown spellings stay null
// (unknown), never coerced into a fabricated value.
function normalizeNewOrUsed(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return (s === 'new' || s === 'used') ? s : null;
}
function normalizePaymentMode(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return (s === 'finance' || s === 'full_payment') ? s : null;
}
function normalizeFinanceRequired(v) {
  if (v === true || v === false) return v;
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

// ---------------------------------------------------------------------------
// Goal 27 deterministic Objection Handling. Keyword/concept detection over
// customer utterances only (never the agent's own words), mapped to a fixed
// category table per side. No LLM, no scores, no negotiation: each detection
// yields a structured object with safe guidance grounded in already-known
// facts, plus explicit owner escalation. Unknown when signals are absent.
// ---------------------------------------------------------------------------

function normObjectionText(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const BUYER_OBJECTION_CATEGORIES = Object.freeze([
  { type: 'price_budget', keywords: ['meheng', 'mahang', 'mahnga', 'zyada', 'jyada', 'price', 'budget', 'rate', 'paisa', 'lakh', 'discount', 'sasta', 'costly', 'expensive', 'kimat', 'daam', 'afford'], owner: true, facts: ['budget', 'inventory_price'] },
  { type: 'condition', keywords: ['condition', 'purana', 'purani', 'old', 'damage', 'scratch', 'dent', 'kharab', 'kharabi', 'accident', 'paint', 'tyre', 'tire', 'engine'], owner: false, facts: ['condition', 'evidence'] },
  { type: 'year', keywords: ['model', 'saal', 'year', 'naya model', 'purana model', 'latest', 'old model'], owner: false, facts: ['year'] },
  { type: 'hours', keywords: ['hour', 'ghante', 'ghanta', 'chali hui', 'chala hua', 'reading'], owner: false, facts: ['hours'] },
  { type: 'location', keywords: ['door', 'dur ', 'dur hai', 'distance', 'deliver', 'transport', 'laana', 'le jana', 'bhejna', 'location', 'sheher'], owner: false, facts: ['location', 'inventory_location'] },
  { type: 'brand_model', keywords: ['duplicate', 'nakli', 'asli', 'local', 'original nahi'], owner: false, facts: ['brand', 'model'] },
  { type: 'availability', keywords: ['milega', 'available', 'stock', 'taiyar', 'kab ', 'intezar', 'book'], owner: false, facts: ['availability'] },
  { type: 'financing_payment', keywords: ['finance', 'loan', 'emi', 'kisht', 'kist', 'payment', 'advance', 'token', 'full payment', 'cash', 'udhar', 'baki', 'installment'], owner: false, facts: ['finance', 'payment', 'budget'] },
  { type: 'requirement_mismatch', keywords: ['chahiye tha', 'galat', 'wrong', 'alag ', 'not what', 'yeh nahi', 'woh nahi', 'different'], owner: false, facts: ['requirement'] },
  { type: 'timing', keywords: ['jaldi', 'urgent', 'abhi nahi', 'baad mein', 'later', 'ruk', 'rukna', 'soch', 'sochna', 'time chahiye', 'month'], owner: false, facts: ['timeline'] },
  { type: 'comparison', keywords: ['dusri', 'doosri', 'another', 'compare', 'wahan', 'vahan', 'dealer', 'olx', 'elsewhere', 'aur kahin'], owner: false, facts: ['comparison'] },
  { type: 'trust_verification', keywords: ['bharosa', 'trust', 'verify', 'fake', 'fraud', 'dhokha', 'genuine', 'check kar'], owner: true, facts: ['documents', 'evidence'] },
  { type: 'documentation', keywords: ['document', 'noc', 'paper', 'kagaz', 'kagaj', 'invoice', 'bill', 'registration', 'number plate', 'papers'], owner: true, facts: ['documents'] },
]);

const SELLER_OBJECTION_CATEGORIES = Object.freeze([
  { type: 'asking_price', keywords: ['rate', 'price', 'daam', 'kimat', 'demand', 'mang', 'bechna', 'bech', 'dena', 'kam ', 'valuation', 'lagega', 'milenge', 'offer'], owner: true, facts: ['asking_price', 'valuation'] },
  { type: 'valuation', keywords: ['sahi rate', 'market', 'bazaar', 'worth'], owner: true, facts: ['valuation'] },
  { type: 'condition', keywords: ['condition', 'kharab', 'theek', 'working', 'damage', 'paint'], owner: false, facts: ['condition', 'evidence'] },
  { type: 'buyer_seriousness', keywords: ['serious', 'timepass', 'time pass', 'pakka', 'confirm', 'token', 'party'], owner: false, facts: ['buyer_status'] },
  { type: 'payment', keywords: ['payment', 'advance', 'cash', 'udhar', 'baki', 'full', 'token amount'], owner: false, facts: ['payment'] },
  { type: 'inspection', keywords: ['check', 'inspect', 'dekhna', 'dekhne', 'mechanic', 'mistri', 'trial', 'chalakar', 'test drive'], owner: false, facts: ['inspection'] },
  { type: 'location', keywords: ['door', 'dur ', 'distance', 'deliver', 'transport', 'location'], owner: false, facts: ['location'] },
  { type: 'availability', keywords: ['milega', 'available', 'ready', 'taiyar', 'kab '], owner: false, facts: ['availability'] },
  { type: 'documentation', keywords: ['document', 'noc', 'paper', 'kagaz', 'invoice', 'registration'], owner: true, facts: ['documents'] },
  { type: 'timing', keywords: ['jaldi', 'abhi nahi', 'baad mein', 'later', 'rukna', 'sochna', 'month'], owner: false, facts: ['timeline'] },
  { type: 'commission', keywords: ['commission', 'dalali', 'percent', 'broker', 'bichauliya', 'mediator', 'charge'], owner: true, facts: ['commission_terms'] },
]);

const OBJECTION_COMMITMENT_KEYWORDS = Object.freeze([
  'discount', 'negotiat', 'commit', 'promise', 'guarantee', 'approve',
  'deal pakki', 'deal done', 'final karo', 'likhit', 'agreement',
]);

const OBJECTION_GUIDANCE = Object.freeze({
  price_budget: 'Compare the listed inventory price against the buyer budget using verified numbers only. Share factual prices. Do NOT promise any discount or negotiation; that needs the owner.',
  condition: 'Refer only to verified condition information and agreed evidence. Do NOT claim inspection results that do not exist.',
  year: 'Share only the verified model year. Do NOT guess manufacturing details.',
  hours: 'Share only the verified meter reading. Do NOT guess usage history.',
  location: 'Share only the verified machine location. Do NOT promise delivery or transport.',
  brand_model: 'Confirm make and model from verified records only. Do NOT claim originality without evidence.',
  availability: 'Confirm availability only from verified stock status. Do NOT promise a machine that is not confirmed available.',
  financing_payment: 'Discuss only stated payment facts. Do NOT approve finance, promise loans, or commit payment terms.',
  requirement_mismatch: 'Restate the recorded requirement and ask what differs. Do NOT assume a new requirement.',
  timing: 'Note the stated timing without pressuring. Do NOT promise callbacks or deadlines without owner approval.',
  comparison: 'Do NOT disparage other sellers or invent competing offers. Stick to verified facts about our machines.',
  trust_verification: 'Offer verification paths that actually exist. Escalate to the owner before making credibility claims.',
  documentation: 'Discuss only verified document status. RC/NOC claims need human verification: escalate to the owner.',
  asking_price: 'Discuss only the recorded asking price and verified valuation inputs. Do NOT agree to a price: escalate to the owner.',
  valuation: 'Share only verified market inputs. Valuation decisions need the owner.',
  buyer_seriousness: 'Note seriousness signals factually. Do NOT label the buyer.',
  payment: 'Discuss only stated payment facts. Do NOT commit to advances, timelines, or terms.',
  inspection: 'Offer only inspections that are actually arranged. Do NOT promise inspection outcomes.',
  commission: 'Do NOT discuss, promise, or waive any commission. Escalate commercial terms to the owner.',
  unknown: 'No clear objection detected. Continue qualification with genuinely missing fields only.',
});

// Resolve a buyer's known fact values for guidance interpolation. Null-safe;
// returns undefined when the fact is not genuinely available.
function objectionFactValue(facts, key) {
  const v = facts ? facts[key] : undefined;
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'unknown')) return undefined;
  if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) return undefined;
  return v;
}

function formatObjectionMoney(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return '₹' + (v / 100000).toFixed(2).replace(/\.00$/, '') + 'L';
}

// Deterministic detection over customer utterances only. Returns structured
// objection objects in category priority order (cap 5). Empty transcript or
// no signals yields [] (honest absence) unless text exists but matches
// nothing, which yields a single unknown marker.
function detectObjections(customerType, segments, facts) {
  const out = [];
  if (customerType !== 'buyer' && customerType !== 'seller') return out;
  const list = Array.isArray(segments) ? segments : [];
  const texts = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const speaker = s.speaker !== undefined ? s.speaker : s.role;
    const isCustomer = speaker === undefined || speaker === null ||
      /customer|user|caller|buyer|seller/i.test(String(speaker));
    const text = s.message !== undefined ? s.message : s.text;
    if (!isCustomer || typeof text !== 'string' || !text.trim()) continue;
    texts.push(normObjectionText(text));
  }
  if (!texts.length) return out;
  const joined = texts.join('\n');
  const table = customerType === 'buyer' ? BUYER_OBJECTION_CATEGORIES : SELLER_OBJECTION_CATEGORIES;
  const commitmentHit = OBJECTION_COMMITMENT_KEYWORDS.some((k) => joined.includes(k));
  for (const cat of table) {
    const hit = texts.find((t) => cat.keywords.some((k) => t.includes(k)));
    if (!hit) continue;
    const factsToVerify = [];
    for (const key of cat.facts) {
      if (objectionFactValue(facts, key) === undefined) factsToVerify.push(key);
    }
    out.push({
      type: cat.type,
      objection_text: hit.slice(0, 240),
      context: {
        customer_type: customerType,
        known_fact_keys: Object.keys(facts || {}).filter((k) => objectionFactValue(facts, k) !== undefined),
      },
      status: 'open',
      safe_response_guidance: OBJECTION_GUIDANCE[cat.type] || OBJECTION_GUIDANCE.unknown,
      facts_to_verify: factsToVerify,
      owner_needed: cat.owner === true || commitmentHit,
    });
    if (out.length >= 5) break;
  }
  if (!out.length) {
    out.push({
      type: 'unknown',
      objection_text: texts[0].slice(0, 240),
      context: { customer_type: customerType, known_fact_keys: [] },
      status: 'open',
      safe_response_guidance: OBJECTION_GUIDANCE.unknown,
      facts_to_verify: [],
      owner_needed: commitmentHit,
    });
  }
  return out;
}

// Deterministic status resolution. approved => addressed; owner review
// without decision => needs_owner; newly supplied facts covering every
// listed verification => addressed; otherwise unresolved/open preserved.
function updateObjectionStatus(objection, resolution) {
  const obj = objection && typeof objection === 'object' ? { ...objection } : null;
  if (!obj || typeof obj.type !== 'string') return null;
  const res = resolution && typeof resolution === 'object' ? resolution : {};
  if (res.ownerDecision === 'approved') return { ...obj, status: 'addressed' };
  if (res.ownerDecision === 'rejected') return { ...obj, status: 'unresolved' };
  if (Array.isArray(res.factsNowKnown) && res.factsNowKnown.length) {
    const remaining = (Array.isArray(obj.facts_to_verify) ? obj.facts_to_verify : [])
      .filter((k) => !res.factsNowKnown.includes(k));
    if (!remaining.length) return { ...obj, status: 'addressed', facts_to_verify: [] };
    return { ...obj, status: 'unresolved', facts_to_verify: remaining };
  }
  if (res.ownerReviewed === true) return { ...obj, status: obj.owner_needed ? 'needs_owner' : 'open' };
  return { ...obj };
}

// Lead-level wrapper: run detection over the latest transcript-bearing call
// and group into current / unresolved / owner_needed. Pure; callers scope.
function detectLeadObjections({ customer_type, requirement, qualification, inventory_matches, calls }) {
  const empty = { current: [], unresolved: [], owner_needed: [] };
  if (customer_type !== 'buyer' && customer_type !== 'seller') return empty;
  const list = Array.isArray(calls) ? calls : [];
  let target = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const segs = list[i] && Array.isArray(list[i].transcript) ? list[i].transcript : [];
    if (segs.length) { target = list[i]; break; }
  }
  if (!target) {
    const withAny = list.filter((c) => c && Array.isArray(c.transcript) && c.transcript.length);
    if (!withAny.length) return empty;
    target = withAny[withAny.length - 1];
  }
  const req = requirement && typeof requirement === 'object' ? requirement : {};
  const best = Array.isArray(inventory_matches) && inventory_matches.length ? inventory_matches[0] : null;
  const facts = { ...req };
  if (best && typeof best === 'object') {
    if (best.asking_price !== undefined && best.asking_price !== null) facts.inventory_price = best.asking_price;
    if (best.current_location) facts.inventory_location = best.current_location;
  }
  const current = detectObjections(customer_type, target.transcript, facts);
  return {
    current,
    unresolved: current.filter((o) => o.status === 'open' || o.status === 'unresolved'),
    owner_needed: current.filter((o) => o.owner_needed === true),
  };
}

// Goal 30 Buyer 360 latest-state snapshot. Pure consolidation over already
// computed Goals 23-27 outputs (identity, requirement, qualification,
// matches, calls with transcripts+summaries, objections, brain focus).
// Buyer-only: anything else yields null (UI hides the card). Unknown stays
// null; never fabricated, never a second memory system.
function buildBuyer360Snapshot(input) {
  const src = input && typeof input === 'object' ? input : {};
  if (src.customer_type !== 'buyer') return null;
  const ident = src.identity && typeof src.identity === 'object' ? src.identity : {};
  const req = src.requirement && typeof src.requirement === 'object' ? src.requirement : {};
  const qual = src.qualification && typeof src.qualification === 'object' ? src.qualification : null;
  const matches = Array.isArray(src.inventory_matches) ? src.inventory_matches : [];
  const calls = Array.isArray(src.calls) ? src.calls.filter((c) => c && typeof c === 'object') : [];
  const objections = Array.isArray(src.objections) ? src.objections.filter((o) => o && typeof o === 'object') : [];
  const pick = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'unknown')) return null;
    if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) return null;
    return v;
  };
  const best = matches.length ? matches[0] : null;
  const lastCall = calls.length ? calls[0] : null;
  const lastSummary = (lastCall && lastCall.summary && typeof lastCall.summary === 'object') ? lastCall.summary : null;
  return {
    buyer: {
      name: pick(ident.name),
      phone: pick(ident.phone),
      location: pick(ident.city),
      customer_type: 'buyer',
      lead_id: pick(src.lead_id),
    },
    intent: 'purchase',
    stage: pick(src.stage) || null,
    qualification_status: (qual && qual.status) || 'UNQUALIFIED',
    requirement: {
      machine_type: pick(req.machine_type),
      brand: pick(req.brand),
      model: pick(req.model),
      budget_min: pick(req.budget_min),
      budget_max: pick(req.budget_max),
      year_min: pick(req.year_min),
      year_max: pick(req.year_max),
      max_hours: pick(req.max_hours),
      preferred_city: pick(req.preferred_city),
      new_or_used: pick(req.new_or_used),
      purchase_timeline: pick(req.purchase_timeline),
    },
    collected_fields: (qual && Array.isArray(qual.collected_fields)) ? [...qual.collected_fields] : [],
    missing_fields: (qual && Array.isArray(qual.missing_fields)) ? [...qual.missing_fields] : [],
    best_match: best ? {
      machine_id: best.machine_id ?? null,
      brand: best.brand ?? null,
      model: best.model ?? null,
      match_score: typeof best.match_score === 'number' ? best.match_score : null,
      match_type: best.match_type ?? null,
    } : null,
    match_count: matches.length,
    open_objections: objections
      .filter((o) => o.status === 'open' || o.status === 'unresolved')
      .map((o) => ({ type: o.type || 'unknown', status: o.status || 'open', owner_needed: o.owner_needed === true })),
    last_call: lastCall ? {
      time: lastCall.formatted_time || lastCall.created_at || null,
      outcome: (lastSummary && lastSummary.outcome) || lastCall.conversation_outcome || null,
      status: lastCall.status || null,
    } : null,
    last_outcome: (lastSummary && lastSummary.outcome) || (lastCall && lastCall.conversation_outcome) || null,
    next_action: (lastSummary && lastSummary.next_action) || null,
  };
}

// Resolve the flat qualification field set for a lead-shaped object with a
// documented alias order. Single source of truth for completeness inputs,
// so display, ingest, and manual paths can never diverge.
function resolveQualificationFields(customerType, lead) {
  const L = lead && typeof lead === 'object' ? lead : {};
  if (customerType === 'buyer') {
    // 4C-2 read projection: flat view columns take precedence; persisted
    // structured JSON (raw_extracted_variables) acts as fallback only, so old
    // leads without these keys resolve null/blank instead of crashing, and
    // meaningful flat values are never replaced by null.
    const _ev = asVarsObject(L.raw_extracted_variables);
    const _md = asVarsObject(_ev.machine_details);
    const _ct = asVarsObject(_ev.commercial_terms);
    const _pick = (...vals) => {
      for (const v of vals) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'unknown')) continue;
        if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) continue;
        return v;
      }
      return null;
    };
    return {
      machine_type: L.machine_type ?? null,
      budget_max: L.buyer_budget_max_inr ?? L.budget_max ?? null,
      budget_min: _pick(L.budget_min, _ct.budget_min_inr),
      budget_qualifier: _pick(_ct.budget_qualifier),
      quantity: _pick(_md.quantity),
      preferred_city: L.preferred_city ?? L.machine_location_city ?? L.location_city ?? _pick(_md.preferred_city),
      new_or_used: normalizeNewOrUsed(L.new_or_used ?? L.used_or_refurbished ?? null),
      purchase_timeline: L.purchase_timeline ?? null,
      finance_required: normalizeFinanceRequired(L.finance_required ?? _ct.finance_required ?? null),
      payment_mode: normalizePaymentMode(L.payment_mode ?? null),
      model_year: _pick(_md.model_year),
      max_hours: _pick(_md.max_hours),
      condition: _pick(_md.condition),
      machine_condition_summary: (_md.machine_condition_summary && String(_md.machine_condition_summary).trim()) ? String(_md.machine_condition_summary).trim() : null,
      application_history: _pick(_md.application_history),
      tonnage_class: _pick(_md.tonnage_class),
      whatsapp_requested: _ev.whatsapp_requested === true ? true : (_ev.whatsapp_requested === false ? false : null),
      whatsapp_action: (typeof _ev.whatsapp_action === 'string' && _ev.whatsapp_action.trim()) ? _ev.whatsapp_action.trim() : null,
    };
  }
  if (customerType === 'seller') {
    return {
      machine_type: L.machine_type ?? null,
      brand: L.machine_brand ?? L.brand ?? null,
      model: L.machine_model ?? L.model ?? null,
      year: L.model_year ?? L.manufacturing_year ?? L.year ?? null,
      hours: L.running_hours ?? L.hour_meter_reading ?? L.hours ?? null,
      condition: L.condition ?? L.component_condition ?? L.machine_condition_summary ?? null,
      tonnage_class: L.tonnage_class ?? null,
      document_status: L.document_status ?? null,
      machine_condition_summary: L.machine_condition_summary ?? null,
      whatsapp_number: L.whatsapp_number ?? null,
      availability_status: L.availability_status ?? null,
      asking_price: L.expected_selling_price_inr ?? L.expected_price_inr ?? L.asking_price ?? null,
      machine_location: L.machine_location_city ?? L.location_city ?? L.machine_location ?? null,
    };
  }
  return {};
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

  let requiresFollowUp = false;
  if (explicitRequired === false || explicitRequired === true) {
    requiresFollowUp = explicitRequired;
  } else {
    requiresFollowUp = Boolean(
      outcome === 'callback_requested' ||
      outcome === 'appointment_requested' ||
      outcome === 'lead_qualified' ||
      qual === 'QUALIFIED' ||
      (nextAct && !['NO_ACTION_REQUIRED', 'DNC_SUPPRESS', 'NO_FOLLOW_UP'].includes(nextAct))
    );
  }

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
  workflowId,
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
// Normalize raw transcript input into storable segments. Accepts
// {speaker,message[,timestamp]} or {role,text|content[,timestamp|ts]} shapes.
// Missing speakers stay null (never invented), empty messages are dropped,
// invalid timestamps become null. Caps segment count to bound writes.
// ---------------------------------------------------------------------------
// Phase 1 (plan v2) — ingestion persistence helpers.
//
// These helpers are pure (no database, no network) so they can be unit tested
// on their own. They deliberately reuse the existing "only if present, never
// fabricate" discipline: an absent value stays absent, and a value that is
// already present is never overwritten.
// ---------------------------------------------------------------------------

// Merge the extraction Dograh already produced (payload.extracted_variables)
// into the local working set.
//
// Dograh's extraction is the only place where the facts actually spoken on the
// call are captured. Without this merge the dashboard re-derives everything
// from the transcript alone, so a run whose transcript is empty or partial
// loses the real machine, budget and requirement. Existing local values always
// win; only absent fields are filled from the extraction.
function mergeExtractedVariables(extVars, payload, ctx) {
  const src = extVars && typeof extVars === 'object' ? extVars : {};
  const pay = payload && typeof payload === 'object' ? payload : {};
  const mach = ctx && ctx.machDetails && typeof ctx.machDetails === 'object' ? ctx.machDetails : {};
  const comm = ctx && ctx.commTerms && typeof ctx.commTerms === 'object' ? ctx.commTerms : {};
  const ev = ctx && ctx.evReadiness && typeof ctx.evReadiness === 'object' ? ctx.evReadiness : {};

  const present = (v) => v !== undefined && v !== null && v !== '';
  const fill = (target, key, value) => {
    if (!present(value)) return;
    if (!present(target[key])) target[key] = value;
  };

  const srcMach = src.machine_details && typeof src.machine_details === 'object' ? src.machine_details : {};
  for (const key of ['brand', 'model', 'machine_type', 'model_year', 'model_year_min', 'model_year_max',
    'running_hours', 'max_hours', 'quantity', 'tonnage_class', 'application_history', 'condition',
    'new_or_used', 'location_city', 'location_state', 'preferred_city', 'document_status',
    'machine_condition_summary']) {
    fill(mach, key, srcMach[key]);
  }

  const srcComm = src.commercial_terms && typeof src.commercial_terms === 'object' ? src.commercial_terms : {};
  for (const key of ['expected_price_inr', 'budget_max_inr', 'budget_min_inr', 'price_or_budget_raw',
    'price_negotiable', 'sale_urgency', 'budget_qualifier', 'purchase_timeline', 'yard_visit_agreed',
    'yard_visit_schedule', 'finance_required', 'payment_mode']) {
    fill(comm, key, srcComm[key]);
  }

  const srcEv = src.evidence_readiness && typeof src.evidence_readiness === 'object' ? src.evidence_readiness : {};
  for (const key of ['photos_agreed', 'running_video_agreed', 'rc_copy_agreed', 'evidence_status']) {
    fill(ev, key, srcEv[key]);
  }

  // Top-level facts Dograh extracted from the conversation. The call
  // disposition is deliberately NOT mapped onto conversation_outcome: the two
  // fields mean different things, and the disposition is used only as
  // completion evidence (see evaluateCallCompletionEvidence).
  const top = {
    caller_name: src.caller_name || src.customer_name || null,
    callback_number: src.callback_number || src.phone_number || null,
    whatsapp_number: src.whatsapp_number || null,
    customer_type: src.customer_type || null,
    ownership_type: src.ownership_type || null,
    lead_status: src.lead_status || null,
    availability_status: src.availability_status || null,
    lead_temperature: src.lead_temperature || null,
    qualification_state: src.qualification_state || null,
    conversation_outcome: src.conversation_outcome || null,
    next_action: src.next_action || null,
    sales_priority: src.sales_priority || null,
    priority_reason: src.priority_reason || null,
    deal_readiness: src.deal_readiness || null,
    deal_ready_reason: src.deal_ready_reason || null,
    owner_summary: src.owner_summary || null,
    whatsapp_action: src.whatsapp_action || null,
  };
  for (const key of Object.keys(top)) {
    const value = top[key];
    if (value === null || value === undefined) continue;
    if (!present(pay[key])) pay[key] = value;
  }
  if (pay.follow_up_required === undefined && (src.follow_up_required === true || src.follow_up_required === false)) {
    pay.follow_up_required = src.follow_up_required;
  }
  if (pay.whatsapp_requested === undefined && src.whatsapp_requested === true) {
    pay.whatsapp_requested = true;
  }

  return { machDetails: mach, commTerms: comm, evReadiness: ev, payload: pay };
}

// Turn a stored object key ("recordings/126.wav") into a browser-usable URL.
// The endpoint and bucket come from the environment with local defaults; no
// credential is required because the object store serves the bucket public-read.
function resolveArtifactUrl(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const endpoint = String(process.env.MINIO_PUBLIC_ENDPOINT || 'http://localhost:9000').replace(/\/+$/, '');
  const bucket = String(process.env.MINIO_BUCKET || 'voice-audio').replace(/^\/+|\/+$/g, '');
  return `${endpoint}/${bucket}/${trimmed.replace(/^\/+/, '')}`;
}

// Verify that an artifact really exists before its URL is persisted. Returns
// the absolute URL when the object is reachable, otherwise null — a URL is
// never written for an object that is not there.
async function verifyArtifactUrl(key, opts) {
  const url = resolveArtifactUrl(key);
  if (!url) return null;
  const timeoutMs = (opts && opts.timeoutMs) || 4000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    if (!res.ok && (res.status === 405 || res.status === 501)) {
      res = await fetch(url, { method: 'GET', signal: controller.signal, headers: { Range: 'bytes=0-0' } });
    }
    return res && res.ok ? url : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Outcomes that mean the conversation did not finish normally. A call whose
// conversation outcome is one of these is never marked completed.
const CALL_COMPLETION_BLOCKING_OUTCOMES = new Set([
  'no response', 'incomplete', 'opt_out', 'in_progress', 'ongoing', 'initiated'
]);
// Terminal states are owned by the dialer and the failure paths; ingestion
// never overwrites them.
const CALL_TERMINAL_STATUSES = ['completed', 'failed', 'no_answer', 'cancelled'];

// Decide whether there is reliable evidence that a conversation actually
// happened. The transcript is the only positive evidence available in the
// current relay payload; the disposition and the conversation outcome can only
// block the transition, never confirm it.
function evaluateCallCompletionEvidence(input) {
  const src = input && typeof input === 'object' ? input : {};
  const segments = Array.isArray(src.segments) ? src.segments : [];
  if (!segments.length) return { completed: false, reason: 'no_transcript' };
  const disposition = src.disposition ? String(src.disposition).trim().toLowerCase() : null;
  if (disposition === 'system_cancelled') return { completed: false, reason: 'cancelled_disposition' };
  const outcome = src.outcome ? String(src.outcome).trim().toLowerCase() : null;
  if (outcome && CALL_COMPLETION_BLOCKING_OUTCOMES.has(outcome)) {
    return { completed: false, reason: 'negative_outcome' };
  }
  return { completed: true, reason: 'transcript_present' };
}

// Apply the evidence-gated call completion to vaani_calls.
//
// The only status this ever writes is 'completed'. It refuses to write at all
// when the call is already in a terminal state, when there is no completion
// evidence, or when the call does not belong to the ingesting organization.
// The current status, the verdict and the reason are always returned so the
// limitation is visible instead of being silently assumed away.
async function applyCallCompletionStatus(input, queryFn) {
  const src = input && typeof input === 'object' ? input : {};
  const q = queryFn || queryPostgres;
  const verdict = evaluateCallCompletionEvidence(src);
  const runKey = String(src.runId === undefined || src.runId === null ? '' : src.runId).trim();
  const out = {
    previous_status: null,
    new_status: null,
    transitioned: false,
    reason: verdict.reason,
  };
  if (!/^\d+$/.test(runKey)) {
    out.reason = 'invalid_run';
    return out;
  }
  const orgInt = parseInt(src.orgId, 10);
  if (!Number.isFinite(orgInt) || orgInt <= 0) {
    out.reason = 'invalid_org';
    return out;
  }
  // Ownership guard: the call row must belong to the same organization as the
  // run that produced it (same guard the transcript capture already uses).
  const ownerOrg = await resolveRunOwnerOrg(runKey, q).catch(() => null);
  if (ownerOrg === null || ownerOrg === undefined || ownerOrg !== orgInt) {
    out.reason = 'org_mismatch';
    return out;
  }
  const current = await q(
    `SELECT row_to_json(t) FROM (SELECT id, status, ended_at, duration FROM vaani_calls WHERE dograh_call_id = $1 ORDER BY id DESC LIMIT 1) t;`,
    [runKey]
  ).catch(() => null);
  const row = Array.isArray(current) ? current[0] : current;
  if (!row || row.id === undefined || row.id === null) {
    out.reason = 'unlinked_run';
    return out;
  }
  out.previous_status = row.status === undefined ? null : row.status;
  out.new_status = out.previous_status;
  if (!verdict.completed) return out;
  if (CALL_TERMINAL_STATUSES.includes(String(row.status || '').trim().toLowerCase())) {
    out.reason = 'terminal_state_preserved';
    return out;
  }
  const rawDuration = Number(src.durationSeconds);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : null;
  const startedAt = src.startedAt ? new Date(src.startedAt) : null;
  const endedAt = (duration && startedAt && !isNaN(startedAt.getTime()))
    ? new Date(startedAt.getTime() + duration * 1000).toISOString()
    : new Date().toISOString();
  try {
    await q(
      `UPDATE vaani_calls
       SET status = 'completed',
           ended_at = COALESCE(ended_at, $2::timestamptz),
           duration = COALESCE(duration, $3)
       WHERE id = $1 AND status NOT IN ('completed','failed','no_answer','cancelled');`,
      [parseInt(row.id, 10), endedAt, duration]
    );
  } catch (err) {
    console.warn('[VAANI SALES] Call status update failed:', err.message);
    out.reason = 'update_failed';
    return out;
  }
  out.transitioned = true;
  out.new_status = 'completed';
  out.reason = verdict.reason;
  return out;
}

function normalizeTranscriptSegments(input, maxSegments) {
  const cap = Number.isSafeInteger(maxSegments) && maxSegments > 0 ? maxSegments : 500;
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const rawSpeaker = item.speaker !== undefined ? item.speaker : item.role;
    const rawMessage = item.message !== undefined ? item.message
      : (item.text !== undefined ? item.text : item.content);
    if (typeof rawMessage !== 'string' || !rawMessage.trim()) continue;
    let speaker = null;
    if (typeof rawSpeaker === 'string' && rawSpeaker.trim()) {
      const s = rawSpeaker.trim();
      if (/^(agent|assistant|bot|vaani)$/i.test(s)) speaker = 'Vaani';
      else if (/^(user|customer|caller)$/i.test(s)) speaker = 'Customer';
      else speaker = s;
    }
    let timestamp = null;
    const rawTs = item.timestamp !== undefined ? item.timestamp : item.ts;
    if (rawTs !== undefined && rawTs !== null && rawTs !== '') {
      const d = new Date(rawTs);
      if (!isNaN(d.getTime())) timestamp = d.toISOString();
    }
    out.push({ speaker, message: rawMessage.trim(), timestamp });
    if (out.length >= cap) break;
  }
  return out;
}

// Pick up newer structured keys from extraction output using the same
// only-if-present discipline as the legacy merges: absent stays absent,
// never fabricated. Returns { mach, comm, top } partials for the caller
// to assign into its own structures.
function extractNewStructuredFields(extracted) {
  const out = { mach: {}, comm: {}, top: {} };
  const src = extracted && typeof extracted === 'object' ? extracted : {};
  const md = src.machine_details && typeof src.machine_details === 'object' ? src.machine_details : {};
  const ct = src.commercial_terms && typeof src.commercial_terms === 'object' ? src.commercial_terms : {};
  const present = (v) => v !== undefined && v !== null && v !== '';
  if (present(ct.budget_min_inr)) out.comm.budget_min_inr = ct.budget_min_inr;
  if (present(ct.budget_qualifier)) out.comm.budget_qualifier = ct.budget_qualifier;
  if (present(md.machine_type)) out.mach.machine_type = md.machine_type;
  if (present(md.quantity)) out.mach.quantity = md.quantity;
  if (present(md.model_year_min)) out.mach.model_year_min = md.model_year_min;
  if (present(md.model_year_max)) out.mach.model_year_max = md.model_year_max;
  if (present(md.max_hours)) out.mach.max_hours = md.max_hours;
  if (present(md.preferred_city)) out.mach.preferred_city = md.preferred_city;
  if (present(md.condition)) out.mach.condition = md.condition;
  if (present(md.new_or_used)) out.mach.new_or_used = md.new_or_used;
  if (present(ct.finance_required)) out.comm.finance_required = ct.finance_required;
  if (ct.price_negotiable === true || ct.price_negotiable === false) out.comm.price_negotiable = ct.price_negotiable;
  if (['URGENT', 'SOON', 'EXPLORING', 'NORMAL'].includes(ct.sale_urgency)) out.comm.sale_urgency = ct.sale_urgency;
  if (present(ct.payment_mode)) out.comm.payment_mode = ct.payment_mode;
  if (present(src.lead_status)) out.top.lead_status = src.lead_status;
  if (src.whatsapp_requested === true) out.top.whatsapp_requested = true;
  if (present(src.whatsapp_action)) out.top.whatsapp_action = src.whatsapp_action;
  if (present(src.availability_status)) out.top.availability_status = src.availability_status;
  return out;
}

// Persist genuinely-available transcript segments + a factual summary row
// for the vaani_calls row linked by Dograh run id. Best-effort: never throws,
// never fabricates, skips when the call cannot be linked, when ownership
// does not match, when nothing genuine exists, or when rows already exist.
// Resolve a Dograh run's Vaani owner organization. Prefers the run's own
// initial_context.organization_id (written by Vaani from the authenticated
// session at session creation), then the workflow's org. Null when neither
// resolves: callers fail closed. Never trusts browser input.
async function resolveRunOwnerOrg(runId, queryFn) {
  const q = queryFn || queryPostgres;
  try {
    if (runId === undefined || runId === null) return null;
    const runKey = String(runId).trim();
    if (!/^[0-9]+$/.test(runKey)) return null;
    const rows = await q(
      `SELECT row_to_json(t) FROM (SELECT r.initial_context AS init_ctx, w.organization_id AS wf_org FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1) t;`,
      [parseInt(runKey, 10)]
    ).catch(() => null);
    const row = Array.isArray(rows) ? rows[0] : rows;
    // Legacy stub shape: a bare org id string/number resolves directly.
    if (typeof row === 'string' || typeof row === 'number') {
      const bare = parseInt(row, 10);
      if (!isNaN(bare) && bare > 0) return bare;
      return null;
    }
    if (!row || typeof row !== 'object') return null;
    // Alternate stub/row shape carrying organization_id directly.
    if (row.organization_id !== undefined && row.organization_id !== null
      && row.init_ctx === undefined && row.wf_org === undefined) {
      const direct = parseInt(row.organization_id, 10);
      if (!isNaN(direct) && direct > 0) return direct;
      return null;
    }
    const initCtx = row.init_ctx && typeof row.init_ctx === 'object' ? row.init_ctx : null;
    const runOrg = initCtx && initCtx.organization_id !== undefined && initCtx.organization_id !== null
      ? parseInt(initCtx.organization_id, 10) : NaN;
    if (!isNaN(runOrg) && runOrg > 0) return runOrg;
    const wfOrg = parseInt(row.wf_org, 10);
    if (!isNaN(wfOrg) && wfOrg > 0) return wfOrg;
    return null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4A retry-safe merge: null-safe deep merge for gathered_context blobs.
// Placeholders (null/undefined, '', 'unknown', 'not_applicable') and
// false-vs-true / non-positive-number downgrades never overwrite meaningful
// stored values. Genuine new values (including a changed budget) always win.
// Mirrors the terminal-summary fill-only-nulls discipline.
// ---------------------------------------------------------------------------
const _PLACEHOLDER_STRINGS = new Set(['unknown', 'not_applicable']);

function _isMeaningfulLeaf(value, existing) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return false;
    if (_PLACEHOLDER_STRINGS.has(s.toLowerCase())) return false;
    return true;
  }
  if (typeof value === 'number') {
    // Zero/non-positive numbers are never meaningful sales facts in this
    // domain (prices, years, hours, counts are all positive).
    if (!Number.isFinite(value) || value <= 0) return false;
    return true;
  }
  if (typeof value === 'boolean') {
    // An incoming false never clears a stored true (default/placeholder
    // wins no fights); true always counts as meaningful.
    if (value === false && existing === true) return false;
    return true;
  }
  return true;
}

const _QUAL_RANK = { UNQUALIFIED: 0, PARTIALLY_QUALIFIED: 1, QUALIFIED: 2 };
const _TEMP_RANK = { COLD: 1, WARM: 2, HOT: 3 };

function _isRankGuardedKey(path) {
  const last = path[path.length - 1];
  if (last === 'qualification_state') return 'qual';
  if (last === 'lead_temperature') return 'temp';
  return null;
}

function _mergeValues(path, existing, incoming) {
  // B2: seller price position is recency-sensitive: an explicit incoming
  // boolean (firming up OR newly flexing) always replaces the stored one.
  if (path[path.length - 1] === 'price_negotiable'
    && (incoming === true || incoming === false)) return incoming;
  // Objects recurse (arrays handled below); anything else follows leaf rules
  // with rank guards for derived assessments.
  if (
    existing !== null && typeof existing === 'object' && !Array.isArray(existing) &&
    incoming !== null && typeof incoming === 'object' && !Array.isArray(incoming)
  ) {
    // Whole-object rank guard for the qualification snapshot: a thin retry
    // must not downgrade a stored assessment, while genuine upgrades and
    // DNC-driven DISQUALIFIED always apply.
    if (path[path.length - 1] === 'qualification' && path.length > 0) {
      const inStatus = incoming.status;
      const exStatus = existing.status;
      if (inStatus === 'DISQUALIFIED') return { ...existing, ...incoming };
      const inRank = _QUAL_RANK[inStatus];
      const exRank = _QUAL_RANK[exStatus];
      if (Number.isFinite(inRank) && Number.isFinite(exRank) && inRank < exRank) {
        return existing;
      }
    }
    const out = { ...existing };
    for (const key of Object.keys(incoming)) {
      out[key] = _mergeValues([...path, key], existing[key], incoming[key]);
    }
    return out;
  }
  if (Array.isArray(incoming)) {
    if (incoming.length > 0) return incoming;
    // Empty incoming arrays keep stored content (thin-retry guard). The one
    // exception is a completed qualification snapshot handled above.
    return Array.isArray(existing) ? existing : incoming;
  }
  if (Array.isArray(existing) && !Array.isArray(incoming)) return existing;
  const guard = _isRankGuardedKey(path);
  if (guard === 'qual' && typeof incoming === 'string' && typeof existing === 'string') {
    if (incoming === 'DISQUALIFIED') return incoming;
    const inRank = _QUAL_RANK[incoming];
    const exRank = _QUAL_RANK[existing];
    if (Number.isFinite(inRank) && Number.isFinite(exRank) && inRank < exRank) return existing;
  }
  if (guard === 'temp' && typeof incoming === 'string' && typeof existing === 'string') {
    const inRank = _TEMP_RANK[incoming];
    const exRank = _TEMP_RANK[existing];
    if (Number.isFinite(inRank) && Number.isFinite(exRank) && inRank < exRank) return existing;
  }
  if (!_isMeaningfulLeaf(incoming, existing)) return existing;
  return incoming;
}

// B5: keep only genuine seller concerns. Drops 'unknown' noise and bare
// factual price declarations ("Price 18 lakh hai.") which carry no concern
// language. Pure and unit-tested; the objection engine itself is untouched.
function filterSellerConcernCandidates(detections) {
  const out = [];
  for (const o of (Array.isArray(detections) ? detections : [])) {
    if (!o || !o.type || o.type === 'unknown') continue;
    if (o.type === 'asking_price' && /^\s*(price\s*)?\d[\d\s.,]*\s*(lakh|lac|crore|thousand|hazaar)?\s*(hai|hain)?[.!?]*\s*$/i.test(o.objection_text || '')) continue;
    out.push(o);
  }
  return out;
}

function mergeGatheredContextPreserving(existing, incoming) {
  const prev = existing && typeof existing === 'object' ? existing : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const out = { ...prev };
  for (const key of Object.keys(next)) {
    if (key === 'extracted_variables' || key === 'call_session' || key === 'extraction_audit') {
      const prevSub = prev[key] && typeof prev[key] === 'object' ? prev[key] : {};
      const nextSub = next[key] && typeof next[key] === 'object' ? next[key] : {};
      if (Object.keys(nextSub).length === 0) {
        if (prev[key] !== undefined) out[key] = prev[key];
        continue;
      }
      out[key] = _mergeValues([key], prevSub, nextSub);
      continue;
    }
    out[key] = _mergeValues([key], prev[key], next[key]);
  }
  return out;
}

// 4B deterministic backstop as a testable unit. Buyer only, absent-only:
// quote-anchored parsing fills fields the LLM left null, never overwrites LLM
// values, never invents. Guards the 20-22 -> null/raw-loss failure mode.
function applyDeterministicBackstop({ customerType, transcript, conversation, machDetails, commTerms, payload }) {
  const _segsAll = normalizeTranscriptSegments(transcript || conversation);
  const _customerTextAll = _segsAll.filter((s) => /customer|user|caller/i.test(s.speaker || '')).map((s) => s.message).join('\n');
  // B3: seller urgency backstop. Absent-only fill from deterministic parse;
  // latest-in-transcript explicit position wins among deterministic hits.
  // Never overwrites an LLM-provided value.
  if (customerType === 'seller' && (commTerms.sale_urgency === undefined || commTerms.sale_urgency === null)) {
    for (const _ln of _customerTextAll.split('\n')) {
      const _u = vaaniExtractor.parseSaleUrgency(_ln);
      if (_u !== null) commTerms.sale_urgency = _u;
    }
  }
  if (customerType === 'seller' && (commTerms.price_negotiable === undefined || commTerms.price_negotiable === null)) {
    const _segs2 = normalizeTranscriptSegments(transcript || conversation);
    const _cust2 = _segs2.filter((s) => /customer|user|caller/i.test(s.speaker || '')).map((s) => s.message).join('\n');
    for (const _ln of _cust2.split('\n')) {
      const _n = vaaniExtractor.parsePriceNegotiability(_ln);
      if (_n !== null) { commTerms.price_negotiable = _n; break; }
    }
  }
  if (customerType === 'buyer' && (transcript || conversation)) {
    const _segs = normalizeTranscriptSegments(transcript || conversation);
    const _customerText = _segs.filter((s) => /customer|user|caller/i.test(s.speaker || '')).map((s) => s.message).join('\n');
    const _allText = _segs.map((s) => s.message).join('\n');
    // Requirement Extraction Correction (buyer only): an explicit unambiguous
    // spoken budget is quote-anchored evidence, so the deterministic parse
    // takes precedence over conflicting LLM numbers. Latest budget-bearing
    // line wins (corrections supersede). Absent parse -> LLM values kept.
    // All other fields (finance, quantity, WhatsApp, seller paths) untouched.
    if (_customerText) {
      const _lines = _customerText.split('\n');
      let _best = null;
      for (const _ln of _lines) {
        const _p = vaaniExtractor.parseSpokenPrice(_ln);
        if (_p) _best = _p;
      }
      if (_best) {
        commTerms.budget_max_inr = _best.max_inr;
        commTerms.budget_min_inr = _best.min_inr ?? null;
        commTerms.price_or_budget_raw = _best.raw;
        if (_best.qualifier) commTerms.budget_qualifier = _best.qualifier;
      }
    }
    if (machDetails.quantity === undefined || machDetails.quantity === null) {
      for (const _ln of _customerText.split('\n')) {
        const _q = vaaniExtractor.parseSpokenQuantity(_ln);
        if (_q && Number.isFinite(_q.quantity)) { machDetails.quantity = _q.quantity; break; }
      }
    }
    if (commTerms.finance_required === undefined || commTerms.finance_required === null) {
      for (const _ln of _customerText.split('\n')) {
        const _f = vaaniExtractor.parseFinanceRequirement(_ln);
        if (_f !== null) { commTerms.finance_required = _f; break; }
      }
    }
    if (machDetails.model_year === undefined || machDetails.model_year === null) {
      for (const _ln of _customerText.split('\n')) {
        const _y = vaaniExtractor.parseModelYear(_ln);
        if (_y) { machDetails.model_year = _y; break; }
      }
    }
    if (machDetails.max_hours === undefined || machDetails.max_hours === null) {
      for (const _ln of _customerText.split('\n')) {
        const _h = vaaniExtractor.parseOperatingHours(_ln);
        if (Number.isFinite(_h) && _h > 0) { machDetails.max_hours = _h; break; }
      }
    }
    if (!machDetails.application_history || machDetails.application_history === 'unknown') {
      for (const _ln of _customerText.split('\n')) {
        const _a = vaaniExtractor.parseApplicationHistory(_ln);
        if (_a) { machDetails.application_history = _a; break; }
      }
    }
    if (!payload.whatsapp_requested) {
      for (const _ln of _allText.split('\n')) {
        if (vaaniExtractor.parseWhatsappRequest(_ln)) { payload.whatsapp_requested = true; payload.whatsapp_action = 'PENDING'; break; }
      }
    }
  }
  // B7: callback datetime backstop (buyer + seller). Absent-only fill from
  // deterministic Hindi/Roman-Hindi parse ("kal ek baje"); never overwrites
  // an LLM- or payload-provided value. Latest explicit mention wins.
  // Plain-string transcripts (no speaker segments) are scanned as-is.
  if (!payload.follow_up_datetime && (transcript || conversation)) {
    const _segsCb = normalizeTranscriptSegments(transcript || conversation);
    let _linesCb = _segsCb.filter((s) => /customer|user|caller/i.test(s.speaker || '')).map((s) => s.message);
    if (_linesCb.length === 0) _linesCb = _segsCb.map((s) => s.message);
    if (_linesCb.length === 0 && typeof (transcript || conversation) === 'string') {
      _linesCb = String(transcript || conversation).split('\n');
    }
    let _cbBest = null;
    for (const _ln of _linesCb) {
      const _cb = vaaniExtractor.parseCallbackDatetime(_ln);
      if (_cb) _cbBest = _cb;
    }
    if (_cbBest) payload.follow_up_datetime = _cbBest.datetime;
  }
}

async function persistIngestCallCapture({ orgId, runId, transcript, summary }, queryFn) {
  // Idempotency is call_id + existing-transcript check: a retry for a call
  // that already exists must still persist genuinely-missing transcript rows
  // and must never duplicate existing rows. "Call already exists" alone never
  // blocks capture; only a non-zero transcript COUNT skips the insert.
  const out = { storedTranscript: false, storedSummary: false, callId: null, skipped: null };
  const q = queryFn || queryPostgres;
  try {
    const orgInt = parseInt(orgId, 10);
    if (isNaN(orgInt) || orgInt <= 0) { out.skipped = 'invalid_org'; return out; }
    if (runId === undefined || runId === null) { out.skipped = 'missing_run'; return out; }
    const runKey = String(runId).trim();
    if (!runKey) { out.skipped = 'missing_run'; return out; }
    // Single JSON column: the shared transport returns pipe-separated text
    // for multi-column selects, which cannot be read as an object.
    const callRow = await q(
      'SELECT row_to_json(t) FROM (SELECT id, status FROM vaani_calls WHERE dograh_call_id = $1 ORDER BY id DESC LIMIT 1) t;',
      [runKey]
    ).catch(() => null);
    const call = Array.isArray(callRow) ? callRow[0] : callRow;
    if (!call || call.id === null || call.id === undefined) { out.skipped = 'unlinked_run'; return out; }
    // Ownership through the Dograh run: run-context org (Vaani-attested at
    // creation) wins over the workflow's org; unresolvable fails closed.
    const ownerOrg = await resolveRunOwnerOrg(runKey, q);
    if (ownerOrg === null || ownerOrg !== orgInt) { out.skipped = 'org_mismatch'; return out; }
    out.callId = call.id;
    const segments = normalizeTranscriptSegments(transcript);
    if (segments.length) {
      const existing = await q('SELECT COUNT(*) FROM vaani_transcripts WHERE call_id = $1;', [call.id]).catch(() => null);
      const n = parseInt(Array.isArray(existing) ? existing[0] : existing, 10);
      if (!Number.isFinite(n) || n === 0) {
        const values = segments.map((s) =>
          `(${parseInt(call.id, 10)}, ${sqlEscapeString(s.speaker)}, ${sqlEscapeString(s.message)}` +
          `, ${s.timestamp ? sqlEscapeString(s.timestamp) + '::timestamptz' : 'NULL'})`
        ).join(',');
        await q(`INSERT INTO vaani_transcripts (call_id, speaker, message, timestamp) VALUES ${values};`);
        out.storedTranscript = true;
      } else {
        out.skipped = 'already_stored';
      }
    } else {
      out.skipped = 'empty_transcript';
    }
    const s = summary && typeof summary === 'object' ? summary : {};
    const summaryValues = [
      s.customer_requirement !== undefined && s.customer_requirement !== null && s.customer_requirement !== '' ? s.customer_requirement : null,
      s.machine_discussed !== undefined && s.machine_discussed !== null && s.machine_discussed !== '' ? s.machine_discussed : null,
      s.interest_level !== undefined && s.interest_level !== null && s.interest_level !== '' ? s.interest_level : null,
      s.budget !== undefined && s.budget !== null && s.budget !== '' ? s.budget : null,
      s.customer_intent !== undefined && s.customer_intent !== null && s.customer_intent !== '' ? s.customer_intent : null,
      s.outcome !== undefined && s.outcome !== null && s.outcome !== '' ? s.outcome : null,
      s.next_action !== undefined && s.next_action !== null && s.next_action !== '' ? s.next_action : null,
    ];
    if (summaryValues.some((v) => v !== null)) {
      const existingSummary = await q('SELECT id FROM vaani_call_summaries WHERE call_id = $1 LIMIT 1;', [call.id]).catch(() => null);
      const hasSummary = Array.isArray(existingSummary) ? existingSummary.length > 0
        : (existingSummary !== null && existingSummary !== undefined && String(existingSummary).trim() !== '');
      if (!hasSummary) {
        await q(`INSERT INTO vaani_call_summaries (call_id, customer_requirement, machine_discussed, interest_level, budget, customer_intent, outcome, next_action) VALUES (${parseInt(call.id, 10)}, ${summaryValues.map(sqlEscapeString).join(', ')});`);
        out.storedSummary = true;
      }
    }
  } catch (e) {
    console.warn('[VAANI SALES] transcript capture skipped:', e.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Goal 29 deterministic Automatic Call Summary. Pure composer over already
// known structured data (call row, customer, requirement, qualification,
// objections, matches, transcript segments). No LLM, no scores, no
// negotiation, no commitments: unknown stays null/[] and commitments is
// always [] (nothing in the system may auto-commit).
// ---------------------------------------------------------------------------

const TERMINAL_CALL_STATUSES = Object.freeze(['completed', 'failed', 'no_answer', 'cancelled']);

function buildTerminalCallSummary(input) {
  const src = input && typeof input === 'object' ? input : {};
  const call = src.call && typeof src.call === 'object' ? src.call : {};
  const customerType = src.customer_type === 'buyer' || src.customer_type === 'seller'
    ? src.customer_type : 'unknown';
  const intent = customerType === 'buyer' ? 'purchase'
    : customerType === 'seller' ? 'sell' : 'unknown';
  const callStatus = typeof call.status === 'string' && call.status ? call.status : 'unknown';
  const customer = src.customer && typeof src.customer === 'object' ? src.customer : {};
  const requirement = src.requirement && typeof src.requirement === 'object' ? src.requirement : {};
  const qualification = src.qualification && typeof src.qualification === 'object' ? src.qualification : null;
  const objections = Array.isArray(src.objections) ? src.objections.filter((o) => o && typeof o === 'object') : [];
  const matches = Array.isArray(src.matches) ? src.matches.filter((m) => m && typeof m === 'object') : [];
  const segments = Array.isArray(src.transcriptSegments) ? src.transcriptSegments : [];
  const outcome = (typeof src.conversationOutcome === 'string' && src.conversationOutcome.trim())
    ? src.conversationOutcome.trim() : callStatus;
  const missing = (qualification && Array.isArray(qualification.missing_fields)) ? qualification.missing_fields : [];
  const collected = (qualification && Array.isArray(qualification.collected_fields)) ? qualification.collected_fields : [];

  const fmtMoney = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    return '₹' + (v / 100000).toFixed(2).replace(/\.00$/, '') + 'L';
  };
  const keyPoints = [];
  if (customer.name || customer.phone) {
    keyPoints.push(`Call with ${[customer.name, customer.phone].filter(Boolean).join(' • ')} (${customerType}).`);
  } else {
    keyPoints.push(`Call with unknown ${customerType} contact.`);
  }
  const reqBits = [];
  const pushReq = (label, v, money) => {
    if (v === null || v === undefined || v === '' || (typeof v === 'string' && v.trim().toLowerCase() === 'unknown')) return;
    reqBits.push(`${label}: ${money ? (fmtMoney(v) || v) : v}`);
  };
  if (customerType === 'buyer') {
    pushReq('Machine', requirement.machine_type);
    const bm = [requirement.brand, requirement.model].filter(Boolean).join(' ');
    if (bm) reqBits.push(`Make/Model: ${bm}`);
    pushReq('Budget max', requirement.budget_max, true);
    pushReq('Budget min', requirement.budget_min, true);
    pushReq('City', requirement.preferred_city);
    pushReq('Timeline', requirement.purchase_timeline);
  } else if (customerType === 'seller') {
    const bm = [requirement.brand, requirement.model].filter(Boolean).join(' ');
    if (bm) reqBits.push(`Machine: ${bm}`);
    pushReq('Year', requirement.year);
    pushReq('Hours', requirement.hours);
    pushReq('Condition', requirement.condition);
    pushReq('Asking price', requirement.asking_price, true);
    pushReq('Location', requirement.machine_location);
  }
  keyPoints.push(...reqBits.map((r) => `Requirement — ${r}.`));
  if (segments.length) keyPoints.push(`${segments.length} recorded transcript exchanges.`);
  if (matches.length) {
    const best = matches[0];
    const desc = [best.brand, best.model].filter(Boolean).join(' ') || 'machine';
    keyPoints.push(`${matches.length} inventory match${matches.length === 1 ? '' : 'es'} (best: ${desc}).`);
  }
  for (const o of objections) {
    keyPoints.push(`Objection (${o.type || 'unknown'}): ${o.status || 'open'}${o.owner_needed ? ', owner needed' : ''}.`);
  }
  keyPoints.push(`Call ended as ${callStatus}.`);

  const lines = [];
  const who = customer.name ? `${customer.name} (${customerType})` : `Unknown ${customerType}`;
  lines.push(`${who}: ${outcome}.`);
  if (reqBits.length) lines.push(`Known: ${reqBits.join('; ')}.`);
  if (missing.length) lines.push(`Still missing: ${missing.join(', ')}.`);
  if (matches.length) lines.push(`${matches.length} inventory match${matches.length === 1 ? '' : 'es'} on record.`);
  if (objections.some((o) => o.owner_needed)) lines.push('Owner review required before any commitment.');
  const summary_text = lines.join(' ');

  let next_action = (typeof src.existingNextAction === 'string' && src.existingNextAction.trim())
    ? src.existingNextAction.trim() : null;
  if (!next_action && missing.length) next_action = `Collect: ${missing.join(', ')}`;
  const ownerReasons = objections.filter((o) => o.owner_needed).map((o) => String(o.type || 'unknown'));
  const owner_action = { needed: ownerReasons.length > 0, reasons: ownerReasons };

  return {
    summary_text,
    customer_type: customerType,
    intent,
    key_points: keyPoints,
    requirement: { ...requirement },
    qualification: qualification
      ? { status: qualification.status ?? 'UNQUALIFIED', collected_fields: [...collected], missing_fields: [...missing] }
      : { status: 'UNQUALIFIED', collected_fields: [], missing_fields: [] },
    objections: objections.map((o) => ({ type: o.type || 'unknown', status: o.status || 'open', owner_needed: o.owner_needed === true })),
    inventory_discussed: matches.slice(0, 5).map((m) => ({
      machine_id: m.machine_id ?? null,
      brand: m.brand ?? null,
      model: m.model ?? null,
      match_score: typeof m.match_score === 'number' ? m.match_score : null,
    })),
    commitments: [],
    next_action,
    owner_action,
    missing_info: [...missing],
    outcome,
    call_status: callStatus,
  };
}

// Persist a terminal-call summary with fill-nulls merge semantics: insert
// when absent; otherwise fill only currently-NULL columns, never overwrite
// good data with nulls. Never throws (best-effort); returns what happened.
async function upsertTerminalCallSummary(callId, row, queryFn) {
  const out = { stored: false, updated: false };
  const q = queryFn || queryPostgres;
  try {
    const id = parseInt(callId, 10);
    if (isNaN(id) || id <= 0 || !row || typeof row !== 'object') return out;
    const cols = ['customer_requirement', 'machine_discussed', 'interest_level', 'budget', 'customer_intent', 'outcome', 'next_action'];
    const vals = cols.map((c) => {
      const v = row[c];
      return (v === undefined || v === null || v === '') ? null : String(v);
    });
    if (vals.every((v) => v === null)) return out;
    const existing = await q('SELECT customer_requirement, machine_discussed, interest_level, budget, customer_intent, outcome, next_action FROM vaani_call_summaries WHERE call_id = $1;', [id]).catch(() => null);
    const exRow = Array.isArray(existing) ? existing[0] : existing;
    if (!exRow || exRow.customer_requirement === undefined) {
      await q(`INSERT INTO vaani_call_summaries (call_id, customer_requirement, machine_discussed, interest_level, budget, customer_intent, outcome, next_action) VALUES (${id}, ${vals.map(sqlEscapeString).join(', ')}) ON CONFLICT (call_id) DO NOTHING;`);
      out.stored = true;
      return out;
    }
    const sets = [];
    cols.forEach((c, i) => {
      if (vals[i] !== null && (exRow[c] === null || exRow[c] === undefined || exRow[c] === '')) {
        sets.push(`${c} = ${sqlEscapeString(vals[i])}`);
      }
    });
    if (sets.length) {
      await q(`UPDATE vaani_call_summaries SET ${sets.join(', ')} WHERE call_id = ${id};`);
      out.updated = true;
    }
  } catch (e) {
    console.warn('[VAANI SALES] terminal summary skipped:', e.message);
  }
  return out;
}

// Flatten a gathered_context extracted_variables blob into the lead-shaped
// keys resolveQualificationFields understands. Null-safe, no invention.
function flattenEvRequirement(ev) {
  const src = ev && typeof ev === 'object' ? ev : {};
  const md = src.machine_details && typeof src.machine_details === 'object' ? src.machine_details : {};
  const ct = src.commercial_terms && typeof src.commercial_terms === 'object' ? src.commercial_terms : {};
  return {
    machine_type: md.machine_type ?? null,
    brand: md.brand ?? null,
    model: md.model ?? null,
    buyer_budget_max_inr: ct.budget_max_inr ?? null,
    budget_min: ct.budget_min_inr ?? null,
    preferred_city: md.preferred_city ?? md.location_city ?? null,
    new_or_used: md.new_or_used ?? null,
    purchase_timeline: ct.purchase_timeline ?? null,
    finance_required: ct.finance_required ?? null,
    payment_mode: ct.payment_mode ?? null,
    model_year: md.model_year ?? null,
    running_hours: md.running_hours ?? null,
    condition: md.condition ?? null,
    availability_status: src.availability_status ?? null,
    expected_selling_price_inr: ct.expected_price_inr ?? null,
    machine_location_city: md.location_city ?? null,
    location_city: md.location_city ?? null,
    lead_status: src.lead_status ?? null,
    customer_type: src.customer_type ?? null,
  };
}

// Goal 29 deterministic Automatic Call Summary composer. Pure: builds the
// rich summary object exclusively from supplied structured data. Unknown
// stays null/[]; commitments is always [] (nothing may auto-commit).
function buildTerminalCallSummary(input) {
  const src = input && typeof input === 'object' ? input : {};
  const call = src.call && typeof src.call === 'object' ? src.call : {};
  const customerType = src.customer_type === 'buyer' || src.customer_type === 'seller'
    ? src.customer_type : 'unknown';
  const intent = customerType === 'buyer' ? 'purchase'
    : customerType === 'seller' ? 'sell' : 'unknown';
  const callStatus = (TERMINAL_CALL_STATUSES.includes(call.status) || (typeof call.status === 'string' && call.status))
    ? String(call.status || 'unknown') : 'unknown';
  const customer = src.customer && typeof src.customer === 'object' ? src.customer : {};
  const requirement = src.requirement && typeof src.requirement === 'object' ? src.requirement : {};
  const qualification = src.qualification && typeof src.qualification === 'object' ? src.qualification : null;
  const objections = Array.isArray(src.objections) ? src.objections.filter((o) => o && typeof o === 'object') : [];
  const matches = Array.isArray(src.matches) ? src.matches.filter((m) => m && typeof m === 'object') : [];
  const segments = Array.isArray(src.transcriptSegments) ? src.transcriptSegments : [];
  const outcome = (typeof src.conversationOutcome === 'string' && src.conversationOutcome.trim())
    ? src.conversationOutcome.trim() : callStatus;
  const missing = (qualification && Array.isArray(qualification.missing_fields)) ? qualification.missing_fields : [];
  const collected = (qualification && Array.isArray(qualification.collected_fields)) ? qualification.collected_fields : [];

  const fmtMoney = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    return '₹' + (v / 100000).toFixed(2).replace(/\.00$/, '') + 'L';
  };
  const reqVal = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && (v.trim() === '' || v.trim().toLowerCase() === 'unknown')) return null;
    if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) return null;
    return v;
  };
  const keyPoints = [];
  const cname = typeof customer.name === 'string' && customer.name.trim() ? customer.name.trim() : null;
  const cphone = typeof customer.phone === 'string' && customer.phone.trim() ? customer.phone.trim() : null;
  keyPoints.push(cname || cphone
    ? `Call with ${[cname, cphone].filter(Boolean).join(' • ')} (${customerType}).`
    : `Call with unknown ${customerType} contact.`);
  const describe = [];
  const reqLine = (label, money, ...keys) => {
    for (const k of keys) {
      const v = reqVal(requirement[k]);
      if (v !== null) { describe.push(`${label}: ${money ? (fmtMoney(v) || v) : v}`); return; }
    }
  };
  if (customerType === 'buyer') {
    reqLine('Machine', false, 'machine_type');
    const bm = [reqVal(requirement.brand), reqVal(requirement.model)].filter(Boolean).join(' ');
    if (bm) describe.push(`Make/Model: ${bm}`);
    reqLine('Budget max', true, 'budget_max'); reqLine('Budget min', true, 'budget_min');
    reqLine('City', false, 'preferred_city'); reqLine('Timeline', false, 'purchase_timeline');
  } else if (customerType === 'seller') {
    const bm = [reqVal(requirement.brand), reqVal(requirement.model)].filter(Boolean).join(' ');
    if (bm) describe.push(`Machine: ${bm}`);
    reqLine('Year', false, 'year'); reqLine('Hours', false, 'hours');
    reqLine('Condition', false, 'condition'); reqLine('Asking price', true, 'asking_price');
    reqLine('Location', false, 'machine_location');
  }
  keyPoints.push(...describe.map((d) => `Requirement — ${d}.`));
  if (segments.length) keyPoints.push(`${segments.length} recorded transcript exchanges.`);
  if (matches.length) {
    const best = matches[0];
    const desc = [best.brand, best.model].filter(Boolean).join(' ') || 'machine';
    keyPoints.push(`${matches.length} inventory match${matches.length === 1 ? '' : 'es'} (best: ${desc}).`);
  }
  for (const o of objections) {
    keyPoints.push(`Objection (${o.type || 'unknown'}): ${o.status || 'open'}${o.owner_needed ? ', owner needed' : ''}.`);
  }
  keyPoints.push(`Call ended as ${callStatus}.`);

  const who = cname ? `${cname} (${customerType})` : `Unknown ${customerType}`;
  const lines = [`${who}: ${outcome}.`];
  if (describe.length) lines.push(`Known: ${describe.join('; ')}.`);
  if (missing.length) lines.push(`Still missing: ${missing.join(', ')}.`);
  if (matches.length) lines.push(`${matches.length} inventory match${matches.length === 1 ? '' : 'es'} on record.`);
  const ownerReasons = objections.filter((o) => o.owner_needed).map((o) => String(o.type || 'unknown'));
  if (ownerReasons.length) lines.push('Owner review required before any commitment.');

  let next_action = (typeof src.existingNextAction === 'string' && src.existingNextAction.trim())
    ? src.existingNextAction.trim() : null;
  if (!next_action && missing.length) next_action = `Collect: ${missing.join(', ')}`;

  return {
    summary_text: lines.join(' '),
    customer_type: customerType,
    intent,
    key_points: keyPoints,
    requirement: { ...requirement },
    qualification: qualification
      ? { status: qualification.status ?? 'UNQUALIFIED', collected_fields: [...collected], missing_fields: [...missing] }
      : { status: 'UNQUALIFIED', collected_fields: [], missing_fields: [] },
    objections: objections.map((o) => ({ type: o.type || 'unknown', status: o.status || 'open', owner_needed: o.owner_needed === true })),
    inventory_discussed: matches.slice(0, 5).map((m) => ({
      machine_id: m.machine_id ?? null,
      brand: m.brand ?? null,
      model: m.model ?? null,
      match_score: typeof m.match_score === 'number' ? m.match_score : null,
    })),
    commitments: [],
    next_action,
    owner_action: { needed: ownerReasons.length > 0, reasons: ownerReasons },
    missing_info: [...missing],
    outcome,
    call_status: callStatus,
  };
}

// Assemble + persist a terminal-call summary from live structured data.
// Best-effort, never throws: failed/no-answer/cancelled calls get a minimal
// factual record; nothing is fabricated when conversation data is absent.
async function summarizeTerminalCall({ callId, status, orgId }, queryFn) {
  const out = { summary: null, stored: false };
  const q = queryFn || queryPostgres;
  try {
    const id = parseInt(callId, 10);
    const orgInt = parseInt(orgId, 10);
    if (isNaN(id) || id <= 0 || isNaN(orgInt) || orgInt <= 0) return out;
    if (!TERMINAL_CALL_STATUSES.includes(status)) return out;
    const callRows = await q(
      `SELECT row_to_json(t) FROM (SELECT c.id, c.status, c.started_at, c.ended_at, c.duration, c.direction, c.mode, c.dograh_call_id, cu.name AS customer_name, cu.phone AS customer_phone FROM vaani_calls c LEFT JOIN vaani_customers cu ON cu.id = c.customer_id WHERE c.id = $1) t;`,
      [id]
    ).catch(() => null);
    const callRow = Array.isArray(callRows) ? callRows[0] : callRows;
    if (!callRow || callRow.id === null || callRow.id === undefined) return out;
    // Ownership re-verified through the Dograh run chain (fail closed).
    const runKey = callRow.dograh_call_id !== null && callRow.dograh_call_id !== undefined
      ? String(callRow.dograh_call_id).trim() : '';
    let runEv = {};
    if (/^[0-9]+$/.test(runKey)) {
      const runRows = await q(
        `SELECT row_to_json(t) FROM (SELECT r.gathered_context->'extracted_variables' AS ev, w.organization_id AS org FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = $1) t;`,
        [parseInt(runKey, 10)]
      ).catch(() => null);
      const runRow = Array.isArray(runRows) ? runRows[0] : runRows;
      const ownerOrg = runRow ? parseInt(runRow.org, 10) : NaN;
      if (!runRow || isNaN(ownerOrg) || ownerOrg !== orgInt) return out;
      const evRaw = runRow.ev;
      if (evRaw && typeof evRaw === 'object') {
        runEv = evRaw;
      } else if (typeof evRaw === 'string' && evRaw.trim()) {
        try { runEv = JSON.parse(evRaw); } catch (_) { runEv = {}; }
        if (!runEv || typeof runEv !== 'object') runEv = {};
      }
    } else {
      return out;
    }
    const evType = runEv.customer_type === 'buyer' || runEv.customer_type === 'seller' ? runEv.customer_type : 'unknown';
    const flatReq = flattenEvRequirement(runEv);
    const resolved = resolveQualificationFields(evType, flatReq);
    const completeness = evaluateQualificationCompleteness(evType, resolved, false);
    const segRows = await q(
      `SELECT COALESCE(json_agg(t ORDER BY t.timestamp ASC NULLS LAST, t.id ASC), '[]'::json) FROM (SELECT id, speaker, message, timestamp FROM vaani_transcripts WHERE call_id = $1) t;`,
      [id]
    ).catch(() => []);
    const segments = normalizeTranscriptSegments(Array.isArray(segRows) ? segRows : (segRows ? [segRows] : []));
    const objections = detectObjections(evType, segments, {
      budget: flatReq.buyer_budget_max_inr ?? flatReq.budget_min ?? undefined,
    });
    const summary = buildTerminalCallSummary({
      call: { id, status, started_at: callRow.started_at, ended_at: callRow.ended_at, duration: callRow.duration },
      customer_type: evType,
      customer: { name: callRow.customer_name || null, phone: callRow.customer_phone || null },
      requirement: resolved,
      qualification: completeness,
      objections,
      matches: [],
      transcriptSegments: segments,
      conversationOutcome: (typeof runEv.conversation_outcome === 'string' && runEv.conversation_outcome.trim())
        ? runEv.conversation_outcome.trim() : null,
      existingNextAction: null,
    });
    const machineDiscussed = [resolved.brand, resolved.model].filter(Boolean).join(' ') || null;
    const budgetRaw = resolved.asking_price ?? resolved.budget_max ?? resolved.budget_min ?? null;
    const stored = await upsertTerminalCallSummary(id, {
      customer_requirement: null,
      machine_discussed: machineDiscussed,
      interest_level: null,
      budget: (typeof budgetRaw === 'number') ? String(budgetRaw) : budgetRaw,
      customer_intent: evType,
      outcome: summary.outcome,
      next_action: summary.next_action,
    }, q);
    out.summary = summary;
    out.stored = stored.stored || stored.updated;
  } catch (e) {
    console.warn('[VAANI SALES] terminal summary skipped:', e.message);
  }
  return out;
}

// Insert-or-fill-nulls persistence for terminal summaries. Never overwrites
// good data with nulls; skips entirely when the row carries nothing genuine.
async function upsertTerminalCallSummary(callId, row, queryFn) {
  const out = { stored: false, updated: false };
  const q = queryFn || queryPostgres;
  try {
    const id = parseInt(callId, 10);
    if (isNaN(id) || id <= 0 || !row || typeof row !== 'object') return out;
    const cols = ['customer_requirement', 'machine_discussed', 'interest_level', 'budget', 'customer_intent', 'outcome', 'next_action'];
    const vals = cols.map((c) => {
      const v = row[c];
      return (v === undefined || v === null || v === '') ? null : String(v);
    });
    if (vals.every((v) => v === null)) return out;
    const existing = await q('SELECT customer_requirement, machine_discussed, interest_level, budget, customer_intent, outcome, next_action FROM vaani_call_summaries WHERE call_id = $1;', [id]).catch(() => null);
    const exRow = Array.isArray(existing) ? existing[0] : existing;
    if (!exRow || exRow.customer_requirement === undefined) {
      await q(`INSERT INTO vaani_call_summaries (call_id, customer_requirement, machine_discussed, interest_level, budget, customer_intent, outcome, next_action) VALUES (${id}, ${vals.map(sqlEscapeString).join(', ')}) ON CONFLICT (call_id) DO NOTHING;`);
      out.stored = true;
      return out;
    }
    const sets = [];
    cols.forEach((c, i) => {
      if (vals[i] !== null && (exRow[c] === null || exRow[c] === undefined || exRow[c] === '')) {
        sets.push(`${c} = ${sqlEscapeString(vals[i])}`);
      }
    });
    if (sets.length) {
      await q(`UPDATE vaani_call_summaries SET ${sets.join(', ')} WHERE call_id = ${id};`);
      out.updated = true;
    }
  } catch (e) {
    console.warn('[VAANI SALES] terminal summary persist skipped:', e.message);
  }
  return out;
}

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
  const rawWfId = callMeta.workflow_id !== undefined && callMeta.workflow_id !== null
    ? callMeta.workflow_id
    : payload.workflow_id;
  if (rawWfId === undefined || rawWfId === null || isNaN(Number(rawWfId))) {
    const err = new Error('Missing or invalid call_metadata.workflow_id (integer required)');
    err.statusCode = 400;
    err.code = 'missing_workflow_id';
    err.errorCode = 'INVALID_PAYLOAD';
    throw err;
  }
  let wfId = parseInt(rawWfId, 10);
  if (!Number.isSafeInteger(wfId) || wfId <= 0) {
    const err = new Error('Invalid call_metadata.workflow_id (positive integer required)');
    err.statusCode = 400;
    err.code = 'invalid_workflow_id';
    err.errorCode = 'INVALID_PAYLOAD';
    throw err;
  }

  // The workflow owns the run. Never trust an organization id from the
  // relay, a pre-created run, or any request parameter. The workflow row is
  // authoritative; the run context and relay value must agree with it.
  const ingestionTarget = await resolveIngestionWorkflow(wfId, queryPostgres);
  if (!ingestionTarget) {
    const err = new Error('Cannot determine the workflow organization for call ingestion');
    err.statusCode = 400;
    err.code = 'unknown_workflow';
    err.errorCode = 'MISSING_TENANT';
    throw err;
  }
  wfId = ingestionTarget.wfId;
  const wfOrgId = ingestionTarget.wfOrgId;
  const bridgedWorkflow = ingestionTarget.bridged;
  const runOwnerOrg = await resolveRunOwnerOrg(numericRunId, queryPostgres);
  const relayOrgId = callMeta.org_id ? parseInt(callMeta.org_id, 10) : null;
  if (Number.isSafeInteger(runOwnerOrg) && runOwnerOrg > 0 && runOwnerOrg !== wfOrgId) {
    const err = new Error('Call run organization does not match its workflow organization');
    err.statusCode = 403;
    err.code = 'org_mismatch';
    err.errorCode = 'ORG_MISMATCH';
    throw err;
  }
  if (!bridgedWorkflow && Number.isSafeInteger(relayOrgId) && relayOrgId > 0 && relayOrgId !== wfOrgId) {
    const err = new Error('Relay organization does not match the workflow organization');
    err.statusCode = 403;
    err.code = 'org_mismatch';
    err.errorCode = 'ORG_MISMATCH';
    throw err;
  }
  const orgId = wfOrgId;

  // Idempotency check: verify if run already exists in database
  const existingRun = await queryPostgres(
    `SELECT row_to_json(r) FROM (SELECT id, is_completed, state FROM workflow_runs WHERE id = ${sqlEscapeInt(numericRunId)}) r;`
  ).catch(() => null);

  const isDuplicate = Boolean(existingRun && (existingRun.is_completed || existingRun.state === 'completed'));

  const leadId = payload.lead_id || `lead_${numericRunId}`;
  let customerType = resolveCustomerType(payload);

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

  // Fallback removed: machine information alone MUST NOT classify a lead as seller

  const commTerms = payload.commercial_terms || {};
  const evReadiness = payload.evidence_readiness || {};
  const extVars = payload.extracted_variables || {};

  // Phase 1 (plan v2): Dograh already extracted the buyer/seller facts from the
  // conversation itself. Merge them into the working set with the same
  // only-if-present discipline used everywhere else, so nothing Dograh learned
  // is dropped when the transcript is empty or partial. The LLM re-extraction
  // below still runs and still fills whatever is still missing.
  mergeExtractedVariables(extVars, payload, { machDetails, commTerms, evReadiness });

  // Fetch Lead History
  let leadHistory = null;
  if (phone) {
    const historyQuery = await queryPostgres(`
      SELECT json_agg(h) FROM (
        SELECT id, created_at, state, gathered_context->'extracted_variables' AS extracted
        FROM workflow_runs
        WHERE (gathered_context->'extracted_variables'->>'callback_number') = ${sqlEscapeString(phone)}
           OR (gathered_context->'extracted_variables'->>'whatsapp_number') = ${sqlEscapeString(phone)}
           OR (gathered_context->'call_session'->>'primary_phone') = ${sqlEscapeString(phone)}
        ORDER BY created_at DESC
        LIMIT 3
      ) h;
    `).catch(() => null);
    if (historyQuery && Array.isArray(historyQuery)) {
      leadHistory = historyQuery.map(r => r.extracted).filter(Boolean);
    }
  }

  // Phase F Step 2: Auto-extract from conversation if transcript is present
  let extractionAudit = null;
  if (payload.transcript || payload.conversation) {
    try {
      const extractionResult = await module.exports.extractFromConversation(payload.transcript || payload.conversation, leadHistory);
      extractionAudit = {
        provenance: {},
        missing_info: {},
        correction_history: [],
        follow_up_question: null
      };

      const transType = normalizeCustomerType(extractionResult.extracted.customer_type);
      // VAANI-001: LLM extraction may correct an explicit classification, but only
      // when it returns a valid buyer/seller/other value. Ambiguous or unrecognized
      // LLM output (transType === null) never silently overrides an existing
      // classification or fabricates buyer/seller.
      if (transType) {
        customerType = transType;
      }

      if (!payload.lead_temperature && extractionResult.extracted.lead_temperature) payload.lead_temperature = extractionResult.extracted.lead_temperature;
      if (!payload.next_action && extractionResult.extracted.next_action) payload.next_action = extractionResult.extracted.next_action;
      if (!payload.customer_name && extractionResult.extracted.caller_name) payload.customer_name = extractionResult.extracted.caller_name;
      if (extractionResult.extracted.follow_up_required !== null) payload.follow_up_required = extractionResult.extracted.follow_up_required;
      if (extractionResult.extracted.dnc_requested) payload.dnc_requested = true;

      // Map new Phase 3 fields to payload so they persist
      if (extractionResult.extracted.sales_priority) payload.sales_priority = extractionResult.extracted.sales_priority;
      if (extractionResult.extracted.priority_reason) payload.priority_reason = extractionResult.extracted.priority_reason;
      if (extractionResult.extracted.deal_readiness) payload.deal_readiness = extractionResult.extracted.deal_readiness;
      if (extractionResult.extracted.deal_ready_reason) payload.deal_ready_reason = extractionResult.extracted.deal_ready_reason;
      if (extractionResult.extracted.owner_summary) payload.owner_summary = extractionResult.extracted.owner_summary;

      const extMach = extractionResult.extracted.machine_details;
      if (!machDetails.brand && extMach.brand) machDetails.brand = extMach.brand;
      if (!machDetails.model && extMach.model) machDetails.model = extMach.model;
      if (machDetails.model_year === undefined && extMach.model_year) machDetails.model_year = extMach.model_year;
      if (machDetails.max_hours === undefined && extMach.max_hours !== undefined && extMach.max_hours !== null) machDetails.max_hours = extMach.max_hours;
      if (!machDetails.condition && extMach.condition) machDetails.condition = extMach.condition;
      if (machDetails.running_hours === undefined && extMach.running_hours) machDetails.running_hours = extMach.running_hours;
      if ((!machDetails.tonnage_class || machDetails.tonnage_class === 'unknown') && extMach.tonnage_class !== 'unknown') machDetails.tonnage_class = extMach.tonnage_class;
      if ((!machDetails.application_history || machDetails.application_history === 'unknown') && extMach.application_history !== 'unknown') machDetails.application_history = extMach.application_history;
      if (!machDetails.location_city && extMach.location_city) machDetails.location_city = extMach.location_city;
      if (!machDetails.location_state && extMach.location_state) machDetails.location_state = extMach.location_state;
      if ((!machDetails.document_status || machDetails.document_status === 'unknown') && extMach.document_status !== 'unknown') machDetails.document_status = extMach.document_status;

      const extComm = extractionResult.extracted.commercial_terms;
      if (commTerms.expected_price_inr === undefined && extComm.expected_price_inr) commTerms.expected_price_inr = extComm.expected_price_inr;
      if ((commTerms.price_negotiable === undefined || commTerms.price_negotiable === null) && (extComm.price_negotiable === true || extComm.price_negotiable === false)) commTerms.price_negotiable = extComm.price_negotiable;
      if ((commTerms.sale_urgency === undefined || commTerms.sale_urgency === null) && ['URGENT', 'SOON', 'EXPLORING', 'NORMAL'].includes(extComm.sale_urgency)) commTerms.sale_urgency = extComm.sale_urgency;
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

      // Newer structured keys (buyer requirements / seller machine context):
      // same only-if-present discipline, never fabricated.
      const newStructured = extractNewStructuredFields(extractionResult.extracted);
      Object.assign(machDetails, newStructured.mach);
      Object.assign(commTerms, newStructured.comm);
      if (newStructured.top.lead_status !== undefined) payload.lead_status = newStructured.top.lead_status;
      if (newStructured.top.whatsapp_requested === true) payload.whatsapp_requested = true;
      if (newStructured.top.whatsapp_action !== undefined) payload.whatsapp_action = newStructured.top.whatsapp_action;
      if (newStructured.top.availability_status !== undefined) payload.availability_status = newStructured.top.availability_status;
    } catch (extractionErr) {
      // Extraction is an enhancement: a provider outage must not drop the call.
      console.warn('[VAANI SALES] LLM extraction skipped:', extractionErr.message);
    }
  }

  // A caller's own words outrank Dograh's intent, the LLM result, and history.
  const spokenType = detectCustomerTypeFromTranscript(payload.transcript || payload.conversation);
  if (spokenType) customerType = spokenType;

  applyDeterministicBackstop({
    customerType, transcript: payload.transcript, conversation: payload.conversation,
    machDetails, commTerms, payload,
  });

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

  // Goal 24 deterministic completeness (factual only: no scores, no
  // temperatures, no predictions). Computed from already-merged locals so
  // manual and conversation paths share one definition.
  const qualSnapshot = customerType === 'buyer'
    ? {
        machine_type: machDetails.machine_type,
        budget_max: commTerms.budget_max_inr, budget_min: commTerms.budget_min_inr,
        preferred_city: machDetails.preferred_city,
        new_or_used: normalizeNewOrUsed(machDetails.new_or_used),
        purchase_timeline: commTerms.purchase_timeline,
        finance_required: normalizeFinanceRequired(commTerms.finance_required),
        payment_mode: normalizePaymentMode(commTerms.payment_mode),
      }
    : customerType === 'seller'
      ? {
          machine_type: machDetails.machine_type,
          brand: machDetails.brand, model: machDetails.model,
          year: machDetails.model_year, hours: machDetails.running_hours,
          condition: machDetails.condition,
          availability_status: payload.availability_status,
          asking_price: commTerms.expected_price_inr,
          machine_location: city,
        }
      : {};
  const completeness = evaluateQualificationCompleteness(customerType, qualSnapshot, isDnc);
  if (extractionAudit && typeof extractionAudit === 'object') {
    extractionAudit.missing_info = { fields: completeness.missing_fields };
  }

  const extractedVariables = {
    sales_priority: payload.sales_priority || null,
    priority_reason: payload.priority_reason || null,
    deal_readiness: payload.deal_readiness || null,
    deal_ready_reason: payload.deal_ready_reason || null,
    owner_summary: payload.owner_summary || null,
    caller_name: payload.customer_name || payload.caller_name || null,
    callback_number: phone,
    whatsapp_number: payload.whatsapp_phone || payload.whatsapp_number || phone,
    customer_type: customerType,
    ownership_type: payload.ownership_type || 'unknown',
    lead_status: payload.lead_status || null,
    availability_status: payload.availability_status || null,
    machine_details: {
      brand: machDetails.brand || null,
      model: machDetails.model || null,
      machine_type: machDetails.machine_type || null,
      model_year_min: machDetails.model_year_min ?? null,
      model_year_max: machDetails.model_year_max ?? null,
      quantity: (Number.isFinite(parseInt(machDetails.quantity, 10)) && parseInt(machDetails.quantity, 10) > 0 ? parseInt(machDetails.quantity, 10) : null),
      max_hours: machDetails.max_hours ?? null,
      preferred_city: machDetails.preferred_city || null,
      condition: machDetails.condition || null,
      new_or_used: normalizeNewOrUsed(machDetails.new_or_used),
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
      budget_min_inr: commTerms.budget_min_inr ?? null,
      finance_required: normalizeFinanceRequired(commTerms.finance_required),
      payment_mode: normalizePaymentMode(commTerms.payment_mode),
      price_or_budget_raw: commTerms.price_or_budget_raw || null,
      price_negotiable: (commTerms.price_negotiable === true || commTerms.price_negotiable === false) ? commTerms.price_negotiable : null,
      sale_urgency: ['URGENT', 'SOON', 'EXPLORING', 'NORMAL'].includes(commTerms.sale_urgency) ? commTerms.sale_urgency : null,
      budget_qualifier: ['exact', 'range', 'max', 'approximate'].includes(commTerms.budget_qualifier) ? commTerms.budget_qualifier : null,
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
    qualification: {
      status: completeness.status,
      collected_fields: completeness.collected_fields,
      missing_fields: completeness.missing_fields,
    },
    whatsapp_requested: payload.whatsapp_requested === true,
    whatsapp_action: payload.whatsapp_requested === true ? (payload.whatsapp_action || 'PENDING') : null,
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
    transcript: payload.transcript || payload.conversation || null,
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

  // 4A retry-safe merge: read the stored gathered_context first so a thin
  // retry payload fills gaps instead of clobbering stored facts with nulls.
  // Read-only SELECT; the write stays inside the transaction below.
  let storedGathered = null;
  try {
    const existingRows = await queryPostgres(
      'SELECT row_to_json(t) FROM (SELECT gathered_context FROM workflow_runs WHERE id = $1) t;',
      [numericRunId]
    ).catch(() => null);
    const existingRow = Array.isArray(existingRows) ? existingRows[0] : existingRows;
    const rawGathered = existingRow && typeof existingRow === 'object'
      ? existingRow.gathered_context : existingRow;
    storedGathered = (rawGathered && typeof rawGathered === 'object') ? rawGathered : null;
    if (typeof storedGathered === 'string') {
      try { storedGathered = JSON.parse(storedGathered); } catch (_) { storedGathered = null; }
    }
    if (storedGathered && typeof storedGathered !== 'object') storedGathered = null;
  } catch (_) { storedGathered = null; }
  // B5 seller concern capture (seller-only): detect concerns from this
  // call's customer utterances using the existing category engine, then merge
  // with stored concerns by type (newest wins), skipping 'unknown' noise and
  // capping at 10. Null/empty never erases stored concerns. Buyer flows and
  // the 4A merge below are untouched.
  if (customerType === 'seller') {
    try {
      const _csegs = normalizeTranscriptSegments(payload.transcript || payload.conversation);
      const _fresh = filterSellerConcernCandidates(detectObjections('seller', _csegs, {
        asking_price: expectedPrice, location: city,
      })).slice(0, 10);
      const _stored = storedGathered && storedGathered.extracted_variables
        && Array.isArray(storedGathered.extracted_variables.seller_concerns)
        ? storedGathered.extracted_variables.seller_concerns.filter((o) => o && o.type && o.type !== 'unknown')
        : [];
      const _byType = {};
      for (const o of [..._stored, ..._fresh]) {
        if (o && typeof o.type === 'string') _byType[o.type] = o;
      }
      const _mergedConcerns = Object.values(_byType).slice(-10);
      if (_mergedConcerns.length) extractedVariables.seller_concerns = _mergedConcerns;
    } catch (_) {}
  }
  // First insert stores the payload verbatim (today's exact behavior);
  // the null-safe merge applies only when a stored blob already exists.
  const incomingGathered = {
    extracted_variables: extractedVariables,
    call_session: callSession,
    extraction_audit: extractionAudit || {},
  };
  const mergedGathered = storedGathered
    ? mergeGatheredContextPreserving(storedGathered, incomingGathered)
    : incomingGathered;
  const mergedExtracted = mergedGathered.extracted_variables || extractedVariables;
  const mergedSession = mergedGathered.call_session || callSession;
  const mergedAudit = mergedGathered.extraction_audit || extractionAudit || {};

  // ---- Phase 1 (plan v2): verified artifact URLs ----------------------------
  // Dograh owns the only copy of a run's recording and transcript, and the
  // relay does not forward them yet (plan v2 phase 2). The object keys are
  // derived from the run id using Dograh's own naming convention, and each
  // object is verified to exist before its URL is persisted — a URL is never
  // written for an object that is not there.
  const artifactCandidates = {
    recording: callMeta.recording_url || `recordings/${numericRunId}.wav`,
    transcript: callMeta.transcript_url || `transcripts/${numericRunId}.txt`,
  };
  const [recordingUrl, transcriptUrl] = await Promise.all([
    verifyArtifactUrl(artifactCandidates.recording),
    verifyArtifactUrl(artifactCandidates.transcript),
  ]);
  const storageBackend = callMeta.storage_backend || 'minio';
  // The call start is preferred over the ingestion moment so the run keeps the
  // time the call actually happened instead of the time the webhook landed.
  const runStartedAt = callMeta.started_at
    || (storedGathered && storedGathered.call_session && storedGathered.call_session.started_at)
    || null;
  const runStartedAtSql = (runStartedAt && !isNaN(new Date(runStartedAt).getTime()))
    ? `${sqlEscapeString(new Date(runStartedAt).toISOString())}::timestamptz`
    : 'CURRENT_TIMESTAMP';

  // Build ACID PostgreSQL Transaction SQL
  const txStatements = ['BEGIN;'];

  // 1. workflow_runs record
  txStatements.push(`
    INSERT INTO workflow_runs (
      id, name, workflow_id, mode, created_at, is_completed, usage_info, cost_info,
      initial_context, gathered_context, annotations, logs, storage_backend, state, call_type, extra,
      recording_url, transcript_url
    ) VALUES (
      ${sqlEscapeInt(numericRunId)},
      ${sqlEscapeString('vaani-call-' + numericRunId)},
      ${sqlEscapeInt(wfId)},
      'smallwebrtc',
      ${runStartedAtSql},
      true,
      '{}'::json,
      '{}'::json,
      '{}'::json,
      json_build_object(
        'extracted_variables', ${sqlEscapeJson(mergedExtracted)},
        'call_session', ${sqlEscapeJson(mergedSession)},
        'extraction_audit', ${sqlEscapeJson(mergedAudit)}
      )::json,
      '{}'::json,
      '{}'::json,
      ${sqlEscapeString(storageBackend)},
      'completed',
      ${sqlEscapeString(direction)},
      '{}'::json,
      ${recordingUrl ? sqlEscapeString(recordingUrl) : 'NULL'},
      ${transcriptUrl ? sqlEscapeString(transcriptUrl) : 'NULL'}
    )
    ON CONFLICT (id) DO UPDATE SET
      gathered_context = jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE(workflow_runs.gathered_context::jsonb, '{}'::jsonb),
            '{extracted_variables}',
            ${sqlEscapeJson(mergedExtracted)},
            true
          ),
          '{call_session}',
          ${sqlEscapeJson(mergedSession)},
          true
        ),
        '{extraction_audit}',
        ${sqlEscapeJson(mergedAudit)},
        true
      )::json,
      is_completed = true,
      state = 'completed',
      storage_backend = EXCLUDED.storage_backend,
      recording_url = COALESCE(EXCLUDED.recording_url, workflow_runs.recording_url),
      transcript_url = COALESCE(EXCLUDED.transcript_url, workflow_runs.transcript_url);
  `);

  // 2. vaani_machines record (if seller with brand & model)
  if (machineId) {
    const hmr = extractedVariables.machine_details.running_hours;
    const loc = extractedVariables.machine_details.location_city || 'Jaipur Yard (Loha Mandi / VKI Area)';
    txStatements.push(`
      INSERT INTO vaani_machines (
        organization_id, machine_id, source_lead_run_id, brand, model, manufacturing_year,
        hour_meter_reading, application_history, sourcing_cost_inr, target_resale_inr, status, current_location, updated_at
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
        target_resale_inr = EXCLUDED.target_resale_inr,
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

  // ---- Phase 1 (plan v2): call completion state ----------------------------
  // The call may only be marked completed when there is reliable evidence that
  // a conversation actually happened. Terminal states (failed, no_answer,
  // cancelled, completed) are never overwritten, and without evidence the
  // status is left exactly as it is and the reason is reported back.
  const callStatusUpdate = await applyCallCompletionStatus({
    runId: numericRunId,
    orgId,
    segments: normalizeTranscriptSegments(payload.transcript || payload.conversation || null),
    disposition: payload.call_disposition || null,
    outcome: extractedVariables.conversation_outcome || null,
    durationSeconds: durationSec,
    startedAt: runStartedAt,
  });
  if (!callStatusUpdate.transitioned && callStatusUpdate.previous_status) {
    console.warn(`[VAANI SALES] Call ${callStatusUpdate.previous_status} for run ${numericRunId} left unchanged — ${callStatusUpdate.reason}`);
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
      follow_up_datetime: followUp.follow_up_datetime,
      sales_priority: extractedVariables.sales_priority,
      deal_readiness: extractedVariables.deal_readiness,
      owner_summary: extractedVariables.owner_summary,
      deal_ready_reason: extractedVariables.deal_ready_reason
    });
  } catch (taskErr) {
    console.warn('[VAANI SALES] Notice processing follow-up tasks:', taskErr.message);
  }

  // Buyer inventory matching (DB-backed, best-effort — never fails ingestion).
  // Previously only reachable via the manual CRM endpoint; now runs automatically
  // for buyer calls so "available machines" answers are grounded in stock.
  let inventoryMatches = [];
  try {
    const md = extractedVariables.machine_details || {};
    const ct = extractedVariables.commercial_terms || {};
    if (customerType === 'buyer' && (md.brand || md.model)) {
      inventoryMatches = await runIntelligentMatching(orgId, numericRunId, {
        machine_brand: md.brand || null,
        machine_model: md.model || null,
        budget_max_inr: ct.budget_max_inr ?? null,
        buyer_budget_max_inr: ct.budget_max_inr ?? null,
        model_year_min: null,
        model_year_max: md.model_year ?? null,
        running_hours_max: null,
      });
    }
  } catch (matchErr) {
    console.warn('[VAANI SALES] Notice running inventory matching:', matchErr.message);
  }

  // Goal 23: persist genuinely-available transcript segments + a factual
  // summary row for the linked browser call. Best-effort only: never fails
  // ingestion, never fabricates. Idempotency is call_id + existing-transcript
  // check, so a duplicate run (is_duplicate=true) still backfills genuinely
  // missing transcript rows without ever duplicating existing rows.
  // Failed/no-answer calls never reach ingest, so they receive no transcript.
  let capture = { storedTranscript: false, storedSummary: false, callId: null, skipped: null };
  try {
    const reqText = [machDetails.brand, machDetails.model].filter(Boolean).join(' ') || null;
    capture = await persistIngestCallCapture({
      orgId,
      runId: numericRunId,
      transcript: payload.transcript || payload.conversation || null,
      summary: {
        customer_requirement: payload.machine_requirement || payload.requirement || reqText,
        machine_discussed: reqText,
        interest_level: null,
        budget: commTerms.price_or_budget_raw || null,
        customer_intent: customerType,
        outcome: payload.conversation_outcome || null,
        next_action: (typeof nextAction === 'string' && nextAction.trim()) ? nextAction.trim() : null,
      },
    });
  } catch (capErr) {
    console.warn('[VAANI SALES] Notice persisting call capture:', capErr.message);
    capture.skipped = 'error';
  }

  return {
    success: true,
    lead_id: leadId,
    run_id: numericRunId,
    call_session_id: callSession.call_session_id,
    status: callSession.status,
    is_duplicate: isDuplicate,
    transcript_capture: capture,
    call_status: callStatusUpdate,
    artifacts: { recording_url: recordingUrl, transcript_url: transcriptUrl },
    extracted_variables: mergedExtracted,
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

/**
 * Owner Control-Room digest (Phase 5): one read-only summary built ONLY from
 * existing getters over real Supabase data. No new tables, no writes, no sends.
 * Serves GET /api/vaani/sales/digest and the daily log hook.
 */
async function getOwnerDigest(organizationId) {
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) throw new Error('organization_id required');
  const [overview, followUps, buyers, sellers, machines, activities] = await Promise.all([
    getOverview(false, orgInt).catch(() => null),
    getFollowUps(false, orgInt).catch(() => ({ overdue: [], due_today: [], upcoming: [] })),
    getBuyers({}, false, orgInt).catch(() => []),
    getSellers({}, false, orgInt).catch(() => []),
    getMachines(false, orgInt).catch(() => []),
    getRecentActivities(15, false, orgInt).catch(() => []),
  ]);
  const buyerList = Array.isArray(buyers) ? buyers : [];
  const sellerList = Array.isArray(sellers) ? sellers : [];
  const leads = [...buyerList, ...sellerList];
  const isHot = (l) => l.lead_temperature === 'HOT';
  const isReady = (l) => l.deal_readiness === 'READY_FOR_HUMAN';
  const isCritHigh = (l) => ['CRITICAL', 'HIGH'].includes(l.sales_priority);
  const todayStr = new Date().toISOString().slice(0, 10);
  const machineList = Array.isArray(machines) ? machines
    : (machines && Array.isArray(machines.actual_stock) ? machines.actual_stock : []);
  return {
    generated_at: new Date().toISOString(),
    organization_id: orgInt,
    overview: overview || null,
    follow_ups: {
      overdue: (followUps.overdue || []).length,
      due_today: (followUps.due_today || []).length,
      upcoming: (followUps.upcoming || []).length,
    },
    leads: {
      buyers: buyerList.length,
      sellers: sellerList.length,
      hot: leads.filter(isHot).length,
      critical_high_priority: leads.filter(isCritHigh).length,
      ready_for_human: leads.filter(isReady).length,
    },
    inventory: {
      total: machineList.length,
      available: machineList.filter((m) => ['available', 'certified_ready_in_yard'].includes(m.status)).length,
    },
    recent_activities: Array.isArray(activities) ? activities.slice(0, 15) : [],
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


// First id-like scalar from a queryPostgres result, which may be a JSON
// object/array (row_to_json) or plain pipe text for single-column selects.
function firstScalarId(out) {
  if (out === null || out === undefined) return NaN;
  if (Array.isArray(out)) return firstScalarId(out[0]);
  if (typeof out === 'object') {
    if (out.id !== null && out.id !== undefined) return out.id;
    return NaN;
  }
  return String(out).trim().split('|')[0];
}

// Resolve the Vaani workflow for an ingested call. Dograh's workflow ids come
// from its own DB; when the id is unknown, the configured bridge org decides.
// shortcut: single-tenant bridge, replace with an explicit Dograh->Vaani
// workflow map before running more than one organization.
async function resolveIngestionWorkflow(wfId, queryFn) {
  const q = queryFn || queryPostgres;
  const wfRow = await q(
    `SELECT row_to_json(w) FROM (SELECT organization_id FROM workflows WHERE id = $1) w;`,
    [wfId]
  ).catch(() => null);
  const wfOrgId = wfRow && wfRow.organization_id ? parseInt(wfRow.organization_id, 10) : null;
  if (Number.isSafeInteger(wfOrgId) && wfOrgId > 0) {
    return { wfId, wfOrgId, bridged: false };
  }
  const bridgeOrgId = parseInt(process.env.VAANI_INGESTION_ORG_ID || '', 10);
  if (!Number.isSafeInteger(bridgeOrgId) || bridgeOrgId <= 0) return null;
  const bridgedId = await resolveOrgWorkflowId(bridgeOrgId, q).catch(() => null);
  return bridgedId ? { wfId: bridgedId, wfOrgId: bridgeOrgId, bridged: true } : null;
}

// Intended Vaani workflow. Workflow 3 is the Org 1 Vaani sales agent. The
// environment override exists so a future deployment can move the agent
// without editing code, but the default is the verified Org 1 workflow.
function preferredWorkflowId() {
  const raw = process.env.VAANI_WORKFLOW_ID || process.env.DOGRAH_WORKFLOW_ID || '3';
  const parsed = parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

// Resolve a workflow that belongs to the authenticated organization. The
// preferred Vaani workflow wins only when it is active and owned by that org.
// Otherwise fall back to the organization's first active workflow. Never
// return a workflow from another organization.
async function resolveOrgWorkflowId(orgId, queryFn) {
  const orgInt = parseInt(orgId, 10);
  if (!Number.isSafeInteger(orgInt) || orgInt <= 0) return null;
  const q = queryFn || queryPostgres;
  const preferred = preferredWorkflowId();
  if (preferred) {
    const row = await q(
      `SELECT id FROM workflows WHERE id = $1 AND organization_id = $2 AND status = 'active' LIMIT 1;`,
      [preferred, orgInt]
    ).catch(() => null);
    const preferredId = parseInt(firstScalarId(row), 10);
    if (Number.isSafeInteger(preferredId) && preferredId > 0) return preferredId;
  }
  const fallback = await q(
    `SELECT id FROM workflows WHERE organization_id = $1 AND status = 'active' ORDER BY id LIMIT 1;`,
    [orgInt]
  ).catch(() => null);
  const fallbackId = parseInt(firstScalarId(fallback), 10);
  return Number.isSafeInteger(fallbackId) && fallbackId > 0 ? fallbackId : null;
}

async function addLead(orgId, type, data) {
  // Budget/price validation lives in buildManualLeadInsert (single source).
  // The workflow carrying a manual lead is the intended Vaani workflow when
  // it belongs to the authenticated organization, otherwise that org's first
  // active workflow. Never hardcoded: workflow 3 belongs to Org 1.
  const orgInt = parseInt(orgId, 10);
  if (isNaN(orgInt) || orgInt <= 0) throw new Error('Organization not linked');
  const wfInt = await resolveOrgWorkflowId(orgInt);
  if (!wfInt) {
    throw new Error('Invalid organization setup: no active calling workflow is configured for this organization');
  }
  // Duplicate guard scoped to the authenticated organization so one org's
  // numbers can never block or leak into another org.
  if (data.phone) {
    const checkSql = `
      SELECT r.id FROM workflow_runs r JOIN workflows w ON r.workflow_id = w.id
      WHERE w.organization_id = $1
        AND ((r.gathered_context->'extracted_variables'->>'callback_number') = $2
          OR (r.gathered_context->'extracted_variables'->>'primary_phone') = $2)
      LIMIT 1
    `;
    const exists = await queryPostgres(checkSql, [orgInt, data.phone]);
    const duplicateFound = Array.isArray(exists)
      ? exists.length > 0
      : (exists !== null && exists !== undefined && String(exists).trim() !== '');
    if (duplicateFound) {
      throw new Error('Duplicate phone number');
    }
  }

  const { sql, params } = buildManualLeadInsert(type, data, orgInt, wfInt);
  const out = await queryPostgres(sql, params);
  if (Array.isArray(out) && out.length) {
    const row = out[0];
    if (row && typeof row === 'object' && row.id != null) return row.id;
    const parsed = parseInt(row, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (out && typeof out === 'object' && out.id != null) return out.id;
  const parsed = parseInt(out, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Build the Dograh public-embed init body. Pure and byte-identical to what
// mintDograhVoiceSession sends: token plus stringified context variables with
// CRM variables merged last. No network, no secrets handling here.
function buildDograhEmbedBody(token, context) {
  const ctx = context || {};
  return { token, context_variables: {
    source: String(ctx.source || 'rumik_studio'),
    tenant_id: String(ctx.tenantId || ''),
    agent_id: String(ctx.agentId || ''),
    demo_link_id: String(ctx.demoLinkId || ''),
    max_session_seconds: String(ctx.maxSessionSeconds || ''),
    ...((ctx.crmVariables) || {})
  } };
}

// Parse a human-entered budget/price into integer rupees without ever
// fabricating zero: Indian comma grouping (18,00,000), currency symbols and
// unit suffixes (Lakh/L, Crore/Cr, Thousand) are understood, mirroring the
// multipliers in vaani-extractor parseSpokenPrice. Empty input yields null
// (unknown, displayed as unavailable); unparseable non-empty input is
// invalid (ok:false) so callers reject it instead of storing a wrong number.
// An explicit 0 is preserved as 0.
function parseBudgetInr(raw) {
  if (raw === null || raw === undefined) return { value: null, ok: true };
  let s = String(raw).trim();
  if (!s) return { value: null, ok: true };
  s = s.replace(/[\u20B9,\s]/g, '');
  const m = s.match(/^(-?\d+(?:\.\d+)?)(crore|cr|lakh|lakhs|lac|lacs|l|\u0932\u093E\u0916|\u0939\u091C\u093E\u0930|thousand)$/i);
  let num;
  if (m) {
    const unit = m[2].toLowerCase();
    const mult = (unit === 'crore' || unit === 'cr') ? 10000000
      : (unit === '\u0939\u091C\u093E\u0930' || unit === 'thousand') ? 1000 : 100000;
    num = parseFloat(m[1]) * mult;
  } else if (/^-?\d+(?:\.\d+)?$/.test(s)) {
    num = parseFloat(s);
  } else {
    return { value: null, ok: false };
  }
  if (!Number.isFinite(num) || num < 0) return { value: null, ok: false };
  return { value: Math.round(num), ok: true };
}

// Build the manual-lead INSERT without an explicit id so PostgreSQL uses
// workflow_runs_id_seq. workflow_runs.id is integer and Date.now() scale ids
// overflow int4 (integer out of range), which failed every manual save.
// Tenant scoping of workflow_id is handled separately; wfId is unchanged here.
// Coerce an optional integer field: real integers pass through, everything
// else stays null (unknown) instead of becoming a fabricated zero.
function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function normalizeLeadTemperature(v) {
  const t = String(v || '').toUpperCase();
  return ['HOT', 'WARM', 'COLD'].includes(t) ? t : 'WARM';
}

function normalizeApplicationHistory(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('rock') || s.includes('quarry')) return 'rock_breaker';
  if (s.includes('soil') || s.includes('earth')) return 'soil_earthwork';
  if (s.includes('mixed')) return 'mixed';
  return 'unknown';
}

function normalizeOwnershipType(v) {
  const s = String(v || '').toLowerCase();
  return s.includes('broker') || s.includes('munim') ? 'broker' : 'owner';
}

// VAANI-001: explicit, validated buyer/seller classification. Order:
// payload.customer_type > extracted_variables.buyer_seller_classification >
// extracted_variables.intent. Ambiguous or unrecognized values resolve to
// 'unknown', never a fabricated buyer or seller.
function normalizeCustomerType(val) {
  if (!val) return null;
  const v = String(val).toLowerCase().trim();
  if (v === 'buyer' || v === 'purchase' || v === 'buy' || v === 'buying') return 'buyer';
  if (v === 'seller' || v === 'sell' || v === 'selling') return 'seller';
  if (v === 'not_interested' || v === 'other' || v === 'dnc') return 'other';
  return null;
}

function resolveCustomerType(payload) {
  const src = payload || {};
  const extVars = src.extracted_variables || src.raw_extracted_variables || {};
  const sources = [src.customer_type, extVars.buyer_seller_classification, extVars.intent];
  for (const rawVal of sources) {
    const normalized = normalizeCustomerType(rawVal);
    if (normalized) return normalized;
  }
  return 'unknown';
}

// Explicit buy/sell wording in the caller's own turns is the strongest signal:
// it survives cut calls and LLM/provider outages. The latest explicit phrase
// wins, so a correction overrides an earlier one. Assistant turns are ignored
// because the greeting itself asks "sale karni hai ya purchase karni hai?".
function detectCustomerTypeFromTranscript(input) {
  const customerText = normalizeTranscriptSegments(input)
    .filter((s) => /customer|user|caller/i.test(s.speaker || ''))
    .map((s) => s.message)
    .join('\n')
    .toLowerCase();
  if (!customerText) return null;

  const hits = [];
  const collect = (type, re) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(customerText)) !== null) {
      hits.push({ type, index: match.index });
    }
  };
  collect('seller', /\bbech\w*|\bsell(?:ing)?\b|\bseller\b|\bsale\s+(?:karn\w*|krn\w*)\b|बेच/g);
  collect('buyer', /\bkharid\w*|\bkhareed\w*|\bkhreed\w*|\bkarid\w*|\bbuy(?:ing)?\b|\bbuyer\b|\bpurchas\w*|खरीद/g);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.index - b.index);
  return hits[hits.length - 1].type;
}

function buildManualLeadInsert(type, data, orgId, wfId) {
  const budgetParsed = parseBudgetInr(data.budget);
  if (!budgetParsed.ok) throw new Error('Invalid budget: enter digits with optional Lakh/Crore, e.g. 1800000 or 18 Lakh');
  const expectedParsed = parseBudgetInr(data.expected_price);
  if (!expectedParsed.ok) throw new Error('Invalid expected price: enter digits with optional Lakh/Crore');
  const budgetMinParsed = parseBudgetInr(data.budget_min);
  if (!budgetMinParsed.ok) throw new Error('Invalid budget_min: enter digits with optional Lakh/Crore');
  // Manual leads belong to the authenticated organization on its own
  // workflow. Never a default workflow: workflow 3 belongs to org 1.
  const orgInt = parseInt(orgId, 10);
  if (isNaN(orgInt) || orgInt <= 0) throw new Error('Organization not linked');
  const wfInt = parseInt(wfId, 10);
  if (isNaN(wfInt) || wfInt <= 0) throw new Error('Invalid workflow: a caller-owned workflow id is required');
  let parsedBrand = data.brand || '';
  let parsedModel = data.model || '';
  if (data.machine) {
    const parts = String(data.machine).split(' ');
    parsedBrand = parts[0] || '';
    parsedModel = parts.slice(1).join(' ') || '';
  }
  const name = `vaani-manual-${Date.now()}`;
  const extractedVariables = {
    customer_type: type,
    caller_name: data.name || '',
    callback_number: data.phone || '',
    whatsapp_number: data.whatsapp || '',
    address: data.address || '',
    ownership_type: normalizeOwnershipType(data.ownership || data.ownership_type),
    application_history: normalizeApplicationHistory(data.application || data.application_history),
    lead_temperature: normalizeLeadTemperature(data.temperature),
    qualification_state: data.qualification_state || 'IN_PROGRESS',
    next_action: data.next_action || 'Manually added',
    lead_status: data.lead_status || null,
    availability_status: data.availability_status || null,
    commercial_terms: {
      budget_max_inr: budgetParsed.value,
      budget_min_inr: budgetMinParsed.value,
      finance_required: normalizeFinanceRequired(data.finance_required),
      payment_mode: normalizePaymentMode(data.payment_mode),
      expected_price_inr: expectedParsed.value,
      purchase_timeline: data.purchase_timeline || data.timeline || ''
    },
    machine_details: {
      brand: parsedBrand,
      model: parsedModel,
      machine_type: data.machine_type || null,
      model_year: toIntOrNull(data.year),
      model_year_min: toIntOrNull(data.year_min),
      model_year_max: toIntOrNull(data.year_max),
      running_hours: toIntOrNull(data.hours),
      max_hours: toIntOrNull(data.max_hours),
      location_city: data.location || '',
      location_state: data.state || '',
      preferred_city: data.preferred_city || null,
      condition: data.condition || null,
      application_history: normalizeApplicationHistory(data.application || data.application_history),
      new_or_used: normalizeNewOrUsed(data.new_or_used)
    },
    tonnage_class: data.requirement || '',
    call_notes: data.notes || ''
  };
  const sql = `
    INSERT INTO workflow_runs (
      name, workflow_id, mode, created_at, is_completed, usage_info, cost_info,
      initial_context, gathered_context, annotations, logs, storage_backend, state, call_type, extra
    ) VALUES (
      $1, $2, 'manual', CURRENT_TIMESTAMP, true, '{}'::json, '{}'::json, '{}'::json,
      json_build_object(
        'extracted_variables', $3::jsonb
      )::json,
      '{}'::json, '{}'::json, 's3', 'completed', 'inbound', '{}'::json
    ) RETURNING id
  `;
  return { sql, params: [name, wfInt, extractedVariables] };
}

// Map a Dograh voice-session failure to a safe HTTP response. Network-level
// failures (service down/unreachable) get an actionable message; anything
// else keeps the upstream message. Never claims a call succeeded.
function mapVoiceSessionError(err) {
  const msg = String((err && err.message) || 'unknown error');
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EAI_AGAIN|timed out|timeout/i.test(msg)) {
    return { status: 502, body: { error: 'Dograh voice service is unreachable. Start the Dograh API service and try again.', code: 'dograh_unreachable', telephony_missing: msg.slice(0, 120) } };
  }
  return { status: 502, body: { error: `Dograh voice session failed: ${msg}`, code: 'voice_session_failed', telephony_missing: msg.slice(0, 120) } };
}

// Map a lead-save failure to a safe HTTP response. Known validation errors
// keep their message; anything else becomes a generic message so database
// internals are never leaked to the client.
function mapLeadSaveError(err, fallbackMessage) {
  if (err && typeof err.message === 'string' && err.message.indexOf('Invalid ') === 0) {
    return { status: 400, body: { error: err.message, code: 'validation_error' } };
  }
  if (err && err.message === 'Duplicate phone number') {
    return { status: 409, body: { error: 'Duplicate phone number', code: 'duplicate_phone' } };
  }
  if (err && err.message === 'Duplicate machine record') {
    return { status: 409, body: { error: 'Duplicate machine record', code: 'duplicate_machine' } };
  }
  return { status: 500, body: { error: fallbackMessage || 'Could not save lead. Please try again.', code: 'lead_save_failed' } };
}

async function addMachineRecord(orgId, data) {
  // Naive duplicate check by brand, model, and year
  if (data.brand && data.model) {
    const checkSql = `
      SELECT machine_id FROM vaani_machines
      WHERE organization_id = $4 AND brand = $1 AND model = $2 AND (manufacturing_year = $3 OR $3 IS NULL)
      LIMIT 1
    `;
    const exists = await queryPostgres(checkSql, [data.brand, data.model, data.year ? parseInt(data.year, 10) : null, orgId]);
    const duplicateFound = Array.isArray(exists)
      ? exists.length > 0
      : (exists !== null && exists !== undefined && String(exists).trim() !== '');
    if (duplicateFound) {
      throw new Error('Duplicate machine record');
    }
  }

  let sourceLeadRunId = null;
  const sellerPhone = pickSellerPhone(data);
  if (sellerPhone) {
    const linkSql = `
      SELECT r.id FROM public.workflow_runs r
      JOIN public.workflows w ON w.id = r.workflow_id
      WHERE w.organization_id = $1
        AND ((r.gathered_context -> 'extracted_variables' ->> 'callback_number') = $2
          OR (r.gathered_context -> 'extracted_variables' ->> 'primary_phone') = $2)
      ORDER BY r.id DESC LIMIT 1
    `;
    const linked = await queryPostgres(linkSql, [orgId, sellerPhone]);
    const firstRow = Array.isArray(linked) ? linked[0] : linked;
    const candidate = firstRow && typeof firstRow === 'object' ? firstRow.id : firstRow;
    const parsedLink = parseInt(candidate, 10);
    if (Number.isFinite(parsedLink)) sourceLeadRunId = parsedLink;
  }
  const { sql, params } = buildManualMachineInsert(orgId, data, sourceLeadRunId);
  await queryPostgres(sql, params);
  return params[1];
}

// Normalize the seller phone from either the core field (seller_phone) or the
// import-mapping field (seller). Trimmed string, '' when absent.
function pickSellerPhone(data) {
  return String((data && (data.seller_phone || data.seller)) || '').trim();
}

// Build the manual-machine INSERT. The entered price is stored in both
// sourcing_cost_inr and target_resale_inr: the inventory UI reads
// target_resale_inr, so writing only sourcing_cost_inr left every manual
// machine showing Not available after a successful save.
function buildManualMachineInsert(orgId, data, sourceLeadRunId) {
  const priceParsed = parseBudgetInr(data.price);
  if (!priceParsed.ok) throw new Error('Invalid price: enter digits with optional Lakh/Crore');
  const price = priceParsed.value;
  const linkId = Number.isFinite(parseInt(sourceLeadRunId, 10)) ? parseInt(sourceLeadRunId, 10) : null;
  const machineId = `mach_manual_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const sql = `
    INSERT INTO vaani_machines (
      organization_id, machine_id, source_lead_run_id, brand, model, manufacturing_year,
      hour_meter_reading, application_history, sourcing_cost_inr, target_resale_inr, status, current_location, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP
    )
  `;
  return { sql, params: [
    orgId,
    machineId,
    linkId,
    data.brand || 'Unknown',
    data.model || '',
    toIntOrNull(data.year),
    toIntOrNull(data.hours),
    normalizeApplicationHistory(data.application || data.application_history),
    price,
    price,
    data.status || 'in_sourcing_pipeline',
    data.location || ''
  ] };
}

async function importBuyers(orgId, rows) {
  let success = 0; let failed = 0; let skipped = 0;
  for (const row of rows) {
    if (!row.name || !row.phone) { failed++; continue; }
    try {
      await addLead(orgId, 'buyer', row);
      success++;
    } catch (e) {
      console.error(e);
      failed++;
    }
  }
  return { success, failed, skipped };
}

async function importSellers(orgId, rows) {
  let success = 0; let failed = 0; let skipped = 0;
  for (const row of rows) {
    if (!row.name || !row.phone) { failed++; continue; }
    try {
      await addLead(orgId, 'seller', row);
      success++;
    } catch (e) {
      console.error(e);
      failed++;
    }
  }
  return { success, failed, skipped };
}

async function importMachines(orgId, rows) {
  let success = 0; let failed = 0; let skipped = 0;
  for (const row of rows) {
    if (!row.brand) { failed++; continue; }
    try {
      await addMachineRecord(orgId, row);
      success++;
    } catch (e) {
      console.error(e);
      failed++;
    }
  }
  return { success, failed, skipped };
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
  getOwnerDigest,
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
  vaaniExtractor,
  extractFromConversation: extractFromConversationLLM,
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
  buildInternalMachinesQuery,
  classifyMediaEvidence: vaaniWhatsapp.classifyMediaEvidence,
  runIntelligentMatching
,
  evaluateBuyerMatches,
  evaluateMachineBuyers,
  matchTypeToStatus,
  isReviewRequired,
  derivePipelineStage,
  BUYER_PIPELINE_STAGES,
  SELLER_PIPELINE_STAGES,
  buildSalesPipeline,
  getSalesPipeline,
  buildMatchRequirement,
  canonicalMatchModel,
  normMatchToken,
  formatLakhINR,
  preferredWorkflowId,
  resolveOrgWorkflowId,
  resolveIngestionWorkflow,
  addLead,
  buildManualLeadInsert,
  buildManualMachineInsert,
  normalizeLeadTemperature,
  normalizeApplicationHistory,
  normalizeOwnershipType,
  resolveCustomerType,
  detectCustomerTypeFromTranscript,
  mapLeadSaveError,
  mapVoiceSessionError,
  parseBudgetInr,
  toIntOrNull,
  mergeExtractedVariables,
  resolveArtifactUrl,
  verifyArtifactUrl,
  evaluateCallCompletionEvidence,
  applyCallCompletionStatus,
  CALL_COMPLETION_BLOCKING_OUTCOMES,
  CALL_TERMINAL_STATUSES,
  normalizeTranscriptSegments,
  extractNewStructuredFields,
  persistIngestCallCapture,
  mergeGatheredContextPreserving,
  applyDeterministicBackstop,
  filterSellerConcernCandidates,
  resolveRunOwnerOrg,
  attachCallTranscripts,
  attachCallSummaries,
  flattenEvRequirement,
  buildTerminalCallSummary,
  summarizeTerminalCall,
  upsertTerminalCallSummary,
  evaluateQualificationCompleteness,
  resolveQualificationFields,
  buildSalesBrain,
  normalizeNewOrUsed,
  normalizePaymentMode,
  normalizeFinanceRequired,
  buildFollowUpRecommendation,
  evaluateFollowUp,
  detectObjections,
  updateObjectionStatus,
  detectLeadObjections,
  buildBuyer360Snapshot,
  extractNewStructuredFields,
  persistIngestCallCapture,
  projectStructuredBuyerFields,
  projectStructuredSellerFields,
  pickSellerPhone,
  buildDograhEmbedBody,
  addMachineRecord,
  importBuyers,
  importSellers,
  importMachines
};
