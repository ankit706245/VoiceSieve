import re

with open('dashboard/lib/vaani-sales.js', 'r') as f:
    content = f.read()

# 1. Define evaluateBuyerMatches
new_logic = """
function evaluateBuyerMatches(buyer, stock) {
  const results = [];
  const targetBrand = buyer.machine_brand;
  const targetModel = buyer.machine_model;
  const budgetMax = parseInt(buyer.buyer_budget_max_inr || buyer.budget_max_inr, 10) || null;
  const yearMin = parseInt(buyer.model_year_min, 10) || null;
  const yearMax = parseInt(buyer.model_year_max, 10) || null;
  const hoursMax = parseInt(buyer.running_hours_max, 10) || null;

  for (const machine of stock) {
    if (['sold', 'reserved'].includes(machine.status)) continue;
    
    let isExact = true;
    let isAlternative = false;
    const evidence = {};
    let isMatch = true;

    // Brand & Model
    if (targetBrand && targetBrand !== 'Any') {
      if (machine.brand === targetBrand) {
        evidence.brand = 'canonical brand matched';
        if (targetModel) {
          if (machine.model === targetModel) {
            evidence.model = 'canonical model matched';
          } else {
            // Alternative model for same brand (simple fallback)
            evidence.model = 'brand matched, alternative model';
            isExact = false;
            isAlternative = true;
          }
        }
      } else {
        isMatch = false; // Brand mismatch
      }
    } else if (targetModel) {
      if (machine.model === targetModel) {
        evidence.model = 'canonical model matched';
      } else {
        isMatch = false;
      }
    }

    if (!isMatch) {
      // Check if it's a completely different brand but same tonnage, business logic says ALTERNATIVE_MATCH?
      // According to contract: "Do NOT invent arbitrary substitutions. Hyundai != JCB unless defined."
      // Since it's not defined here, we keep NO_MATCH.
      continue;
    }

    // Budget
    if (budgetMax) {
      if (machine.target_resale_inr <= budgetMax) {
        evidence.budget = 'price satisfies budget';
      } else if (machine.target_resale_inr <= budgetMax * 1.1) {
        evidence.budget = 'price within 10% alternative budget';
        isExact = false;
        isAlternative = true;
      } else {
        continue;
      }
    } else {
      evidence.budget = 'UNKNOWN / REQUIRES_VERIFICATION';
    }

    // Year
    if (yearMin || yearMax) {
      const mYear = parseInt(machine.manufacturing_year, 10);
      if (mYear) {
        const yMin = yearMin || 2000;
        const yMax = yearMax || 2050;
        if (mYear >= yMin && mYear <= yMax) {
          evidence.year = 'year satisfies requirement';
        } else if (mYear >= yMin - 1 && mYear <= yMax + 1) {
          evidence.year = 'year within +/- 1 tolerance';
          isExact = false;
          isAlternative = true;
        } else {
          continue;
        }
      } else {
         evidence.year = 'UNKNOWN / REQUIRES_VERIFICATION';
      }
    }

    // Hours
    if (hoursMax) {
      const mHours = parseInt(machine.hour_meter_reading, 10);
      if (mHours) {
        if (mHours <= hoursMax) {
           evidence.hours = 'hours satisfy requirement';
        } else {
           continue;
        }
      } else {
         evidence.hours = 'UNKNOWN / REQUIRES_VERIFICATION';
      }
    } else {
       evidence.hours = 'UNKNOWN / REQUIRES_VERIFICATION';
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

    // Format output without sensitive fields
    const safeMachine = {
      machine_id: machine.machine_id,
      brand: machine.brand,
      model: machine.model,
      manufacturing_year: machine.manufacturing_year,
      hour_meter_reading: machine.hour_meter_reading,
      application_history: machine.application_history,
      status: machine.status,
      current_location: machine.current_location,
      organization_id: machine.organization_id
    };

    results.push({
      match_type: isExact ? 'EXACT_MATCH' : 'ALTERNATIVE_MATCH',
      machine_id: machine.machine_id,
      machine: safeMachine,
      evidence: evidence
    });
  }
  
  // Sort priority: active first, then EXACT, then ALTERNATIVE
  results.sort((a, b) => {
    if (a.match_type === 'EXACT_MATCH' && b.match_type !== 'EXACT_MATCH') return -1;
    if (b.match_type === 'EXACT_MATCH' && a.match_type !== 'EXACT_MATCH') return 1;
    return 0;
  });

  return results;
}

async function runIntelligentMatching(organizationId, buyerRunId, buyerRequirement) {
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) throw new Error("Invalid organization ID");

  // Load active inventory WITH target_resale_inr (internal use only)
  let stock = [];
  try {
      const sql = `
        SELECT machine_id, brand, model, manufacturing_year, hour_meter_reading,
               application_history, target_resale_inr, status, current_location, organization_id
        FROM vaani_machines
        WHERE organization_id = $1 AND status IN ('in_sourcing_pipeline', 'certified_ready_in_yard')
      `;
      stock = await queryPostgres(sql, [orgInt]) || [];
  } catch (err) {
      console.error('[VAANI SALES] Error fetching stock for matching:', err);
  }

  // Evaluate
  const matches = evaluateBuyerMatches(buyerRequirement, stock);
  
  if (matches.length > 0) {
    // Persist matches
    for (const m of matches) {
      const insertSql = `
        INSERT INTO vaani_buyer_machine_matches 
        (organization_id, buyer_run_id, inventory_machine_id, match_type, evidence_json)
        VALUES ($1, $2, $3, $4, $5)
      `;
      await queryPostgres(insertSql, [orgInt, parseInt(buyerRunId, 10), m.machine_id, m.match_type, JSON.stringify(m.evidence)]).catch(e => {
        console.error("Error inserting match:", e.message);
      });
    }
  }

  return matches;
}
"""

if "function evaluateBuyerMatches" not in content:
    content = content.replace("function loadDemoData() {", new_logic + "\nfunction loadDemoData() {")

# Patch getDemand Demo
demo_match = """    // Matching real buyers with real/demo stock
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
    });"""

demo_replacement = """    // Intelligent Matching
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
    });"""

content = content.replace(demo_match, demo_replacement)

# Patch getDemand PG
pg_match = """    const matches = buyers.map((b) => {
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
    });"""

pg_replacement = """    const matches = buyers.map((b) => {
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
    });"""
content = content.replace(pg_match, pg_replacement)

if "runIntelligentMatching" not in content[-300:]:
    content = content.replace("classifyMediaEvidence: vaaniWhatsapp.classifyMediaEvidence\n};", "classifyMediaEvidence: vaaniWhatsapp.classifyMediaEvidence,\n  runIntelligentMatching\n};")

with open('dashboard/lib/vaani-sales.js', 'w') as f:
    f.write(content)