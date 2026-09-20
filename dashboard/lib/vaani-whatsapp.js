/**
 * Vaani WhatsApp Evidence Engine
 * ==============================
 * Production-ready WhatsApp evidence request and inbound webhook processing engine.
 *
 * Complies with:
 * - SHYAM EARTHMOVER — Vaani (वाणी) AI Sales Command Center
 * - Strict multi-tenant isolation (organization_id mandatory)
 * - Safe Mock / Dry-Run provider default (zero real message sends)
 * - Grounded Hindi/Hinglish message generation (zero hallucination)
 * - 8-Point heavy equipment digital evidence checklist
 * - Finite state machine & idempotency across outbound and inbound events
 */

const crypto = require('crypto');

// ----------------------------------------------------------------------------
// Constants & Models
// ----------------------------------------------------------------------------

const MESSAGE_STATUSES = Object.freeze({
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  DELIVERED: 'DELIVERED',
  READ: 'READ',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED'
});

const EVIDENCE_TYPES = Object.freeze({
  BOOM_PHOTOS: 'BOOM_PHOTOS',
  UNDERCARRIAGE_PHOTOS: 'UNDERCARRIAGE_PHOTOS',
  CABIN_GAUGES_PHOTO: 'CABIN_GAUGES_PHOTO',
  COUNTERWEIGHT_PHOTO: 'COUNTERWEIGHT_PHOTO',
  HOUR_METER_PHOTO: 'HOUR_METER_PHOTO',
  RUNNING_VIDEO: 'RUNNING_VIDEO',
  RC_DOCUMENT: 'RC_DOCUMENT',
  BANK_NOC_DOCUMENT: 'BANK_NOC_DOCUMENT'
});

const EVIDENCE_STATUSES = Object.freeze({
  REQUESTED: 'REQUESTED',
  RECEIVED: 'RECEIVED',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED'
});

const READINESS_STATUSES = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  PARTIAL: 'PARTIAL',
  READY_FOR_VERIFICATION: 'READY_FOR_VERIFICATION',
  VERIFIED: 'VERIFIED'
});

const MESSAGE_TYPES = Object.freeze({
  TEXT: 'TEXT',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  DOCUMENT: 'DOCUMENT',
  MEDIA_REQUEST: 'MEDIA_REQUEST'
});

// Canonical 8-point inspection checklist specification
const CANONICAL_EVIDENCE_SPEC = Object.freeze([
  { type: EVIDENCE_TYPES.BOOM_PHOTOS, label: 'Boom structure photos', required: true, legacy_media_type: 'photo_boom' },
  { type: EVIDENCE_TYPES.UNDERCARRIAGE_PHOTOS, label: 'Undercarriage & track photos', required: true, legacy_media_type: 'photo_undercarriage' },
  { type: EVIDENCE_TYPES.CABIN_GAUGES_PHOTO, label: 'Cabin & console photo', required: true, legacy_media_type: 'photo_cabin' },
  { type: EVIDENCE_TYPES.COUNTERWEIGHT_PHOTO, label: 'Counterweight & rear photo', required: true, legacy_media_type: 'photo_exterior' },
  { type: EVIDENCE_TYPES.HOUR_METER_PHOTO, label: 'Hour meter (HMR) reading photo', required: true, legacy_media_type: 'photo_meter' },
  { type: EVIDENCE_TYPES.RUNNING_VIDEO, label: '30s operational running & slew video', required: true, legacy_media_type: 'video_running_30s' },
  { type: EVIDENCE_TYPES.RC_DOCUMENT, label: 'Registration certificate (RC copy)', required: true, legacy_media_type: 'doc_rc' },
  { type: EVIDENCE_TYPES.BANK_NOC_DOCUMENT, label: 'Bank loan clearance NOC', required: false, legacy_media_type: 'doc_noc' }
]);

// ----------------------------------------------------------------------------
// SQL Helpers (Safe, Parameterized & Escaped)
// ----------------------------------------------------------------------------

