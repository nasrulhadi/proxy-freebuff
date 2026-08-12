'use strict';
// Capture the REAL Freebuff CLI's outbound API request, byte for byte.
//
// The CLI resolves its backend base URL at runtime from
// CODEBUFF_APP_URL / NEXT_PUBLIC_CODEBUFF_APP_URL (sdk/src/constants.ts ->
// getWebsiteUrl()). Point it at this server, and every API call the CLI
// makes lands here first: we log the exact method/path/headers/body, then
// forward the request to the real https://codebuff.com unchanged (keeping
// the CLI fully functional - so the captured request is one that WORKS).
//
// Usage:
//   terminal 1:  node capture-cli.js
//   terminal 2:  set CODEBUFF_APP_URL=http://127.0.0.1:3888  (and
//                NEXT_PUBLIC_CODEBUFF_APP_URL to the same value) then run
//                `freebuff` and send a normal message.
//   Then paste the capture-cli output here.
//
// Captures go to cli-capture.jsonl (full body) and the console (summary).

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.CAPTURE_PORT || '3888', 10);
const TARGET = process.env.CAPTURE_TARGET || 'https://www.codebuff.com';
const OUT_FILE = path.join(__dirname, 'cli-capture.jsonl');
const MAX_BODY = 8 * 1024 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'cookie' || lk === 'x-api-key') {
      out[k] = v ? String(v).slice(0, 12) + '... (redacted len ' + String(v).length + ')' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function logRecord(rec) {
  try {
    fs.appendFileSync(OUT_FILE, JSON.stringify(rec) + '\n');
  } catch {}
  const h = rec.headers || {};
  console.log('=== CAPTURED ' + rec.method + ' ' + rec.path + ' ===');
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'authorization') continue; // never print the token
    console.log('  ' + k + ': ' + v);
  }
  const body = rec.bodyText || '';
  if (body) console.log('  BODY: ' + (body.length > 4000 ? body.slice(0, 4000) + '...' : body));
  console.log('');
}

const server = http.createServer((req, res) => {
  readBody(req, MAX_BODY)
    .then(async (bodyBuf) => {
      const bodyText = bodyBuf.toString('utf8');
      const record = {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.url,
        headers: redactHeaders(req.headers),
        bodyText,
      };
      logRecord(record);

      // Forward to the real backend, unchanged (Host comes from TARGET).
      const target = new URL(TARGET + req.url);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'host' || lk === 'content-length' || lk === 'connection' || lk === 'proxy-connection') continue;
        headers[k] = v;
      }
      const up = https.request(
        {
          hostname: target.hostname,
          port: target.port || 443,
          path: target.pathname + target.search,
          method: req.method,
          headers,
        },
        (upRes) => {
          const respHeaders = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (k.toLowerCase() !== 'content-length') respHeaders[k] = v;
          }
          res.writeHead(upRes.statusCode, respHeaders);
          upRes.pipe(res);
        }
      );
      up.on('error', (e) => {
        console.log('CAPTURE FORWARD ERROR: ' + e.message);
        try {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'capture forward failed: ' + e.message }));
        } catch {}
      });
      if (bodyBuf.length) up.write(bodyBuf);
      up.end();
    })
    .catch((e) => {
      console.log('CAPTURE READ ERROR: ' + e.message);
      try {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      } catch {}
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('capture-cli listening on http://127.0.0.1:' + PORT);
  console.log('forwarding to ' + TARGET);
  console.log('run the CLI with:  CODEBUFF_APP_URL=http://127.0.0.1:' + PORT + ' freebuff');
  console.log('(Windows PowerShell: $env:CODEBUFF_APP_URL=\"http://127.0.0.1:' + PORT + '\"; $env:NEXT_PUBLIC_CODEBUFF_APP_URL=\"http://127.0.0.1:' + PORT + '\"; freebuff)');
  console.log('');
});
