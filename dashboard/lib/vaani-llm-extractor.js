const https = require('https');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b';

async function extractFromConversationLLM(conversationLogs, leadHistory = null) {
  if (!GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY is missing for LLM extraction.');
  }

  // Format the conversation for the LLM prompt
  let transcriptText = '';
  if (Array.isArray(conversationLogs)) {
    for (const msg of conversationLogs) {
      if (msg && msg.role && msg.text) {
        transcriptText += `${msg.role.toUpperCase()}: ${msg.text}\n`;
      }
    }
  } else if (typeof conversationLogs === 'string') {
    transcriptText = conversationLogs;
  }

  if (!transcriptText.trim()) {
    return _buildEmptyResult();
  }

  let historyContext = '';
  if (leadHistory) {
    historyContext = `
PREVIOUS INTERACTION HISTORY:
${JSON.stringify(leadHistory, null, 2)}
(Use this ONLY to preserve the timeline, e.g. a customer moving from COLD to WARM or WARM to HOT. NEVER copy customer_type or buyer/seller facts from history when this transcript states a different intent).`;
  }

  const prompt = `You are a strict data extraction AI for Vaani, a used excavator sales assistant.
Your task is to extract structured data from the following call transcript and previous history.
Do NOT guess or invent data. If a value is unknown, explicitly set it to null.
The conversation may be in Hindi, Hinglish, or English.

CLASSIFICATION RULES (critical):
- Classify customer_type ONLY from what the caller says in THIS transcript.
- SELLER: the caller wants to sell a machine ("machine sale karni hai", "bechna hai", "sell karna hai").
- BUYER: the caller wants to buy a machine ("kharidna hai", "purchase karna hai", "buy karna hai").
- The caller's latest explicit statement wins; if they correct themselves, use the correction.
- PREVIOUS INTERACTION HISTORY is for temperature/timeline continuity only. NEVER copy customer_type or buyer/seller facts from history when this transcript states a different intent.
- If the call was cut before any buy/sell statement, set customer_type to "unknown". Never default to buyer.

TEMPERATURE RULES:
- HOT: Strong purchase/selling intent + useful details + meaningful next action agreed. Do NOT assign HOT merely because machine details exist.
- WARM: Interested but requires callback/details/time before progressing.
- COLD: Not interested or very low intent.
- DO_NOT_CALL: Customer explicitly requests no further calls.

SALES PRIORITY RULES:
- Assign CRITICAL, HIGH, MEDIUM, or LOW deterministically based on intent strength, timeline, budget availability, and next action. 
- Do not replace HOT/WARM/COLD with priority. It is a separate layer.
- Give a priority_reason.

DEAL READINESS RULES:
- States: NEW, QUALIFYING, NURTURING, READY_FOR_HUMAN, CLOSED, LOST, DO_NOT_CALL
- READY_FOR_HUMAN means the customer has reached a point where a human owner should take over (e.g., buyer confirms genuine requirement, key details known, agrees to final discussion; or seller has verified machine info). Do NOT mark READY_FOR_HUMAN from one keyword only.
- Give a deal_ready_reason.

NEXT ACTION / FOLLOW-UP RULES:
- next_action MUST be one of: MATCH_BUYER, SEND_PHOTOS, SEND_INVENTORY, REQUEST_RC, REQUEST_MACHINE_PHOTOS, REQUEST_RUNNING_VIDEO, HUMAN_CALLBACK, YARD_VISIT, PRICE_REVIEW, FUTURE_FOLLOW_UP, NO_FOLLOW_UP, OWNER_HANDOFF.
- OWNER_HANDOFF MUST be used if READY_FOR_HUMAN is reached.
- Determine if follow-up is required based on the conversation (e.g. "Kal photos dekh ke batata hoon" -> WARM -> SEND_PHOTOS -> follow_up_required: true).
- If DO_NOT_CALL, NO_FOLLOW_UP must be selected and follow_up_required must be false.

OWNER HANDOFF SUMMARY:
- ONLY if deal_readiness is READY_FOR_HUMAN, provide an owner_summary (short summary of key requirement/details, budget, location, temperature). Otherwise null.

PROGRESSION:
- Consider the PREVIOUS INTERACTION HISTORY if provided. A customer can progress (e.g., COLD -> WARM, WARM -> HOT). Do NOT reset back to NEW if they have a history. Preserve timeline.

Schema:
{
  "customer_name": string | null,
  "callback_number": string | null,
  "customer_type": "buyer" | "seller" | "unknown",
  "intent": string | null,
  "lead_temperature": "HOT" | "WARM" | "COLD" | "DO_NOT_CALL",
  
  "sales_priority": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "priority_reason": string | null,
  
  "deal_readiness": "NEW" | "QUALIFYING" | "NURTURING" | "READY_FOR_HUMAN" | "CLOSED" | "LOST" | "DO_NOT_CALL",
  "deal_ready_reason": string | null,
  
  "conversation_outcome": string | null,
  "next_action": string | null,
  "follow_up_required": boolean | null,
  "notes": string | null,
  
  "owner_summary": string | null,
  
  "buyer_info": {
    "required_machine_brand": string | null,
    "required_machine_model": string | null,
    "required_machine_category": string | null,
    "required_year": integer | null,
    "required_hours": integer | null (maximum acceptable running hours for a buyer, null if unstated),
    "required_condition": string | null (short condition note like good/average/poor, null if unstated),
    "machine_quantity": integer | null (how many machines the buyer wants, null if unstated),
    "budget": integer | null (in INR, numbers only),
    "budget_min_inr": integer | null (range lower bound in INR, null unless a range was stated),
    "price_or_budget_raw": string | null (the buyer's original budget wording, verbatim),
    "budget_qualifier": "exact" | "range" | "max" | "approximate" | null,
    "finance_required": boolean | null (true only if buyer asks for finance/loan, false only for explicit cash/full-payment, else null),
    "whatsapp_requested": boolean | null (true ONLY if buyer asks Vaani to SEND details on WhatsApp; also request and capture the customer's WhatsApp number when it is offered, e.g. "mera WhatsApp number 98765..." or "WhatsApp pe bhej do"),
    "whatsapp_number": string | null (the WhatsApp/contact number spoken by the customer, same format as callback_number; separate from budget/price),
    "purchase_location": string | null,
    "purchase_timeline": "immediate_within_7_days" | "within_15_30_days" | "future_1_3_months" | "exploring_market" | "not_applicable" | null (use exploring_market when the buyer is only browsing/researching, not ready to buy)
  },

MODEL / YEAR RULES (critical):
- When a seller says brand + number (e.g., "Komatsu do hajar barah" / "JCB 2012" / "Tata 210"), interpret the number as 'machine_model' first (e.g., "2012" could mean model name/year), and 'machine_year' as 'model_year' only when explicitly stated as manufacturing year. If ambiguous (e.g., "do hajar barah" without context), prefer 'machine_model' for the number and ask or leave 'model_year' null. Do NOT ask the same question twice.
- "Do hajar barah" without brand context usually means model year 2012. With brand ("Komatsu do hajar barah") it may mean model or year — capture both possibilities in separate fields.

BUDGET RULES (Hindi/Hinglish/English):
- "20 lakh" -> budget 2000000, qualifier exact, raw verbatim.
- Range ("20 se 22 lakh", "bees se bais lakh") -> budget = upper bound, budget_min_inr = lower bound, qualifier range, raw verbatim. NEVER change the numbers.
- "X lakh tak" / "X se kam" -> budget = X, budget_min_inr null, qualifier max.
- "around/lagbhag X" -> budget = X, qualifier approximate. Never invent a range.
- Ambiguous budget -> all budget fields null. Never guess.
  
  "seller_info": {
    "machine_brand": string | null,
    "machine_model": string | null,
    "machine_year": integer | null,
    "running_hours": integer | null,
    "machine_condition": string | null,
    "machine_location": string | null,
    "document_status": string | null,
    "expected_selling_price": integer | null (in INR),
    "sale_urgency": "URGENT" | "SOON" | "EXPLORING" | "NORMAL" | null (ONLY for explicit seller statements about sale speed; never infer from price, condition, temperature, qualification, or follow-ups; null when evidence is insufficient),
    "price_negotiable": boolean | null (true ONLY if the seller explicitly says the price is flexible/negotiable; false ONLY for explicit final/fixed/no-negotiation wording; null otherwise — never infer from price level or uncertainty),
    "photos_available": boolean | null
  }

NUMBER / PHONE RULES (critical — never confuse these):
- 'callback_number': A spoken phone/contact number (e.g., "mera number 9198...", "call me at 98765...", "+91 98765"). Indian mobile numbers are 10 digits, often start with 9/8/7, and are NEVER monetary values. A number like "919876543210" or "9876543210" is ALWAYS the callback_number, NEVER a budget/price.
- Budget/price: Numbers mentioned with currency words ("lakh", "crore", "rupees", "rupay", "paise", "paisa", "budget", "price", "cost", "amount", "kitna", "kitne") are monetary. Numbers without currency context that sound like phone numbers (10-12 digits, start with 91/9/8/7) are ALWAYS callback_number.
- Never put a 10-12 digit number into any budget/price field. Never put a currency amount into callback_number.
}

Return ONLY valid JSON matching the schema above. Do not include markdown formatting or extra text.
${historyContext}

TRANSCRIPT:
${transcriptText}
`;

  const payload = JSON.stringify({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: 'You are a strict JSON returning data extractor.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  });

  const options = {
    hostname: 'api.groq.com',
    port: 443,
    path: '/openai/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0].message.content;
            const extracted = JSON.parse(content);
            resolve(_mapLLMResultToVaaniFormat(extracted));
          } catch (e) {
            reject(new Error(`Failed to parse JSON from LLM: ${e.message}`));
          }
        } else {
          reject(new Error(`LLM API Error: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(payload);
    req.end();
  });
}

function _buildEmptyResult() {
  return {
    extracted: {
      customer_type: 'unknown',
      caller_name: null,
      machine_details: { brand: null, model: null, quantity: null, model_year: null, max_hours: null, condition: null, location_city: null, running_hours: null, tonnage_class: 'unknown', application_history: 'unknown' },
      commercial_terms: { sale_urgency: null, budget_max_inr: null, budget_min_inr: null, price_or_budget_raw: null, budget_qualifier: null, finance_required: null, expected_price_inr: null, price_negotiable: null, purchase_timeline: 'not_applicable', yard_visit_agreed: false },
      evidence_readiness: { photos_agreed: false, running_video_agreed: false, rc_copy_agreed: false },
      whatsapp_requested: false,
      whatsapp_action: null,
      dnc_requested: false,
      lead_temperature: 'COLD',
      next_action: 'NO_ACTION_REQUIRED',
      conversation_outcome: 'inquiry',
      call_notes: ''
    },
    provenance: {},
    missing_info: { missing: [], captured: [], ambiguous: [] },
    correction_history: [],
    follow_up_question: null
  };
}

function _mapLLMResultToVaaniFormat(llmData) {
  // Map the LLM's flat/schema-specific output back to the existing Vaani heuristic format
  // so ingestCallComplete() works seamlessly without changing the database schema.
  const res = _buildEmptyResult();
  const ext = res.extracted;

  ext.customer_type = llmData.customer_type || 'unknown';
  ext.caller_name = llmData.customer_name || null;
  ext.lead_temperature = llmData.lead_temperature || 'COLD';
  ext.sales_priority = llmData.sales_priority || 'LOW';
  ext.priority_reason = llmData.priority_reason || null;
  ext.deal_readiness = llmData.deal_readiness || 'NEW';
  ext.deal_ready_reason = llmData.deal_ready_reason || null;
  ext.owner_summary = llmData.owner_summary || null;
  ext.next_action = llmData.next_action || 'NO_ACTION_REQUIRED';
  ext.follow_up_required = llmData.follow_up_required ?? null;
  ext.conversation_outcome = llmData.conversation_outcome || 'inquiry';
  ext.call_notes = llmData.notes || '';
  
  if (llmData.lead_temperature === 'DO_NOT_CALL') {
    ext.dnc_requested = true;
  }

  if (llmData.whatsapp_number) {
    ext.whatsapp_number = String(llmData.whatsapp_number).trim();
  }
  if (llmData.whatsapp_requested === true) {
    ext.whatsapp_requested = true;
    ext.whatsapp_action = 'PENDING';
  }

  if (ext.customer_type === 'buyer' && llmData.buyer_info) {
    ext.machine_details.brand = llmData.buyer_info.required_machine_brand;
    ext.machine_details.model = llmData.buyer_info.required_machine_model;
    ext.machine_details.model_year = llmData.buyer_info.required_year;
    const _rh = parseInt(llmData.buyer_info.required_hours, 10);
    ext.machine_details.max_hours = Number.isFinite(_rh) && _rh > 0 && _rh <= 100000 ? _rh : null;
    const _rc = typeof llmData.buyer_info.required_condition === 'string' ? llmData.buyer_info.required_condition.trim().toLowerCase().slice(0, 30) : '';
    const _allowed = ['excellent', 'very good', 'good', 'average', 'fair', 'poor', 'achha', 'achhi', 'badhiya', 'badiya', 'kharab', 'theek', 'theek-thaak', 'ok'];
    ext.machine_details.condition = _allowed.includes(_rc) ? _rc : null;
    ext.machine_details.location_city = llmData.buyer_info.purchase_location;
    const _mcat = typeof llmData.buyer_info.required_machine_category === 'string' ? llmData.buyer_info.required_machine_category.trim().toLowerCase() : '';
    if (_mcat && !ext.machine_details.machine_type) ext.machine_details.machine_type = _mcat;
    const _pcity = typeof llmData.buyer_info.purchase_location === 'string' ? llmData.buyer_info.purchase_location.trim() : '';
    if (_pcity && !ext.machine_details.preferred_city) ext.machine_details.preferred_city = _pcity;
    ext.commercial_terms.budget_max_inr = llmData.buyer_info.budget;
    const _bmin = parseInt(llmData.buyer_info.budget_min_inr, 10);
    ext.commercial_terms.budget_min_inr = Number.isFinite(_bmin) && _bmin > 0 ? _bmin : null;
    ext.commercial_terms.price_or_budget_raw = llmData.buyer_info.price_or_budget_raw || null;
    const _bq = String(llmData.buyer_info.budget_qualifier || '').toLowerCase();
    ext.commercial_terms.budget_qualifier = ['exact', 'range', 'max', 'approximate'].includes(_bq) ? _bq : null;
    const _mq = parseInt(llmData.buyer_info.machine_quantity, 10);
    ext.machine_details.quantity = Number.isFinite(_mq) && _mq > 0 && _mq <= 100 ? _mq : null;
    if (llmData.buyer_info.finance_required === true) ext.commercial_terms.finance_required = true;
    else if (llmData.buyer_info.finance_required === false) ext.commercial_terms.finance_required = false;
    if (llmData.buyer_info.whatsapp_requested === true) {
      ext.whatsapp_requested = true;
      ext.whatsapp_action = 'PENDING';
    }
    const _tl = llmData.buyer_info.purchase_timeline;
    ext.commercial_terms.purchase_timeline = ['immediate_within_7_days', 'within_15_30_days', 'future_1_3_months', 'exploring_market', 'not_applicable'].includes(_tl) ? _tl : null;
  } else if (ext.customer_type === 'seller' && llmData.seller_info) {
    ext.machine_details.brand = llmData.seller_info.machine_brand;
    ext.machine_details.model = llmData.seller_info.machine_model;
    ext.machine_details.model_year = llmData.seller_info.machine_year;
    ext.machine_details.location_city = llmData.seller_info.machine_location;
    ext.machine_details.running_hours = llmData.seller_info.running_hours;
    ext.commercial_terms.expected_price_inr = llmData.seller_info.expected_selling_price;
    const _su = String(llmData.seller_info.sale_urgency || '').toUpperCase();
    ext.commercial_terms.sale_urgency = ['URGENT', 'SOON', 'EXPLORING', 'NORMAL'].includes(_su) ? _su : null;
    if (llmData.seller_info.price_negotiable === true) ext.commercial_terms.price_negotiable = true;
    else if (llmData.seller_info.price_negotiable === false) ext.commercial_terms.price_negotiable = false;
    ext.evidence_readiness.photos_agreed = llmData.seller_info.photos_available === true;
    ext.evidence_readiness.running_video_agreed = llmData.seller_info.video_available === true;
  }

  return res;
}

module.exports = { extractFromConversationLLM, mapLLMResultToVaaniFormat: _mapLLMResultToVaaniFormat };
