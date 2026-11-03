const http = require('http');

const payload = {
  primary_phone: "+919999999999",
  call_metadata: {
    run_id: 888889,
    workflow_id: 3,
    org_id: 1,
    duration_seconds: 60
  },
  conversation: [{"role": "user", "text": "I want to sell a JCB 3DX, 2020 model for 15 lakhs."}],
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

const req = http.request(reqOptions, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(res.statusCode, data));
});
req.write(JSON.stringify(payload));
req.end();
