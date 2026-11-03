const http = require('http');

const payload = {
  primary_phone: "+918800112233",
  call_metadata: {
    run_id: 888888,
    workflow_id: 3,
    org_id: 1,
    duration_seconds: 120
  },
  conversation: [{"role": "user", "text": "I want to sell my Tata Hitachi"}],
  call_disposition: "completed"
};

const reqOptions = {
  hostname: 'localhost',
  port: 8787,
  path: '/api/v1/vaani/calls/complete',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer f6392e41297cadb6ffd6983550062dc914391af4ef8d712df18b050cf370eb0e'
  }
};

function sendReq() {
  return new Promise((resolve, reject) => {
    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function testIdempotency() {
  console.log("Sending FIRST completion event for run 888888...");
  const res1 = await sendReq();
  console.log("Response 1:", res1.status);

  console.log("Sending SECOND (duplicate) completion event for run 888888...");
  const res2 = await sendReq();
  console.log("Response 2:", res2.status, res2.data);
  
  if (res2.status === 200 && res2.data.includes("already processed")) {
    console.log("PASS: Duplicate event was handled safely and idempotently.");
  } else {
    // If it returns 201 twice, wait, does Vaani return 200 or 201 on success?
    const d = JSON.parse(res2.data);
    if (d.is_duplicate === true) {
      console.log("PASS: Duplicate event detected by Vaani. is_duplicate = true");
    } else {
      console.log("FAIL: Duplicate event was NOT marked as duplicate.");
    }
  }
}

testIdempotency().catch(console.error);
