'use strict';
// One-command test for the free_mode_cli_required fix.
// Run from the proxy directory:  node test-fix.js
// Starts the proxy with the fix, sends one sync + one stream chat request,
// prints the banner check, the exact outbound request (dump/req-*.json), the
// upstream status codes, and the proxy.log tail. Kills the proxy hard at the
// end so the adopted CLI session is never DELETEd.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.FB_PORT || '3457', 10);
const MODEL = process.env.FB_TEST_MODEL || 'deepseek/deepseek-v4-flash';
const out = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpPost(port, reqBody) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(reqBody);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  out('=== proxy-freebuff fix test ===');
  out(`model=${MODEL} port=${PORT}`);
  out('');

  out('step 1: starting proxy: node server.js --credentials  (FB_DEBUG=1)');
  const child = spawn(process.execPath, ['server.js', '--credentials'], {
    cwd: __dirname,
    env: { ...process.env, FB_DEBUG: '1', FB_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c.toString(); });
  child.stderr.on('data', (c) => { log += c.toString(); });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (log.includes('listening on')) break;
    await sleep(300);
  }

  out('step 2: banner check (must show CostMode + UserId to prove the fix is running)');
  const banner = log
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    .filter((l) => /CostMode|UserId|Listening|Token|credentials|adopt|error|MISSING/i.test(l));
  out(banner.length ? banner.join('\n') : '(no banner captured)');
  if (!log.includes('listening on')) {
    out('');
    out('FAIL: proxy did not start. Output:');
    out(log.slice(-2000));
    child.kill('SIGKILL');
    process.exit(1);
  }
  out('');

  out(`step 3a: sync chat request (client asks no stream; upstream is forced to stream) ...`);
  let r1;
  try {
    r1 = await httpPost(PORT, { model: MODEL, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 8 });
  } catch (e) {
    r1 = { status: 'ERR', body: e.message };
  }
  out(`  -> status ${r1.status}  body: ${String(r1.body).slice(0, 300)}`);
  if (r1.status === 200) {
    try {
      JSON.parse(r1.body);
      out('  -> sync body is valid JSON (SSE accumulated)');
    } catch {
      out('  -> WARNING: sync body is NOT JSON (looks like raw SSE)');
    }
  }

  out(`step 3b: stream chat request (stream:true) ...`);
  let r2;
  try {
    r2 = await httpPost(PORT, { model: MODEL, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 8, stream: true });
  } catch (e) {
    r2 = { status: 'ERR', body: e.message };
  }
  out(`  -> status ${r2.status}  body: ${String(r2.body).slice(0, 300)}`);
  out('');

  out('step 4: exact outbound chat request captured in dump/');
  out('  NOTE: transport is HTTP/2 by default (FB_HTTP2=1) - the CLI runs on Bun and speaks HTTP/2; HTTP/1.1 was the 403 suspect');
  const dumpDir = path.join(__dirname, 'dump');
  const files = fs.existsSync(dumpDir) ? fs.readdirSync(dumpDir).filter((f) => f.startsWith('req-')) : [];
  const chatDump = files
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dumpDir, f), 'utf8')); } catch { return null; } })
    .filter((r) => r && r.url.includes('chat/completions'))
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .pop();
  if (chatDump) {
    out('  URL        : ' + chatDump.method + ' ' + chatDump.url);
    out('  transport  : HTTP/2 ' + (process.env.FB_HTTP2 === '0' ? '(forced OFF by FB_HTTP2=0)' : '(default on, falls back to HTTP/1.1 if unsupported)'));
    out('  User-Agent : ' + chatDump.headers['User-Agent']);
    out('  x-freebuff-acting-user-id: ' + chatDump.headers['x-freebuff-acting-user-id']);
    out('  x-freebuff-model/instance headers must be ABSENT: ' + ('x-freebuff-model' in chatDump.headers || 'x-freebuff-instance-id' in chatDump.headers ? 'PRESENT - WRONG' : 'absent - ok'));
    out('  auth redact: ' + !('Authorization' in chatDump.headers));
    let body = {};
    try { body = JSON.parse(chatDump.body); } catch {}
    const meta = body.codebuff_metadata || {};
    out('  body.model : ' + body.model);
    out('  body.stream: ' + body.stream + '  (must be true - CLI never sends sync upstream)');
    out('  body.provider: ' + JSON.stringify(body.provider) + '  ' + (JSON.stringify(body.provider) === JSON.stringify({ allow_fallbacks: true }) ? '- ok' : '- WRONG (must be {allow_fallbacks:true}, not data_collection)'));
    out('  body.stop  : ' + JSON.stringify(body.stop) + '  ' + (!('stop' in body) ? '- ok (CLI sends no stop on plain chat)' : '- WRONG (should be absent)'));
    out('  meta.cost_mode         : ' + meta.cost_mode);
    out('  meta.freebuff_instance : ' + meta.freebuff_instance_id);
    out('  meta.trace_session_id  : ' + meta.trace_session_id + ' (must be a UUID)');
    out('  meta.client_id         : ' + meta.client_id + ' (len ' + String(meta.client_id || '').length + ', base36)');
  } else {
    out('  (no chat/completions dump found)');
  }
  out('');

  out('step 5: proxy.log tail');
  const logFile = path.join(__dirname, 'proxy.log');
  if (fs.existsSync(logFile)) {
    out(fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-10).join('\n'));
  }
  out('');

  const verdict = r1.status === 200 || r2.status === 200
    ? 'PASS: at least one request got 200 - the fix works.'
    : 'FAIL: still gated. Paste this output + the newest dump/req-*.json here.';
  if (r1.status === 200 && r2.status === 200) out('NOTE: both sync and stream work.');
  out('VERDICT: ' + verdict);

  child.kill('SIGKILL');
  out('');
  out('DONE - paste this output to the assistant.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
