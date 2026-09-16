/**
 * Vaani — Follow-up & Sales Automation Engine
 * Phase F — Step 3 Implementation
 * Grounded in VAANI-SALES-DATA-CONTRACT.md and SELLER-BUYER-SCHEMAS.md
 */

let vaaniSales = null;
function getVaaniSales() {
  if (!vaaniSales) vaaniSales = require('./vaani-sales');
  return vaaniSales;
}

function queryPostgres(...args) {
  return getVaaniSales().queryPostgres(...args);
}

function sqlEscapeString(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function sqlEscapeInt(val) {
  if (val === null || val === undefined) return 'NULL';
  const i = parseInt(val, 10);
  return isNaN(i) ? 'NULL' : String(i);
}

function sqlEscapeJson(val) {
  if (val === null || val === undefined) return "'{}'::jsonb";
  return "'" + JSON.stringify(val).replace(/'/g, "''") + "'::jsonb";
}

const TASK_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  DUE: 'DUE',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED'
});

const TASK_PRIORITIES = Object.freeze({
  URGENT: 'URGENT',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

const TASK_TYPES = Object.freeze({
  CALL_BACK: 'CALL_BACK',
  REQUEST_PHOTOS: 'REQUEST_PHOTOS',
  REQUEST_METER_PHOTO: 'REQUEST_METER_PHOTO',
  REQUEST_RUNNING_VIDEO: 'REQUEST_RUNNING_VIDEO',
  REQUEST_RC: 'REQUEST_RC',
  REQUEST_NOC: 'REQUEST_NOC',
  VERIFY_MACHINE: 'VERIFY_MACHINE',
  MATCH_BUYER: 'MATCH_BUYER',
  FOLLOW_UP_BUYER: 'FOLLOW_UP_BUYER',
  PRICE_NEGOTIATION: 'PRICE_NEGOTIATION',
  SCHEDULE_INSPECTION: 'SCHEDULE_INSPECTION',
  YARD_VISIT: 'YARD_VISIT',
  NEGOTIATION_FOLLOW_UP: 'NEGOTIATION_FOLLOW_UP'
});

const VALID_TRANSITIONS = {
  [TASK_STATUSES.PENDING]: [TASK_STATUSES.DUE, TASK_STATUSES.IN_PROGRESS, TASK_STATUSES.COMPLETED, TASK_STATUSES.SKIPPED, TASK_STATUSES.CANCELLED],
  [TASK_STATUSES.DUE]: [TASK_STATUSES.IN_PROGRESS, TASK_STATUSES.COMPLETED, TASK_STATUSES.SKIPPED, TASK_STATUSES.CANCELLED],
  [TASK_STATUSES.IN_PROGRESS]: [TASK_STATUSES.COMPLETED, TASK_STATUSES.SKIPPED, TASK_STATUSES.CANCELLED],
  [TASK_STATUSES.COMPLETED]: [],
  [TASK_STATUSES.SKIPPED]: [],
  [TASK_STATUSES.CANCELLED]: []
};

/**
 * Deterministic Priority Engine
 */
function determineTaskPriority(customerType, qualState, leadTemp, commTerms = {}, evReadiness = {}, taskType) {
  const isImmediate = commTerms.purchase_timeline === 'immediate_within_7_days' ||
                      commTerms.purchase_timeline === 'immediate' ||
                      commTerms.purchase_timeline === 'urgent';
  if (leadTemp === 'HOT' && (isImmediate || taskType === TASK_TYPES.YARD_VISIT)) {
    return TASK_PRIORITIES.URGENT;
  }
  if (leadTemp === 'HOT' || (customerType === 'seller' && qualState === 'QUALIFIED' && (taskType === TASK_TYPES.REQUEST_PHOTOS || taskType === TASK_TYPES.VERIFY_MACHINE))) {
    return TASK_PRIORITIES.HIGH;
  }
  if (leadTemp === 'WARM' || taskType === TASK_TYPES.PRICE_NEGOTIATION || taskType === TASK_TYPES.NEGOTIATION_FOLLOW_UP) {
    return TASK_PRIORITIES.MEDIUM;
  }
  return TASK_PRIORITIES.LOW;
}

/**
 * Deterministic Timing Engine
 */
function determineTaskDueAt(taskType, followUpDatetime, commTerms = {}) {
  if (followUpDatetime) {
    const parsed = new Date(followUpDatetime);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const now = Date.now();
  const isImmediate = commTerms.purchase_timeline === 'immediate_within_7_days' ||
                      commTerms.purchase_timeline === 'immediate' ||
                      commTerms.purchase_timeline === 'urgent';
  switch (taskType) {
    case TASK_TYPES.YARD_VISIT:
      return new Date(now + 24 * 3600 * 1000).toISOString();
    case TASK_TYPES.REQUEST_PHOTOS:
    case TASK_TYPES.REQUEST_METER_PHOTO:
    case TASK_TYPES.REQUEST_RUNNING_VIDEO:
    case TASK_TYPES.REQUEST_RC:
    case TASK_TYPES.REQUEST_NOC:
      return new Date(now + 24 * 3600 * 1000).toISOString(); // 1 day
    case TASK_TYPES.MATCH_BUYER:
    case TASK_TYPES.FOLLOW_UP_BUYER:
      if (isImmediate) {
        return new Date(now + 4 * 3600 * 1000).toISOString(); // 4 hours
      }
      return new Date(now + 48 * 3600 * 1000).toISOString(); // 2 days
    case TASK_TYPES.CALL_BACK:
      return new Date(now + 2 * 3600 * 1000).toISOString(); // 2 hours
    default:
      return new Date(now + 24 * 3600 * 1000).toISOString();
  }
}

/**
 * Builds candidate tasks for a completed call.
 */
function buildCandidateTasks(context) {
  const {
    organization_id, lead_id, customer_id, customer_type, qual_state, lead_temp,
    next_action, mach_details = {}, comm_terms = {}, ev_readiness = {}, dnc_requested,
    follow_up_datetime, run_id, caller_name, primary_phone
  } = context;

  // DNC must NEVER create a follow-up task
  if (dnc_requested || qual_state === 'DISQUALIFIED') {
    return [];
  }

  const candidates = [];

  if (customer_type === 'seller') {
    // Evidence tasks
    if (!ev_readiness.photos_agreed) {
      candidates.push({
        task_type: TASK_TYPES.REQUEST_PHOTOS,
        title: `Request 4-Angle Machine Photos: ${mach_details.brand || ''} ${mach_details.model || 'Excavator'}`,
        description: `Caller agreed to sell. Collect boom, undercarriage, cabin, and exterior photos on WhatsApp.`,
        assigned_to: 'Vikram (Procurement Lead)',
        reason: 'Missing exterior/component photos for technical valuation'
      });
    }

    if (!ev_readiness.running_video_agreed) {
      candidates.push({
        task_type: TASK_TYPES.REQUEST_RUNNING_VIDEO,
        title: `Request 30s Operational Running Video: ${mach_details.model || 'Excavator'}`,
        description: `Request 30-second running video showing engine idle, hydraulic swing, and exhaust smoke.`,
        assigned_to: 'Vikram (Procurement Lead)',
        reason: 'Running video required to assess pump pressure and engine health'
      });
    }

    if (!ev_readiness.rc_copy_agreed && mach_details.document_status !== 'all_clear_noc_ready') {
      candidates.push({
        task_type: TASK_TYPES.REQUEST_RC,
        title: `Verify Registration Certificate (RC) & NOC Clearance`,
        description: `Collect RC copy and check RTO finance hypothecation status.`,
        assigned_to: 'Legal / Procurement Desk',
        reason: 'Legal and RTO clearance pending'
      });
    }

    if (ev_readiness.photos_agreed && ev_readiness.running_video_agreed && qual_state === 'QUALIFIED') {
      candidates.push({
        task_type: TASK_TYPES.VERIFY_MACHINE,
        title: `Technical Machine Verification: ${mach_details.brand || ''} ${mach_details.model || ''}`,
        description: `Evidence received. Dispatch engineering evaluator or conduct 50-point video inspection.`,
        assigned_to: 'Yard Technical Evaluator',
        reason: 'Ready for technical evaluation and yard inspection recommendation'
      });
    }

    if (next_action === 'NEGOTIATION_FOLLOW_UP' || (comm_terms.expected_price_inr && comm_terms.expected_price_inr > 2400000 && mach_details.model_year && mach_details.model_year <= 2019)) {
      candidates.push({
        task_type: TASK_TYPES.NEGOTIATION_FOLLOW_UP,
        title: `Price Negotiation: ${comm_terms.price_or_budget_raw || 'Expected Price'} (Seller)`,
        description: `Seller expected price above market benchmark. Align on inspection margin discount.`,
        assigned_to: 'Senior Procurement Officer',
        reason: 'High asking price negotiation'
      });
    }
  } else if (customer_type === 'buyer') {
    if (comm_terms.yard_visit_agreed) {
      candidates.push({
        task_type: TASK_TYPES.YARD_VISIT,
        title: `Jaipur Yard Physical Inspection Visit: ${caller_name || 'Buyer'}`,
        description: `Buyer agreed to physical trial at Jaipur Loha Mandi yard. Prepare gate pass and arrange live load test.`,
        assigned_to: 'Devendra (Jaipur Yard Manager)',
        reason: 'Yard inspection appointment agreed'
      });
    }

    if (qual_state === 'QUALIFIED') {
      candidates.push({
        task_type: TASK_TYPES.MATCH_BUYER,
        title: `Match Buyer Demand: ${mach_details.brand || ''} ${mach_details.tonnage_class || '20-Ton'} (Budget ${comm_terms.price_or_budget_raw || 'Disclosed'})`,
        description: `Match buyer demand with verified available stock in Jaipur yard or sourcing pipeline.`,
        assigned_to: 'Sales Matchmaker',
        reason: 'Qualified buyer requirement ready for stock matching'
      });
    } else if (qual_state === 'PARTIALLY_QUALIFIED') {
      candidates.push({
        task_type: TASK_TYPES.FOLLOW_UP_BUYER,
        title: `Follow Up on Machine Options & Budget`,
        description: `Share PDF inventory catalog and follow up to discover missing budget or delivery timeline.`,
        assigned_to: 'Sales Representative',
        reason: 'Partially qualified buyer inquiry'
      });
    }
  }

  // Format candidate tasks with priority, timing, and unique deduplication keys
  return candidates.map(c => {
    const priority = determineTaskPriority(customer_type, qual_state, lead_temp, comm_terms, ev_readiness, c.task_type);
    const dueAt = determineTaskDueAt(c.task_type, follow_up_datetime, comm_terms);
    const taskId = `task_${organization_id}_${run_id}_${c.task_type.toLowerCase()}`;

    return {
      task_id: taskId,
      organization_id: organization_id,
      lead_id: String(lead_id),
      customer_id: customer_id || primary_phone || String(lead_id),
      task_type: c.task_type,
      title: c.title,
      description: c.description,
      priority: priority,
      status: TASK_STATUSES.PENDING,
      assigned_to: c.assigned_to,
      due_at: dueAt,
      source_call_id: run_id,
      reason: c.reason,
      metadata: {
        customer_type,
        customer_name: caller_name,
        primary_phone,
        lead_temperature: lead_temp,
        qualification_state: qual_state,
        machine_model: mach_details.model || mach_details.brand || null,
        price_raw: comm_terms.price_or_budget_raw || null
      }
    };
  });
}

/**
 * Creates deduplicated follow-up tasks in PostgreSQL.
 * Deduplication rule: If an active/open task (PENDING, DUE, IN_PROGRESS)
 * of the same task_type already exists for this lead and organization, skip it!
 */
async function processCallFollowUpTasks(context) {
  const candidates = buildCandidateTasks(context);
  if (candidates.length === 0) return [];

  const createdTasks = [];

  for (const t of candidates) {
    // Check if open task already exists
    const checkSql = `
      SELECT row_to_json(t) FROM (
        SELECT task_id, status FROM public.vaani_follow_up_tasks
        WHERE organization_id = $1 AND lead_id = $2 AND task_type = $3 AND status IN ('PENDING', 'DUE', 'IN_PROGRESS')
        LIMIT 1
      ) t;
    `;
    const existing = await queryPostgres(checkSql, [t.organization_id, t.lead_id, t.task_type]).catch(() => null);

    if (existing && existing.task_id) {
      // Active task already exists -> Do not create duplicate!
      continue;
    }

    const insertSql = `
      INSERT INTO public.vaani_follow_up_tasks (
        task_id, organization_id, lead_id, customer_id, task_type, title, description,
        priority, status, assigned_to, due_at, source_call_id, reason, metadata
      ) VALUES (
        ${sqlEscapeString(t.task_id)},
        ${sqlEscapeInt(t.organization_id)},
        ${sqlEscapeString(t.lead_id)},
        ${sqlEscapeString(t.customer_id)},
        ${sqlEscapeString(t.task_type)},
        ${sqlEscapeString(t.title)},
        ${sqlEscapeString(t.description)},
        ${sqlEscapeString(t.priority)},
        ${sqlEscapeString(t.status)},
        ${sqlEscapeString(t.assigned_to)},
        ${sqlEscapeString(t.due_at)},
        ${sqlEscapeInt(t.source_call_id)},
        ${sqlEscapeString(t.reason)},
        ${sqlEscapeJson(t.metadata)}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        priority = EXCLUDED.priority,
        due_at = EXCLUDED.due_at,
        metadata = EXCLUDED.metadata
      RETURNING row_to_json(vaani_follow_up_tasks.*);
    `;

    const inserted = await queryPostgres(insertSql).catch((err) => {
      console.error('[VAANI TASKS] Failed to insert task:', err.message);
      return null;
    });

    if (inserted) {
      createdTasks.push(inserted);
    }
  }

  return createdTasks;
}

/**
 * Task State Machine Transition Validator & Mutator
 */
async function transitionTaskStatus(taskId, targetStatus, organizationId, completedBy = 'Sales Operator', notes = '') {
  if (!organizationId) {
    const err = new Error('organization_id required');
    err.code = 'unauthorized';
    err.statusCode = 401;
    throw err;
  }

  const orgInt = parseInt(organizationId, 10);
  const normalizedTarget = String(targetStatus).toUpperCase();

  if (!Object.values(TASK_STATUSES).includes(normalizedTarget)) {
    const err = new Error(`Invalid target status: ${targetStatus}. Allowed: ${Object.values(TASK_STATUSES).join(', ')}`);
    err.code = 'invalid_status';
    err.statusCode = 422;
    throw err;
  }

  // Query existing task strictly scoped by organization
  const getSql = `
    SELECT row_to_json(t) FROM (
      SELECT * FROM public.vaani_follow_up_tasks WHERE task_id = $1 AND organization_id = $2 LIMIT 1
    ) t;
  `;
  const task = await queryPostgres(getSql, [taskId, orgInt]).catch(() => null);

  if (!task || !task.task_id) {
    const err = new Error(`Task ${taskId} not found for organization`);
    err.code = 'not_found';
    err.statusCode = 404;
    throw err;
  }

  const currentStatus = task.status;

  // Check valid transition
  const allowedNext = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowedNext.includes(normalizedTarget) && currentStatus !== normalizedTarget) {
    const err = new Error(`Invalid state transition from ${currentStatus} to ${normalizedTarget}`);
    err.code = 'invalid_transition';
    err.statusCode = 422;
    throw err;
  }

  const isTerminal = [TASK_STATUSES.COMPLETED, TASK_STATUSES.SKIPPED, TASK_STATUSES.CANCELLED].includes(normalizedTarget);
  const completedAtSql = isTerminal ? 'CURRENT_TIMESTAMP' : 'NULL';

  const updateSql = `
    UPDATE public.vaani_follow_up_tasks
    SET status = ${sqlEscapeString(normalizedTarget)},
        completed_at = ${completedAtSql},
        completed_by = ${isTerminal ? sqlEscapeString(completedBy) : 'NULL'},
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{last_transition}',
          ${sqlEscapeJson({
            from: currentStatus,
            to: normalizedTarget,
            at: new Date().toISOString(),
            by: completedBy,
            notes: notes || null
          })},
          true
        )
    WHERE task_id = ${sqlEscapeString(taskId)} AND organization_id = ${sqlEscapeInt(orgInt)}
    RETURNING row_to_json(vaani_follow_up_tasks.*);
  `;

  const updated = await queryPostgres(updateSql);
  return updated;
}

/**
 * Marks digital evidence received, updates vaani_digital_evidence,
 * and automatically completes corresponding evidence collection tasks.
 */
async function markEvidenceReceived(evidenceData, organizationId) {
  const { run_id, media_type, media_url = 'whatsapp://received', evaluator_notes = 'Received via WhatsApp' } = evidenceData;
  if (!run_id || !media_type || !organizationId) {
    const err = new Error('run_id, media_type, and organization_id required');
    err.code = 'bad_request';
    err.statusCode = 400;
    throw err;
  }

  const orgInt = parseInt(organizationId, 10);
  const runInt = parseInt(run_id, 10);
  const evId = `ev_${runInt}_${media_type}`;

  // Upsert into vaani_digital_evidence
  const evSql = `
    INSERT INTO public.vaani_digital_evidence (
      organization_id, evidence_id, run_id, media_type, media_url, evaluator_notes, received_at
    ) VALUES (
      ${sqlEscapeInt(orgInt)}, ${sqlEscapeString(evId)}, ${sqlEscapeInt(runInt)},
      ${sqlEscapeString(media_type)}, ${sqlEscapeString(media_url)}, ${sqlEscapeString(evaluator_notes)}, CURRENT_TIMESTAMP
    )
    ON CONFLICT (evidence_id) DO UPDATE SET
      media_url = EXCLUDED.media_url,
      evaluator_notes = EXCLUDED.evaluator_notes,
      received_at = CURRENT_TIMESTAMP
    RETURNING row_to_json(vaani_digital_evidence.*);
  `;
  const evidenceRecord = await queryPostgres(evSql);

  // Map media_type to relevant task_type
  let targetTaskType = null;
  if (media_type.startsWith('photo')) targetTaskType = TASK_TYPES.REQUEST_PHOTOS;
  else if (media_type.includes('video')) targetTaskType = TASK_TYPES.REQUEST_RUNNING_VIDEO;
  else if (media_type.includes('rc')) targetTaskType = TASK_TYPES.REQUEST_RC;
  else if (media_type.includes('noc')) targetTaskType = TASK_TYPES.REQUEST_NOC;

  let resolvedTask = null;
  if (targetTaskType) {
    // Find open task
    const findTaskSql = `
      SELECT row_to_json(t) FROM (
        SELECT task_id FROM public.vaani_follow_up_tasks
        WHERE organization_id = $1 AND source_call_id = $2 AND task_type = $3 AND status IN ('PENDING', 'DUE', 'IN_PROGRESS')
        LIMIT 1
      ) t;
    `;
    const openTask = await queryPostgres(findTaskSql, [orgInt, runInt, targetTaskType]).catch(() => null);
    if (openTask && openTask.task_id) {
      resolvedTask = await transitionTaskStatus(openTask.task_id, TASK_STATUSES.COMPLETED, orgInt, 'System (Evidence Received)', `Evidence ${media_type} received`);
    }
  }

  // Check if all critical evidence is now received for this run
  const checkAllEvSql = `
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT media_type FROM public.vaani_digital_evidence
      WHERE organization_id = $1 AND run_id = $2
    ) t;
  `;
  const allEvRows = await queryPostgres(checkAllEvSql, [orgInt, runInt]).catch(() => []);
  const receivedTypes = (Array.isArray(allEvRows) ? allEvRows : []).map(r => r.media_type);

  const hasPhotos = receivedTypes.some(t => t.startsWith('photo'));
  const hasVideo = receivedTypes.some(t => t.includes('video'));
  const hasDoc = receivedTypes.some(t => t.includes('rc') || t.includes('noc'));

  let verifyTask = null;
  if (hasPhotos && hasVideo) {
    // Create VERIFY_MACHINE task if not already present
    const leadSql = `
      SELECT row_to_json(t) FROM (
        SELECT run_id, caller_name, callback_number, machine_brand, machine_model
        FROM vaani_excavator_sales_leads WHERE run_id = $1 LIMIT 1
      ) t;
    `;
    const lead = await queryPostgres(leadSql, [runInt]).catch(() => null);
    if (lead) {
      verifyTask = await processCallFollowUpTasks({
        organization_id: orgInt,
        run_id: runInt,
        lead_id: `lead_${runInt}`,
        customer_id: lead.callback_number || `lead_${runInt}`,
        customer_type: 'seller',
        caller_name: lead.caller_name,
        primary_phone: lead.callback_number,
        qual_state: 'QUALIFIED',
        lead_temp: 'HOT',
        next_action: 'VERIFY_MACHINE',
        mach_details: { brand: lead.machine_brand, model: lead.machine_model },
        comm_terms: {},
        ev_readiness: { photos_agreed: true, running_video_agreed: true, rc_copy_agreed: hasDoc }
      });
    }
  }

  return {
    evidence: evidenceRecord,
    resolved_task: resolvedTask,
    all_evidence_received: hasPhotos && hasVideo,
    verify_task_triggered: Boolean((verifyTask && verifyTask.length > 0) || (hasPhotos && hasVideo))
  };
}

/**
 * Returns tasks for organization categorized into overdue, due_today, upcoming.
 */
async function getTasksForOrganization(organizationId) {
  if (!organizationId) return { overdue: [], due_today: [], upcoming: [] };
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return { overdue: [], due_today: [], upcoming: [] };

  const sql = `
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT task_id AS id, task_id, lead_id, customer_id, task_type, title, description,
             priority, status, assigned_to AS assigned_owner, due_at, due_at AS follow_up_datetime,
             created_at, completed_at, completed_by, source_call_id, reason,
             COALESCE((metadata ->> 'customer_name'), 'Customer') AS customer_name,
             COALESCE((metadata ->> 'primary_phone'), customer_id) AS primary_phone,
             COALESCE((metadata ->> 'customer_type'), 'lead') AS customer_type,
             COALESCE((metadata ->> 'machine_model'), '20-Ton Excavator') AS machine_requirement,
             reason
      FROM public.vaani_follow_up_tasks
      WHERE organization_id = $1 AND status IN ('PENDING', 'DUE', 'IN_PROGRESS')
      ORDER BY due_at ASC, priority DESC
    ) t;
  `;

  const rows = await queryPostgres(sql, [orgInt]).catch(() => []);
  const list = Array.isArray(rows) ? rows : [];

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 86400000;

  const enriched = list.map(item => {
    let category = 'upcoming';
    if (item.due_at) {
      const t = new Date(item.due_at).getTime();
      if (t < startOfToday) category = 'overdue';
      else if (t <= endOfToday) category = 'due_today';
      else category = 'upcoming';
    }
    return { ...item, category };
  });

  return {
    overdue: enriched.filter(i => i.category === 'overdue'),
    due_today: enriched.filter(i => i.category === 'due_today'),
    upcoming: enriched.filter(i => i.category === 'upcoming')
  };
}

module.exports = {
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_TYPES,
  VALID_TRANSITIONS,
  determineTaskPriority,
  determineTaskDueAt,
  buildCandidateTasks,
  processCallFollowUpTasks,
  transitionTaskStatus,
  markEvidenceReceived,
  getTasksForOrganization
};
