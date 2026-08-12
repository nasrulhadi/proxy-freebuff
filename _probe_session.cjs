'use strict';
// Probe the real server's view of the current session: GET /api/v1/freebuff/session
// with the CLI's instance id, plus a create-session DRY check is NOT done (that
// would supersede the CLI's session). Just GET + the free-mode account state.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const configDir = path.join(os.homedir(), '.config', 'manicode');
const creds = JSON.parse(fs.readFileSync(path.join(configDir, 'credentials.json'), 'utf8')).default || {};
const owner = JSON.parse(fs.readFileSync(path.join(configDir, 'freebuff-instance-owner.json'), 'utf8'));
const token = creds.authToken || '';
const userId = creds.id || '';
const instanceId = owner.instanceId || '';

function req(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const h = {
      'user-agent': 'ai-sdk/openai-compatible/0.10.7/codebuff',
      ...headers,
    };
    if (body) {
      h['content-type'] = 'application/json';
      h['content-length'] = Buffer.byteLength(body);
    }
    const r = https.request(
      { hostname: 'www.codebuff.com', port: 443, path: pathname, method, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    r.on('error', reject);
    r.setTimeout(20000, () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  console.log('token:', token.slice(0, 8) + '...(len ' + token.length + ')');
  console.log('userId:', userId);
  console.log('instanceId (from owner file):', instanceId);

  // 1) What the CLI's own session reports
  const s = await req('GET', '/api/v1/freebuff/session', {
    authorization: 'Bearer ' + token,
    'x-freebuff-acting-user-id': userId,
    'x-freebuff-instance-id': instanceId,
  });
  console.log('\n=== GET /api/v1/freebuff/session (instance ' + instanceId + ') ===');
  console.log('status:', s.status);
  console.log('body:', s.body.slice(0, 800));

  // 2) GET without instance id (server may return the current/latest)
  const s2 = await req('GET', '/api/v1/freebuff/session', {
    authorization: 'Bearer ' + token,
    'x-freebuff-acting-user-id': userId,
  });
  console.log('\n=== GET /api/v1/freebuff/session (no instance id) ===');
  console.log('status:', s2.status);
  console.log('body:', s2.body.slice(0, 800));

  // 3) A cheap authenticated endpoint to confirm the token works at all
  const s3 = await req('GET', '/api/v1/user', { authorization: 'Bearer ' + token, 'x-freebuff-acting-user-id': userId });
  console.log('\n=== GET /api/v1/user ===');
  console.log('status:', s3.status);
  console.log('body:', s3.body.slice(0, 400));
})().catch((e) => {
  console.log('PROBE ERROR:', e.message);
  process.exit(1);
});