function sqlEscapeString(val) {
  if (val === null || val === undefined) return 'NULL';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function sqlEscapeInt(val) {
  if (val === null || val === undefined || isNaN(Number(val))) return 'NULL';
  return String(parseInt(val, 10));
}

function sqlEscapeJson(val) {
  if (val === null || val === undefined) return "'{}'::jsonb";
  return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
}

function getVaaniSales() {
  return require('./vaani-sales');
}

function getVaaniTasks() {
  return require('./vaani-tasks');
}

// ----------------------------------------------------------------------------
// Grounded Hindi/Hinglish Templates (Zero Fabrication)
// ----------------------------------------------------------------------------

function buildEvidenceRequest(leadOrOptions = {}, machineData = {}, requestedTypes = [], customNotes = '') {
  let leadData = leadOrOptions;
  if (leadOrOptions && typeof leadOrOptions === 'object') {
    if (leadOrOptions.evidence_type || leadOrOptions.requestedTypes || leadOrOptions.lead || leadOrOptions.machine) {
      leadData = leadOrOptions.lead || leadOrOptions;
      machineData = leadOrOptions.machine || machineData || {};
      requestedTypes = leadOrOptions.evidence_type || leadOrOptions.requestedTypes || requestedTypes;
      customNotes = leadOrOptions.notes || customNotes;
    }
  }

  const name = (leadData.caller_name || leadData.customer_name || '').trim();
  const salutation = name ? `${name} ji` : '';

  const brand = (machineData.brand || leadData.machine_brand || '').trim();
  const model = (machineData.model || leadData.machine_model || '').trim();
  let machineLabel = 'excavator machine';
  if (brand && model) {
    machineLabel = `${brand} ${model}`;
  } else if (brand || model) {
    machineLabel = `${brand || model}`;
  }

  const types = Array.isArray(requestedTypes) ? requestedTypes : (requestedTypes ? [requestedTypes] : []);
  const asksBoom = types.includes(EVIDENCE_TYPES.BOOM_PHOTOS);
  const asksUndercarriage = types.includes(EVIDENCE_TYPES.UNDERCARRIAGE_PHOTOS);
  const asksCabin = types.includes(EVIDENCE_TYPES.CABIN_GAUGES_PHOTO);
  const asksCounterweight = types.includes(EVIDENCE_TYPES.COUNTERWEIGHT_PHOTO);
  const asksPhotos = asksBoom || asksUndercarriage || asksCabin || asksCounterweight || types.includes('REQUEST_PHOTOS') || types.includes('PHOTOS');
  const asksMeter = types.includes(EVIDENCE_TYPES.HOUR_METER_PHOTO) || types.includes('REQUEST_METER_PHOTO') || types.includes('METER');
  const asksVideo = types.includes(EVIDENCE_TYPES.RUNNING_VIDEO) || types.includes('REQUEST_RUNNING_VIDEO') || types.includes('VIDEO');
  const asksRc = types.includes(EVIDENCE_TYPES.RC_DOCUMENT) || types.includes('REQUEST_RC') || types.includes('RC');
  const asksNoc = types.includes(EVIDENCE_TYPES.BANK_NOC_DOCUMENT) || types.includes('REQUEST_NOC') || types.includes('NOC');

  const parts = [];
  let templateKey = 'GENERIC_EVIDENCE_REQUEST';

  // Part 1: Greeting & Context
  if (salutation) {
    parts.push(`Namaste ${salutation}, main Vaani bol rahi hoon, Shyam Earthmover se.`);
  } else {
    parts.push(`Namaste, main Vaani bol rahi hoon, Shyam Earthmover se.`);
  }
  parts.push(`Aapki ${machineLabel} ke liye kuch details verify karni hain.`);

  // Part 2: Specific evidence asks
  if (asksPhotos && asksMeter) {
    templateKey = 'REQ_PHOTOS_AND_METER';
    parts.push(`Kripya machine ke 4 side ke photos aur hour meter ka photo WhatsApp par bhej dijiye.`);
  } else if (types.length === 1 && asksBoom) {
    templateKey = 'REQ_PHOTOS_4SIDE';
    parts.push(`Kripya machine ke 4 side ke photos (boom, undercarriage, cabin, counterweight) aur hour meter ka photo WhatsApp par bhej dijiye.`);
  } else if (types.length === 1 && asksMeter) {
    templateKey = 'REQ_HOUR_METER';
    parts.push(`Kripya machine ke cabin mein lage hour meter ka saaf photo WhatsApp par bhej dijiye.`);
  } else if (types.length === 1 && asksVideo) {
    templateKey = 'REQ_RUNNING_VIDEO';
    parts.push(`${salutation ? salutation + ', k' : 'K'}ripya machine ka lagbhag 30 second ka running video bhi bhej dijiye, jisme machine operate hoti hui dikhe.`);
  } else if (types.length === 1 && asksRc) {
    templateKey = 'REQ_RC_DOCUMENT';
    parts.push(`RC (Registration Certificate) ka photo/document bhi bhej dijiye. Isse machine verification complete karne mein help milegi.`);
  } else if (types.length === 1 && asksNoc) {
    templateKey = 'REQ_BANK_NOC';
    parts.push(`Bank NOC / Clearance certificate ka photo/document bhi bhej dijiye. Isse machine verification complete karne mein help milegi.`);
  } else if (asksPhotos) {
    templateKey = 'REQ_PHOTOS_4SIDE';
    parts.push(`Kripya machine ke 4 side ke photos WhatsApp par bhej dijiye.`);
  } else if (asksMeter) {
    templateKey = 'REQ_HOUR_METER';
    parts.push(`Kripya machine ke cabin mein lage hour meter ka photo WhatsApp par bhej dijiye.`);
  } else if (asksVideo) {
    templateKey = 'REQ_RUNNING_VIDEO';
    parts.push(`Kripya machine ka 30 second ka running video WhatsApp par bhej dijiye.`);
  } else if (asksRc && asksNoc) {
    templateKey = 'REQ_RC_AND_NOC';
    parts.push(`RC aur agar finance tha to NOC ka photo/document bhi bhej dijiye. Isse machine verification complete karne mein help milegi.`);
  }

  // Part 5: Closing
  if (customNotes && customNotes.trim()) {
    parts.push(`Note: ${customNotes.trim()}`);
  }
  parts.push(`Dhanyawad!`);

  return {
    template_key: templateKey,
    body: parts.join(' \n\n'),
    machine_label: machineLabel,
    salutation: salutation || 'Namaste'
  };
}

// ----------------------------------------------------------------------------
// Outbound WhatsApp Provider Interface & Mock Provider
// ----------------------------------------------------------------------------

class MockWhatsAppProvider {
  constructor() {
    this.name = 'mock';
    this.isDryRun = true;
    this.outboundLog = [];
  }

  reset() {
    this.outboundLog = [];
  }

  async sendMessage(params) {
    const { organizationId, to, body, templateKey, idempotencyKey, metadata = {} } = params;

    // Simulate failure mode if requested via params or metadata for testing
    if (params.simulate_failure || metadata.simulate_failure) {
      const err = new Error('Simulated WhatsApp network timeout (Mock Failure)');
      err.code = 'SIMULATED_PROVIDER_OUTAGE';
      err.errorCode = 'PROVIDER_UNREACHABLE';
      throw err;
    }

    const providerMsgId = `mock_wa_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const record = {
      provider: 'mock',
      provider_message_id: providerMsgId,
      organization_id: organizationId,
      to,
      body,
      template_key: templateKey,
      idempotency_key: idempotencyKey,
      status: MESSAGE_STATUSES.SENT,
      sent_at: new Date().toISOString(),
      is_dry_run: true,
      dry_run: true
    };

    this.outboundLog.push(record);

    return {
      success: true,
      provider: 'mock',
      provider_message_id: providerMsgId,
      status: MESSAGE_STATUSES.SENT,
      sent_at: record.sent_at,
      is_dry_run: true,
      dry_run: true
    };
  }

  async sendMediaRequest(params) {
    return this.sendMessage({
      ...params,
      message_type: MESSAGE_TYPES.MEDIA_REQUEST
    });
  }
}

const mockProviderInstance = new MockWhatsAppProvider();

// ----------------------------------------------------------------------------
// Outbound WhatsApp Queue & Send Engine (With Idempotency & DNC Check)
// ----------------------------------------------------------------------------

async function queueAndSendEvidenceRequest(options) {
  const orgVal = options.organizationId || options.organization_id;
  const leadId = options.leadId || options.lead_id;
  const customerId = options.customerId || options.customer_id;
  const phone = options.phone || options.phone_number;
  const leadData = options.leadData || options.lead_data || {};
  const machineData = options.machineData || options.machine_data || {};
  const customNotes = options.customNotes || options.custom_notes || '';
  const idempotencyKey = options.idempotencyKey || options.idempotency_key;
  const metadata = options.metadata || {};

  if (!orgVal) {
    const err = new Error('organization_id required');
    err.statusCode = 400;
    err.code = 'missing_organization_id';
    throw err;
  }

  const orgInt = parseInt(orgVal, 10);
  const typesInput = options.evidence_types || options.evidenceTypes || (options.evidence_type ? [options.evidence_type] : []);
  const evidenceTypes = Array.isArray(typesInput) ? typesInput : [typesInput];

  let targetPhone = (phone || leadData.callback_number || leadData.whatsapp_number || '').trim();
  let resolvedLead = { ...leadData };
  let resolvedMachine = { ...machineData };

  // If phone not provided or lead details missing, resolve from database strictly scoped to org
  if (leadId) {
    const isNum = /^\d+$/.test(leadId);
    const runIdParam = isNum ? parseInt(leadId, 10) : -1;
    const lookupSql = `
      SELECT row_to_json(t) FROM (
        SELECT r.id as run_id,
               (r.gathered_context -> 'extracted_variables') ->> 'caller_name' as caller_name,
               (r.gathered_context -> 'extracted_variables') ->> 'callback_number' as callback_number,
               COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'brand', (r.gathered_context -> 'extracted_variables') ->> 'machine_brand') as machine_brand,
               COALESCE(((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'model', (r.gathered_context -> 'extracted_variables') ->> 'machine_model') as machine_model,
               COALESCE((((r.gathered_context -> 'extracted_variables') -> 'machine_details') ->> 'model_year')::integer, ((r.gathered_context -> 'extracted_variables') ->> 'model_year')::integer) as model_year,
               COALESCE(((r.gathered_context -> 'extracted_variables') ->> 'dnc_requested')::boolean, false) as dnc_requested
        FROM workflow_runs r
        JOIN workflows w ON r.workflow_id = w.id
        WHERE w.organization_id = $1 AND (r.id = $2 OR (r.gathered_context -> 'extracted_variables') ->> 'callback_number' = $3)
        ORDER BY r.id DESC
        LIMIT 1
      ) t;
    `;
    const leadRow = await getVaaniSales().queryPostgres(lookupSql, [orgInt, runIdParam, String(leadId)]).catch(() => null);
    if (leadRow) {
      if (!targetPhone) targetPhone = (leadRow.callback_number || '').trim();
      resolvedLead = { ...leadRow, ...resolvedLead };
      resolvedMachine = { brand: leadRow.machine_brand, model: leadRow.machine_model, model_year: leadRow.model_year, ...resolvedMachine };
    } else if (!targetPhone) {
      const err = new Error('Lead not found for organization');
      err.statusCode = 404;
      err.code = 'lead_not_found';
      throw err;
    }
  }

  if (!targetPhone) {
    const err = new Error('phone_number required for WhatsApp dispatch');
    err.statusCode = 400;
    err.code = 'missing_phone';
    throw err;
  }

  // 1. DNC Check: Suppress outbound WhatsApp immediately if lead opted out (HTTP 403)
  if (resolvedLead.dnc_requested) {
    const err = new Error('Outbound WhatsApp blocked: customer requested Do Not Call / Opt-Out');
    err.statusCode = 403;
    err.code = 'dnc_quarantined';
    throw err;
  }

  // Check DNC table directly
  const dncSql = `
    SELECT row_to_json(t) FROM (
      SELECT id FROM public.vaani_dnc_registry
      WHERE organization_id = $1 AND phone_number = $2 AND is_active = true
      LIMIT 1
    ) t;
  `;
  const dncMatch = await getVaaniSales().queryPostgres(dncSql, [orgInt, targetPhone]).catch(() => null);
  if (dncMatch && dncMatch.id) {
    const err = new Error('Outbound WhatsApp blocked: customer quarantined in DNC compliance registry');
    err.statusCode = 403;
    err.code = 'dnc_quarantined';
    throw err;
  }

  // 2. Check already received / verified evidence to avoid redundant asks
  const existingEvSql = `
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT evidence_type, media_type, status, evaluator_verdict
      FROM public.vaani_digital_evidence
      WHERE organization_id = $1 AND (lead_id = $2 OR run_id = $3)
    ) t;
  `;
  const runIdParam = /^\d+$/.test(leadId) ? parseInt(leadId, 10) : -1;
  const existingEvRows = await getVaaniSales().queryPostgres(existingEvSql, [orgInt, String(leadId), runIdParam]).catch(() => []);
  const receivedOrVerified = new Set();
  if (Array.isArray(existingEvRows)) {
    existingEvRows.forEach(r => {
      if (r.evidence_type) receivedOrVerified.add(r.evidence_type);
      if (r.media_type) receivedOrVerified.add(r.media_type);
    });
  }

  // Filter requestedTypes: only keep items NOT yet received or verified
  const typesToAsk = evidenceTypes.filter(t => !receivedOrVerified.has(t));
  if (typesToAsk.length === 0 && evidenceTypes.length > 0) {
    return {
      success: true,
      sent: false,
      reason: 'ALREADY_RECEIVED',
      message: 'All requested evidence items are already received or verified in system',
      evidence_types: evidenceTypes
    };
  }

  // 3. Outbound Idempotency Check
  const effectiveIdempKey = idempotencyKey || `wa_req_${orgInt}_${leadId}_${typesToAsk.sort().join('_').toLowerCase()}`;
  const checkExistingSql = `
    SELECT row_to_json(t) FROM (
      SELECT * FROM public.vaani_whatsapp_messages
      WHERE organization_id = $1 AND idempotency_key = $2 AND status IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED')
      LIMIT 1
    ) t;
  `;
  const existingMsg = await getVaaniSales().queryPostgres(checkExistingSql, [orgInt, effectiveIdempKey]).catch(() => null);
  if (existingMsg && existingMsg.message_id) {
    return {
      success: true,
      sent: false,
      status: existingMsg.status,
      message_id: existingMsg.message_id,
      is_duplicate: true,
      message: existingMsg
    };
  }

  // 4. Generate Grounded Template Message
  const templated = buildEvidenceRequest(resolvedLead, resolvedMachine, typesToAsk, customNotes);
  const messageId = `msg_wa_${orgInt}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  // 5. Send via Mock Provider
  let providerResult = null;
  let sendError = null;
  const provOpts = options.provider_options || options.providerOptions || {};
  try {
    providerResult = await mockProviderInstance.sendMediaRequest({
      organizationId: orgInt,
      leadId: String(leadId),
      customerId: customerId || targetPhone,
      to: targetPhone,
      body: templated.body,
      templateKey: templated.template_key,
      idempotencyKey: effectiveIdempKey,
      metadata: {
        ...metadata,
        ...provOpts,
        evidence_types: typesToAsk
      },
      ...provOpts
    });
  } catch (err) {
    sendError = err;
  }

  // 6. Record in Database (public.vaani_whatsapp_messages)
  const status = sendError ? MESSAGE_STATUSES.FAILED : MESSAGE_STATUSES.SENT;
  const sentAtSql = sendError ? 'NULL' : 'CURRENT_TIMESTAMP';
  const deliveredAtSql = sendError ? 'NULL' : 'CURRENT_TIMESTAMP'; // Mock provider simulates instant delivery
  const failedAtSql = sendError ? 'CURRENT_TIMESTAMP' : 'NULL';
  const errorCode = sendError ? (sendError.code || 'SEND_FAILED') : null;
  const errorMsg = sendError ? sendError.message : null;
  const provMsgId = providerResult ? providerResult.provider_message_id : null;

  const insertSql = `
    INSERT INTO public.vaani_whatsapp_messages (
      message_id, organization_id, lead_id, customer_id, phone_number, message_type,
      template_key, body, status, provider, provider_message_id, idempotency_key,
      created_at, sent_at, delivered_at, failed_at, error_code, error_message, metadata
    ) VALUES (
      ${sqlEscapeString(messageId)},
      ${sqlEscapeInt(orgInt)},
      ${sqlEscapeString(leadId)},
      ${sqlEscapeString(customerId || targetPhone)},
      ${sqlEscapeString(targetPhone)},
      ${sqlEscapeString(MESSAGE_TYPES.MEDIA_REQUEST)},
      ${sqlEscapeString(templated.template_key)},
      ${sqlEscapeString(templated.body)},
      ${sqlEscapeString(status)},
      'mock',
      ${sqlEscapeString(provMsgId)},
      ${sqlEscapeString(effectiveIdempKey)},
      CURRENT_TIMESTAMP,
      ${sentAtSql},
      ${deliveredAtSql},
      ${failedAtSql},
      ${sqlEscapeString(errorCode)},
      ${sqlEscapeString(errorMsg)},
      ${sqlEscapeJson({
        ...metadata,
        requested_evidence: typesToAsk,
        machine_label: templated.machine_label,
        dry_run: true
      })}
    )
    RETURNING row_to_json(vaani_whatsapp_messages.*);
  `;

  const persisted = await getVaaniSales().queryPostgres(insertSql);

  if (sendError) {
    return {
      success: false,
      sent: false,
      status: MESSAGE_STATUSES.FAILED,
      message_id: messageId,
      error: sendError.message,
      code: sendError.code || 'PROVIDER_ERROR',
      message: persisted
    };
  }

  return {
    success: true,
    sent: true,
    status: MESSAGE_STATUSES.SENT,
    message_id: messageId,
    is_duplicate: false,
    message: persisted
  };
}

// ----------------------------------------------------------------------------
// Inbound Webhook Processor & Evidence Classification
// ----------------------------------------------------------------------------

function classifyMediaEvidence(messageType, text = '', mimeType = '', filename = '', pendingTasks = []) {
  const tLower = (text + ' ' + filename).toLowerCase();

  if (messageType === MESSAGE_TYPES.VIDEO || mimeType.startsWith('video/')) {
    return {
      evidence_type: EVIDENCE_TYPES.RUNNING_VIDEO,
      legacy_media_type: 'video_running_30s',
      notes: '30s operational running video received via WhatsApp'
    };
  }

  if (messageType === MESSAGE_TYPES.DOCUMENT || mimeType.includes('pdf') || mimeType.includes('document')) {
    if (tLower.includes('noc') || tLower.includes('bank') || tLower.includes('loan') || tLower.includes('finance')) {
      return {
        evidence_type: EVIDENCE_TYPES.BANK_NOC_DOCUMENT,
        legacy_media_type: 'doc_noc',
        notes: 'Bank loan clearance NOC document received via WhatsApp'
      };
    }
    return {
      evidence_type: EVIDENCE_TYPES.RC_DOCUMENT,
      legacy_media_type: 'doc_rc',
      notes: 'Registration certificate (RC) document received via WhatsApp'
    };
  }

  // Handle IMAGE
  if (tLower.includes('meter') || tLower.includes('hmr') || tLower.includes('hour') || tLower.includes('ghanta')) {
    return {
      evidence_type: EVIDENCE_TYPES.HOUR_METER_PHOTO,
      legacy_media_type: 'photo_meter',
      notes: 'Hour meter reading photo received via WhatsApp'
    };
  }
  if (tLower.includes('boom')) {
    return {
      evidence_type: EVIDENCE_TYPES.BOOM_PHOTOS,
      legacy_media_type: 'photo_boom',
      notes: 'Boom structure inspection photo received via WhatsApp'
    };
  }
  if (tLower.includes('cabin') || tLower.includes('console')) {
    return {
      evidence_type: EVIDENCE_TYPES.CABIN_GAUGES_PHOTO,
      legacy_media_type: 'photo_cabin',
      notes: 'Cabin and gauges photo received via WhatsApp'
    };
  }
  if (tLower.includes('undercarriage') || tLower.includes('chain') || tLower.includes('track') || tLower.includes('roller')) {
    return {
      evidence_type: EVIDENCE_TYPES.UNDERCARRIAGE_PHOTOS,
      legacy_media_type: 'photo_undercarriage',
      notes: 'Undercarriage track photo received via WhatsApp'
    };
  }
  if (tLower.includes('counterweight') || tLower.includes('pichhe')) {
    return {
      evidence_type: EVIDENCE_TYPES.COUNTERWEIGHT_PHOTO,
      legacy_media_type: 'photo_exterior',
      notes: 'Counterweight rear photo received via WhatsApp'
    };
  }

  // If pending tasks explicitly request meter and meter is missing:
  const asksMeterTask = pendingTasks.some(pt => pt.task_type === 'REQUEST_METER_PHOTO');
  if (asksMeterTask) {
    return {
      evidence_type: EVIDENCE_TYPES.HOUR_METER_PHOTO,
      legacy_media_type: 'photo_meter',
      notes: 'Hour meter photo received via WhatsApp'
    };
  }

  // Default to general exterior / boom photo
  return {
    evidence_type: EVIDENCE_TYPES.BOOM_PHOTOS,
    legacy_media_type: 'photo_boom',
    notes: 'Exterior machine inspection photo received via WhatsApp'
  };
}

async function processInboundWebhook(payload) {
  const {
    organization_id,
    event_id,
    from_phone,
    to_phone,
    message_type,
    text = '',
    media_url = '',
    mime_type = '',
    filename = '',
    raw_metadata = {}
  } = payload;

  if (!organization_id) {
    const err = new Error('Explicit organization_id is required for webhook processing');
    err.statusCode = 400;
    err.code = 'missing_organization_id';
    throw err;
  }

  const orgInt = parseInt(organization_id, 10);
  if (isNaN(orgInt) || orgInt <= 0) {
    const err = new Error('Invalid organization_id');
    err.statusCode = 400;
    err.code = 'invalid_organization_id';
    throw err;
  }

  if (!event_id || !from_phone || !message_type) {
    const err = new Error('event_id, from_phone, and message_type are required');
    err.statusCode = 422;
    err.code = 'invalid_inbound_payload';
    throw err;
  }

  const normMessageType = String(message_type).toUpperCase();
  if (!Object.values(MESSAGE_TYPES).includes(normMessageType)) {
    const err = new Error(`Unsupported message_type: ${message_type}`);
    err.statusCode = 422;
    err.code = 'unsupported_message_type';
    throw err;
  }

  // 1. Inbound Idempotency Check
  const checkEventSql = `
    SELECT row_to_json(t) FROM (
      SELECT event_id FROM public.vaani_whatsapp_inbound_events
      WHERE event_id = $1 AND organization_id = $2
      LIMIT 1
    ) t;
  `;
  const existingEvent = await getVaaniSales().queryPostgres(checkEventSql, [event_id, orgInt]).catch(() => null);
  if (existingEvent && existingEvent.event_id) {
    return {
      success: true,
      status: 'ignored_duplicate',
      is_duplicate: true,
      event_id,
      message: 'Duplicate inbound event ignored'
    };
  }

  // 2. Persist Inbound Event Record
  const insertEventSql = `
    INSERT INTO public.vaani_whatsapp_inbound_events (
      event_id, organization_id, provider, provider_event_type, from_phone, to_phone,
      message_type, text, media_url, mime_type, filename, processed_at, raw_metadata
    ) VALUES (
      ${sqlEscapeString(event_id)},
      ${sqlEscapeInt(orgInt)},
      'mock',
      ${sqlEscapeString(normMessageType)},
      ${sqlEscapeString(from_phone)},
      ${sqlEscapeString(to_phone)},
      ${sqlEscapeString(normMessageType)},
      ${sqlEscapeString(text)},
      ${sqlEscapeString(media_url)},
      ${sqlEscapeString(mime_type)},
      ${sqlEscapeString(filename)},
      CURRENT_TIMESTAMP,
      ${sqlEscapeJson(raw_metadata)}
    )
    RETURNING row_to_json(vaani_whatsapp_inbound_events.*);
  `;
  await getVaaniSales().queryPostgres(insertEventSql);

  // 3. Associate Inbound Event to Lead
  const findLeadSql = `
    SELECT row_to_json(t) FROM (
      SELECT run_id, caller_name, callback_number, machine_brand, machine_model
      FROM vaani_excavator_sales_leads
      WHERE organization_id = $1 AND (callback_number = $2 OR whatsapp_number = $2)
      ORDER BY run_id DESC
      LIMIT 1
    ) t;
  `;
  const leadMatch = await getVaaniSales().queryPostgres(findLeadSql, [orgInt, from_phone]).catch(() => null);
  const runId = leadMatch ? leadMatch.run_id : null;
  const leadId = runId ? `lead_${runId}` : null;

  // If text only, log and return
  if (normMessageType === MESSAGE_TYPES.TEXT && !media_url) {
    return {
      success: true,
      status: 'PROCESSED',
      is_duplicate: false,
      event_id,
      lead_id: leadId,
      message_type: MESSAGE_TYPES.TEXT,
      classified_evidence: null
    };
  }

  // 4. Query Pending F3 Tasks to contextually guide classification
  const tasksSql = `
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT task_id, task_type FROM public.vaani_follow_up_tasks
      WHERE organization_id = $1 AND (source_call_id = $2 OR lead_id = $3) AND status IN ('PENDING', 'DUE', 'IN_PROGRESS')
    ) t;
  `;
  const pendingTasks = await getVaaniSales().queryPostgres(tasksSql, [orgInt, runId || -1, String(leadId || '')]).catch(() => []);

  // 5. Classify Media Evidence
  const classification = classifyMediaEvidence(normMessageType, text, mime_type, filename, pendingTasks);

  // 6. Record Digital Evidence in public.vaani_digital_evidence
  const evId = `ev_wa_${orgInt}_${runId || 'unlinked'}_${crypto.randomBytes(4).toString('hex')}`;
  const effectiveMediaUrl = media_url || `whatsapp://received/${classification.legacy_media_type}/${event_id}`;

  // Check if machine actually exists in vaani_machines to preserve FK constraint
  let linkedMachineId = null;
  if (runId) {
    const findMachSql = `
      SELECT row_to_json(t) FROM (
        SELECT machine_id FROM public.vaani_machines
        WHERE organization_id = $1 AND source_lead_run_id = $2
        LIMIT 1
      ) t;
    `;
    const machRow = await getVaaniSales().queryPostgres(findMachSql, [orgInt, runId]).catch(() => null);
    if (machRow && machRow.machine_id) {
      linkedMachineId = machRow.machine_id;
    }
  }

  const insertEvSql = `
    INSERT INTO public.vaani_digital_evidence (
      organization_id, evidence_id, machine_id, run_id, lead_id, evidence_type,
      media_type, media_url, received_at, evaluator_verdict, evaluator_notes,
      status, source, provider_message_id, metadata
    ) VALUES (
      ${sqlEscapeInt(orgInt)},
      ${sqlEscapeString(evId)},
      ${linkedMachineId ? sqlEscapeString(linkedMachineId) : 'NULL'},
      ${sqlEscapeInt(runId)},
      ${sqlEscapeString(leadId)},
      ${sqlEscapeString(classification.evidence_type)},
      ${sqlEscapeString(classification.legacy_media_type)},
      ${sqlEscapeString(effectiveMediaUrl)},
      CURRENT_TIMESTAMP,
      'pending',
      ${sqlEscapeString(classification.notes)},
      ${sqlEscapeString(EVIDENCE_STATUSES.RECEIVED)},
      'whatsapp',
      ${sqlEscapeString(event_id)},
      ${sqlEscapeJson({
        filename: filename || null,
        mime_type: mime_type || null,
        from_phone: from_phone,
        event_id: event_id,
        classified: true,
        confidence: 0.95
      })}
    )
    RETURNING row_to_json(vaani_digital_evidence.*);
  `;
  const evidenceRecord = await getVaaniSales().queryPostgres(insertEvSql);

  // 7. Resolve Matching F3 Follow-Up Task
  let resolvedTask = null;
  let targetTaskType = null;
  if (classification.evidence_type === EVIDENCE_TYPES.BOOM_PHOTOS ||
      classification.evidence_type === EVIDENCE_TYPES.UNDERCARRIAGE_PHOTOS ||
      classification.evidence_type === EVIDENCE_TYPES.CABIN_GAUGES_PHOTO ||
      classification.evidence_type === EVIDENCE_TYPES.COUNTERWEIGHT_PHOTO) {
    targetTaskType = 'REQUEST_PHOTOS';
  } else if (classification.evidence_type === EVIDENCE_TYPES.HOUR_METER_PHOTO) {
    targetTaskType = 'REQUEST_METER_PHOTO';
  } else if (classification.evidence_type === EVIDENCE_TYPES.RUNNING_VIDEO) {
    targetTaskType = 'REQUEST_RUNNING_VIDEO';
  } else if (classification.evidence_type === EVIDENCE_TYPES.RC_DOCUMENT) {
    targetTaskType = 'REQUEST_RC';
  } else if (classification.evidence_type === EVIDENCE_TYPES.BANK_NOC_DOCUMENT) {
    targetTaskType = 'REQUEST_NOC';
  }

  if (targetTaskType && runId) {
    const findOpenTaskSql = `
      SELECT row_to_json(t) FROM (
        SELECT task_id FROM public.vaani_follow_up_tasks
        WHERE organization_id = $1 AND (source_call_id = $2 OR lead_id = $3) AND task_type = $4 AND status IN ('PENDING', 'DUE', 'IN_PROGRESS')
        LIMIT 1
      ) t;
    `;
    const openTask = await getVaaniSales().queryPostgres(findOpenTaskSql, [orgInt, runId, String(leadId), targetTaskType]).catch(() => null);
    if (openTask && openTask.task_id) {
      resolvedTask = await getVaaniTasks().transitionTaskStatus(
        openTask.task_id,
        'COMPLETED',
        orgInt,
        'Vaani WhatsApp Engine',
        `Evidence ${classification.evidence_type} received via WhatsApp`
      ).catch(() => null);
    }
  }

  // 8. Calculate Evidence Readiness & Check Machine Verification Gate
  const allEvSql = `
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT * FROM public.vaani_digital_evidence
      WHERE organization_id = $1 AND (run_id = $2 OR lead_id = $3)
    ) t;
  `;
  const allEv = await getVaaniSales().queryPostgres(allEvSql, [orgInt, runId || -1, String(leadId || '')]).catch(() => []);
  const readiness = calculateEvidenceReadiness(Array.isArray(allEv) ? allEv : []);

  let verifyTaskCreated = null;
  if (readiness.status === READINESS_STATUSES.READY_FOR_VERIFICATION && runId) {
    // Check if VERIFY_MACHINE task already exists
    const checkVerifySql = `
      SELECT row_to_json(t) FROM (
        SELECT task_id FROM public.vaani_follow_up_tasks
        WHERE organization_id = $1 AND source_call_id = $2 AND task_type = 'VERIFY_MACHINE'
        LIMIT 1
      ) t;
    `;
    const existingVerify = await getVaaniSales().queryPostgres(checkVerifySql, [orgInt, runId]).catch(() => null);
    if (!existingVerify || !existingVerify.task_id) {
      const createdList = await getVaaniTasks().processCallFollowUpTasks({
        organization_id: orgInt,
        run_id: runId,
        lead_id: `lead_${runId}`,
        customer_id: from_phone,
        customer_type: 'seller',
        caller_name: leadMatch ? leadMatch.caller_name : 'Seller',
        primary_phone: from_phone,
        qual_state: 'QUALIFIED',
        lead_temp: 'HOT',
        next_action: 'VERIFY_MACHINE',
        mach_details: { brand: leadMatch ? leadMatch.machine_brand : null, model: leadMatch ? leadMatch.machine_model : null },
        comm_terms: {},
        ev_readiness: { photos_agreed: true, running_video_agreed: true, rc_copy_agreed: true }
      });
      verifyTaskCreated = createdList && createdList.length > 0 ? createdList[0] : null;
    }
  }

  return {
    success: true,
    status: 'PROCESSED',
    is_duplicate: false,
    event_id,
    lead_id: leadId,
    classified_as: classification.evidence_type,
    evidence_type: classification.evidence_type,
    classified_evidence: evidenceRecord,
    resolved_task: resolvedTask,
    evidence_readiness: readiness,
    verify_task_triggered: Boolean(verifyTaskCreated)
  };
}

// ----------------------------------------------------------------------------
// Evidence Readiness Calculator (8-Point Checklist)
// ----------------------------------------------------------------------------

function calculateEvidenceReadiness(evidenceRows = []) {
  const rows = Array.isArray(evidenceRows) ? evidenceRows : [];

  const receivedTypes = new Set();
  const verifiedTypes = new Set();

  rows.forEach(r => {
    const type = r.evidence_type || mapLegacyMediaType(r.media_type);
    if (!type) return;

    if (r.status === EVIDENCE_STATUSES.VERIFIED || r.evaluator_verdict === 'approved') {
      verifiedTypes.add(type);
      receivedTypes.add(type);
    } else if (r.status === EVIDENCE_STATUSES.RECEIVED || r.evaluator_verdict === 'pending' || r.received_at) {
      receivedTypes.add(type);
    }
  });

  const required = CANONICAL_EVIDENCE_SPEC.filter(s => s.required).map(s => s.type);
  const received = Array.from(receivedTypes);
  const verified = Array.from(verifiedTypes);
  const missing = required.filter(t => !receivedTypes.has(t));

  const completionPercent = Math.round((received.length / CANONICAL_EVIDENCE_SPEC.length) * 100);

  // Status computation
  let status = READINESS_STATUSES.NOT_STARTED;
  const hasPhotos = receivedTypes.has(EVIDENCE_TYPES.BOOM_PHOTOS) || receivedTypes.has(EVIDENCE_TYPES.HOUR_METER_PHOTO);
  const hasVideo = receivedTypes.has(EVIDENCE_TYPES.RUNNING_VIDEO);

  if (verified.length >= required.length) {
    status = READINESS_STATUSES.VERIFIED;
  } else if (hasPhotos && hasVideo) {
    status = READINESS_STATUSES.READY_FOR_VERIFICATION;
  } else if (received.length > 0) {
    status = READINESS_STATUSES.PARTIAL;
  }

  return {
    required,
    received,
    verified,
    missing,
    completion_percent: completionPercent,
    status
  };
}

function mapLegacyMediaType(mediaType) {
  if (!mediaType) return null;
  switch (mediaType) {
    case 'photo_boom': return EVIDENCE_TYPES.BOOM_PHOTOS;
    case 'photo_undercarriage': return EVIDENCE_TYPES.UNDERCARRIAGE_PHOTOS;
    case 'photo_cabin': return EVIDENCE_TYPES.CABIN_GAUGES_PHOTO;
    case 'photo_exterior': return EVIDENCE_TYPES.COUNTERWEIGHT_PHOTO;
    case 'photo_meter': return EVIDENCE_TYPES.HOUR_METER_PHOTO;
    case 'video_running_30s': return EVIDENCE_TYPES.RUNNING_VIDEO;
    case 'doc_rc': return EVIDENCE_TYPES.RC_DOCUMENT;
    case 'doc_noc': return EVIDENCE_TYPES.BANK_NOC_DOCUMENT;
    default: return null;
  }
}

// ----------------------------------------------------------------------------
// Lead Evidence & WhatsApp Queries (Tenant Scoped)
// ----------------------------------------------------------------------------

async function getLeadWhatsAppHistory(leadId, organizationId) {
  if (!organizationId) return [];
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return [];

  const runIdParam = /^\d+$/.test(leadId) ? parseInt(leadId, 10) : -1;
  const sql = `
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT message_id as id, 'OUTBOUND' as direction, message_type, body as text, media_reference as media_url, NULL as mime_type, status, created_at as timestamp, metadata
      FROM public.vaani_whatsapp_messages
      WHERE organization_id = $1 AND (lead_id = $2 OR lead_id = ('lead_' || $2))

      UNION ALL

      SELECT e.event_id as id, 'INBOUND' as direction, e.message_type, e.text, e.media_url, e.mime_type, 'DELIVERED' as status, e.processed_at as timestamp, e.raw_metadata as metadata
      FROM public.vaani_whatsapp_inbound_events e
      JOIN public.vaani_excavator_sales_leads l ON l.organization_id = e.organization_id AND (e.from_phone = l.callback_number OR e.from_phone = l.whatsapp_number)
      WHERE e.organization_id = $1 AND (l.run_id = $3 OR ('lead_' || l.run_id) = $2)

      ORDER BY timestamp ASC
    ) t;
  `;
  const rows = await getVaaniSales().queryPostgres(sql, [orgInt, String(leadId), runIdParam]).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

async function getLeadEvidence(leadId, organizationId) {
  if (!organizationId) return { items: [], readiness: calculateEvidenceReadiness([]) };
  const orgInt = parseInt(organizationId, 10);
  if (isNaN(orgInt) || orgInt <= 0) return { items: [], readiness: calculateEvidenceReadiness([]) };

  const runIdParam = /^\d+$/.test(leadId) ? parseInt(leadId, 10) : -1;
  const sql = `
    SELECT COALESCE(json_agg(t), '[]'::json) FROM (
      SELECT evidence_id, machine_id, run_id, lead_id, evidence_type, media_type,
             media_url, storage_path, received_at, evaluator_verdict, evaluator_notes,
             status, source, provider_message_id, verified_at, verified_by, metadata
      FROM public.vaani_digital_evidence
      WHERE organization_id = $1 AND (lead_id = $2 OR lead_id = ('lead_' || $2) OR run_id = $3)
      ORDER BY received_at ASC
    ) t;
  `;
  const rows = await getVaaniSales().queryPostgres(sql, [orgInt, String(leadId), runIdParam]).catch(() => []);
  const items = Array.isArray(rows) ? rows : [];
  return {
    items,
    readiness: calculateEvidenceReadiness(items)
  };
}

module.exports = {
  MESSAGE_STATUSES,
  EVIDENCE_TYPES,
  EVIDENCE_STATUSES,
  READINESS_STATUSES,
  MESSAGE_TYPES,
  CANONICAL_EVIDENCE_SPEC,
  MockWhatsAppProvider,
  mockProviderInstance,
  buildEvidenceRequest,
  queueAndSendEvidenceRequest,
  processInboundWebhook,
  classifyMediaEvidence,
  calculateEvidenceReadiness,
  getLeadWhatsAppHistory,
  getLeadEvidence
};
