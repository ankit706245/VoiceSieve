const { extractFromConversationLLM } = require('../lib/vaani-llm-extractor');
const assert = require('assert');

// Mock HTTPS to avoid real LLM calls during automated unit test
const https = require('https');
const originalRequest = https.request;
let mockResponses = [];

https.request = (options, callback) => {
  const resStr = mockResponses.shift() || "{}";
  const res = {
    statusCode: 200,
    on: (event, handler) => {
      if (event === 'data') handler(JSON.stringify({ choices: [{ message: { content: resStr } }] }));
      if (event === 'end') handler();
    }
  };
  if (callback) callback(res);
  return { on: () => {}, write: () => {}, end: () => {} };
};

async function runTests() {
  console.log('Running Phase 3 LLM Extractor Tests...');
  
  // Test A, F, I, N, O: HOT Buyer progressing to READY_FOR_HUMAN with owner summary
  mockResponses.push(JSON.stringify({
    customer_name: "Rahul",
    callback_number: "+919999911111",
    customer_type: "buyer",
    lead_temperature: "HOT",
    sales_priority: "CRITICAL",
    priority_reason: "Buyer wants to purchase urgently.",
    deal_readiness: "READY_FOR_HUMAN",
    deal_ready_reason: "Requirement confirmed, agreed to final discussion.",
    owner_summary: "Buyer wants JCB 3DX immediately. Ready for human.",
    next_action: "OWNER_HANDOFF",
    buyer_info: {
      required_machine_brand: "JCB",
      required_machine_model: "3DX"
    }
  }));

  const res1 = await extractFromConversationLLM([
    { role: 'user', text: 'Mujhe JCB 3DX chahiye 2020 model. Mera number +919999911111 hai. Owner se baat karao.' }
  ], [{ lead_temperature: 'WARM' }]); // Pass lead history
  
  assert.strictEqual(res1.extracted.customer_type, 'buyer');
  assert.strictEqual(res1.extracted.lead_temperature, 'HOT');
  assert.strictEqual(res1.extracted.sales_priority, 'CRITICAL');
  assert.strictEqual(res1.extracted.deal_readiness, 'READY_FOR_HUMAN');
  assert.strictEqual(res1.extracted.next_action, 'OWNER_HANDOFF');
  assert.strictEqual(res1.extracted.owner_summary, "Buyer wants JCB 3DX immediately. Ready for human.");
  
  // Test C: COLD buyer
  mockResponses.push(JSON.stringify({
    customer_type: "buyer",
    lead_temperature: "COLD",
    sales_priority: "LOW",
    deal_readiness: "LOST"
  }));
  const res2 = await extractFromConversationLLM("Baad me dekhenge abhi mood nahi hai");
  assert.strictEqual(res2.extracted.lead_temperature, 'COLD');
  assert.strictEqual(res2.extracted.sales_priority, 'LOW');
  assert.strictEqual(res2.extracted.deal_readiness, 'LOST');

  // Test D & K: DO_NOT_CALL and NO_FOLLOW_UP
  mockResponses.push(JSON.stringify({
    customer_type: "unknown",
    lead_temperature: "DO_NOT_CALL",
    sales_priority: "LOW",
    deal_readiness: "DO_NOT_CALL",
    next_action: "NO_FOLLOW_UP",
    follow_up_required: false
  }));
  const res3 = await extractFromConversationLLM("Stop calling me!");
  assert.strictEqual(res3.extracted.lead_temperature, 'DO_NOT_CALL');
  assert.strictEqual(res3.extracted.next_action, 'NO_FOLLOW_UP');
  assert.strictEqual(res3.extracted.follow_up_required, false);

  console.log('Phase 3 LLM tests passed!');
}

runTests().catch(e => {
  console.error("Test failed", e);
  process.exit(1);
});
