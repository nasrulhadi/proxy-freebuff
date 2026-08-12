'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { createLogger, C } = require('./lib/log');
const { UpstreamClient, parseProxy, createTunnelAgent } = require('./lib/upstream');
const { RunManager } = require('./lib/runs');
const { WaitingRoomError } = require('./lib/sessions');
const { ModelRegistry, DEFAULT_SOURCE_URL } = require('./lib/registry');
const {
  injectMetadata,
  accumulateOpenAIStream,
  convertClaudeToOpenAI,
  convertOpenAIResponseToClaude,
  createClaudeStreamConverter,
  countOpenAIPayloadTokens,
  extractUpstreamError,
  openAIErrorBody,
  claudeErrorBody,
  normalizeClaudeErrorType,
} = require('./lib/convert');

const CLI_USAGE = [
  'Usage: node server.js [options]',
  '',
  'Options map onto the FB_* environment variables (CLI args take precedence):',
  '  --token=<token>      FB_TOKEN       Freebuff auth token (user_...)',
  '  --port=<port>        FB_PORT        Listen port (default 3457)',
  '  --host=<host>        FB_HOST        Listen host (default 127.0.0.1)',
  '  --upstream=<url>     FB_UPSTREAM    Upstream base URL (default https://codebuff.com)',
  '  --timeout=<ms>       FB_TIMEOUT     Upstream request timeout (default 900000)',
  '  --rotation=<ms>      FB_ROTATION    Agent run rotation interval (default 21600000)',
  '  --cost-mode=<mode>   FB_COST_MODE   Billing mode sent upstream (default free - 0 credits on free-allowlisted models; use normal/lite/max for paid)',  '  --user-id=<id>       FB_USER_ID       Freebuff account id (auto-filled from --credentials; sent as x-freebuff-acting-user-id)',
  '  --http2=<0|1>        FB_HTTP2         Use HTTP/2 upstream (default 1 - the CLI runs on Bun and speaks HTTP/2; falls back to HTTP/1.1 automatically)',
  '  --proxy=<url>        FB_PROXY       Outbound proxy: http://host:port or socks5://host:port',
  '  --api-keys=<k1,k2>   FB_API_KEYS    Comma-separated client API keys (empty = open on localhost)',
  '  --agents-url=<url>   FB_AGENTS_URL  Model registry source override',
  '  --debug              FB_DEBUG=1     Dump raw upstream responses to dump/',
  '  --credentials        FB_CREDENTIALS=1 Use the Freebuff CLI identity from ~/.config/manicode/credentials.json',
  '                                     (token + adopt the CLI\'s active session - respects the single-session limit)',
  '  --help                                 Show this help',
];
const CLI_KEYS = ['token', 'port', 'host', 'upstream', 'timeout', 'rotation', 'cost-mode', 'user-id', 'proxy', 'api-keys', 'agents-url', 'debug', 'credentials', 'http2'];

function applyCliArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(CLI_USAGE.join('\n'));
      process.exit(0);
    }
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const name = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    if (!name) continue;
    if (name === 'help') {
      console.log(CLI_USAGE.join('\n'));
      process.exit(0);
    }
    if (!CLI_KEYS.includes(name)) {
      console.warn(`ignoring unknown option --${name}`);
      continue;
    }
    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        value = next;
        i++;
      } else if (name === 'debug' || name === 'credentials') {
        value = '1'; // bare flag
      } else {
        console.warn(`missing value for --${name} (use --${name}=<value>); ignoring`);
        continue;
      }
    }
    process.env['FB_' + name.toUpperCase().replace(/-/g, '_')] = value;
  }
}
applyCliArgs(process.argv.slice(2));

// Freebuff CLI identity: the CLI stores its credentials (token + hardware
// fingerprint) and its active session instance in ~/.config/manicode. The
// proxy can reuse both so it behaves like the CLI and never competes for the
// account's single free session.
const CLI_CONFIG_DIR = path.join(os.homedir(), '.config', 'manicode');

function readCliCredentials() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(CLI_CONFIG_DIR, 'credentials.json'), 'utf8'));
    const user = (creds && creds.default) || {};
    return {
      token: (user.authToken || '').trim(),
      id: user.id || '',
    };
  } catch {
    return null;
  }
}

function readCliInstanceOwner() {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(CLI_CONFIG_DIR, 'freebuff-instance-owner.json'), 'utf8'));
    if (typeof owner.instanceId === 'string' && owner.instanceId) {
      return { instanceId: owner.instanceId, pid: typeof owner.pid === 'number' ? owner.pid : null };
    }
  } catch {
    return null;
  }
  return null;
}

const WANT_CLI_CREDENTIALS = process.env.FB_CREDENTIALS === '1';
let TOKEN = (process.env.FB_TOKEN || '').trim();
let CLI_OWNER = null;
let CLI_CRED_SOURCE = null;
if (WANT_CLI_CREDENTIALS || !TOKEN) {
  const creds = readCliCredentials();
  if (creds && creds.token) {
    CLI_CRED_SOURCE = creds;
    TOKEN = creds.token;
    CLI_OWNER = readCliInstanceOwner();
  }
}

// Freebuff account id from the CLI credentials (--credentials) or FB_USER_ID.
// Sent on every chat call as x-freebuff-acting-user-id - the real CLI sends it
// (model-provider.ts) and the free-mode gate expects it.
const USER_ID = (process.env.FB_USER_ID || '').trim() || (CLI_CRED_SOURCE ? CLI_CRED_SOURCE.id : '');

const PORT = parseInt(process.env.FB_PORT || '3457', 10);
const HOST = process.env.FB_HOST || '127.0.0.1';
const UPSTREAM_BASE = process.env.FB_UPSTREAM || 'https://codebuff.com';
const REQUEST_TIMEOUT = parseInt(process.env.FB_TIMEOUT || String(15 * 60 * 1000), 10);
const ROTATION_MS = parseInt(process.env.FB_ROTATION || String(6 * 60 * 60 * 1000), 10);
const API_KEYS = (process.env.FB_API_KEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEBUG = process.env.FB_DEBUG === '1';
// HTTP/2 upstream transport (default on): the real CLI runs on Bun, whose
// fetch negotiates HTTP/2 with the server - and the reference that works
// (trefeon on 9router/Cloudflare Workers) also speaks HTTP/2. Node's https
// module speaks HTTP/1.1, the only transport variable never tested against
// the live gate. Set FB_HTTP2=0 to force HTTP/1.1.
const USE_HTTP2 = (process.env.FB_HTTP2 || '1') !== '0';
// Billing modes the upstream accepts (see create-run-config.ts costMode union);
// unknown values fall back to 'free' and are flagged on startup.
const COST_MODES = new Set(['free', 'lite', 'normal', 'max', 'experimental', 'ask']);
const RAW_COST_MODE = (process.env.FB_COST_MODE || 'free').trim().toLowerCase();
let COST_MODE = COST_MODES.has(RAW_COST_MODE) ? RAW_COST_MODE : 'free';
const PROXY = parseProxy(process.env.FB_PROXY || '');
const REGISTRY_REFRESH_MS = 6 * 60 * 60 * 1000;
const MAINTAIN_MS = 60 * 1000;
const MAX_BODY = 64 * 1024 * 1024;

const logger = createLogger(path.join(__dirname, 'proxy.log'));
if (RAW_COST_MODE !== COST_MODE) {
  logger.logErr(`FB_COST_MODE "${RAW_COST_MODE}" is invalid - using "free" (valid: free, lite, normal, max, experimental, ask)`);
}
const dumpDir = path.join(__dirname, 'dump');

function dumpStream(genId, upstream) {
  if (!DEBUG) return null;
  fs.mkdirSync(dumpDir, { recursive: true });
  const file = fs.createWriteStream(path.join(dumpDir, `dump-${genId}.txt`));
  file.on('error', (e) => logger.logErr(`${genId} | dump write failed: ${e.message}`));
  upstream.on('data', (c) => file.write(c));
  upstream.on('end', () => file.end());
  upstream.on('error', () => file.end());
  return file;
}

logger.banner([
  `${C.bold}Listening${C.reset}    http://${HOST}:${PORT}`,
  `${C.bold}OpenAI${C.reset}       POST /v1/chat/completions`,
  `${C.bold}Anthropic${C.reset}    POST /v1/messages, /v1/messages/count_tokens`,
  `${C.bold}Upstream${C.reset}     ${UPSTREAM_BASE}`,
  `${C.bold}Proxy${C.reset}        ${PROXY ? `${C.green}${PROXY.type}://${PROXY.host}:${PROXY.port}${C.reset}` : `${C.yellow}none${C.reset}`}`,
  `${C.bold}Transport${C.reset}    ${USE_HTTP2 ? `${C.green}HTTP/2${C.reset} (fallback HTTP/1.1)` : `${C.yellow}HTTP/1.1${C.reset}`}`,
  `${C.bold}Token${C.reset}        ${TOKEN ? `${C.green}configured${C.reset}` : `${C.yellow}MISSING${C.reset}`}`,
  `${C.bold}Timeout${C.reset}      ${REQUEST_TIMEOUT}ms`,
  `${C.bold}Debug${C.reset}        ${DEBUG ? `${C.green}ON${C.reset}` : `${C.yellow}OFF${C.reset}`}`,
  `${C.bold}CostMode${C.reset}     ${COST_MODE}`,
  `${C.bold}UserId${C.reset}       ${USER_ID ? `${C.green}configured${C.reset}` : `${C.yellow}-${C.reset}`}`,
]);
logger.log(`=== proxy started (debug: ${DEBUG ? 'ON' : 'OFF'}) ===`);

if (CLI_CRED_SOURCE) {
  logger.log(`using Freebuff CLI credentials from ${CLI_CONFIG_DIR} (account ${CLI_CRED_SOURCE.id})`);
  if (CLI_OWNER && CLI_OWNER.instanceId) {
    logger.log(`will adopt the CLI session instance ${CLI_OWNER.instanceId} (single-session friendly)`);
  } else {
    // Credentials found but no instance owner file yet (CLI never ran, or
    // its session file is missing). Without an instance to adopt we can't
    // tell whether the CLI is running - warn instead of silently creating a
    // competing session that could log a live CLI out.
    logger.logErr('no freebuff-instance-owner.json found - the CLI must run at least once; if the CLI is running, stop it or restart it and retry');
  }
} else if (WANT_CLI_CREDENTIALS) {
  logger.logErr(`--credentials requested but no CLI credentials found at ${CLI_CONFIG_DIR}; falling back to FB_TOKEN`);
}

if (!TOKEN) {
  logger.logErr('FB_TOKEN is not set - chat requests will fail until you set it');
}

const agent = PROXY
  ? createTunnelAgent(PROXY)
  : new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10, timeout: REQUEST_TIMEOUT });
const client = new UpstreamClient({ baseURL: UPSTREAM_BASE, timeoutMs: REQUEST_TIMEOUT, agent, userId: USER_ID, proxy: PROXY, useHttp2: USE_HTTP2 });
const pool = new RunManager({
  name: 'token-1',
  token: TOKEN,
  client,
  logger,
  rotationMs: ROTATION_MS,
  initialInstanceId: CLI_OWNER ? CLI_OWNER.instanceId : null,
  cliOwnerPid: CLI_OWNER ? CLI_OWNER.pid : null,
  // Re-read the CLI owner file on every session refresh so a CLI restart
  // (new pid + instance) is adopted instead of a stale startup snapshot.
  ownerReader: CLI_CRED_SOURCE ? readCliInstanceOwner : null,
});
const registry = new ModelRegistry({ logger, sourceUrl: process.env.FB_AGENTS_URL || DEFAULT_SOURCE_URL });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
  'Access-Control-Allow-Methods': 'POST,GET,OPTIONS',
};

const startedAt = Date.now();

function authorized(req) {
  if (!API_KEYS.length) return true;
  const apiKey = (req.headers['x-api-key'] || '').trim();
  if (API_KEYS.includes(apiKey)) return true;
  const auth = (req.headers['authorization'] || '').trim();
  if (auth.startsWith('Bearer ')) {
    const key = auth.slice('Bearer '.length).trim();
    if (API_KEYS.includes(key)) return true;
  }
  return false;
}

function writeJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(body);
}

function writeOpenAIError(res, status, message, type, code) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(openAIErrorBody(status, message, type, code));
}

function writeClaudeError(res, status, message, type) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(claudeErrorBody(status, message, type));
}

function writeUpstreamError(format, res, status, body) {
  const trimmed = Buffer.isBuffer(body) ? body.toString() : String(body);
  if (trimmed.trim() && isJSON(trimmed)) {
    const { message, type, code } = extractUpstreamError(trimmed);
    if (format === 'claude') writeClaudeError(res, status, message, normalizeClaudeErrorType(status, type));
    else writeOpenAIError(res, status, message, type, code);
    return;
  }
  if (format === 'claude') writeClaudeError(res, status, trimmed.trim() || 'upstream error', 'api_error');
  else writeOpenAIError(res, status, trimmed.trim() || 'upstream error', 'upstream_error', '');
}

function isJSON(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    const succeed = (buf) => {
      if (done) return;
      done = true;
      resolve(buf);
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        const err = new Error('request body too large');
        err.status = 413;
        req.pause();
        fail(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => succeed(Buffer.concat(chunks)));
    req.on('error', fail);
    req.on('close', () => {
      if (done) return;
      if (req.complete) succeed(Buffer.concat(chunks));
      else {
        const err = new Error('request aborted');
        err.code = 'ABORTED';
        fail(err);
      }
    });
  });
}

function handleBodyError(req, res, format, e) {
  if (e && e.status === 413) {
    if (format === 'claude') writeClaudeError(res, 413, 'request body too large', 'invalid_request_error');
    else writeOpenAIError(res, 413, 'request body too large', 'invalid_request_error', '');
    res.on('finish', () => req.destroy());
    req.resume();
    return;
  }
  if (e && e.code === 'ABORTED') return; // client is gone, nothing to respond to
  logger.logErr(`internal error: ${e && e.message ? e.message : e}`);
  try {
    if (res.headersSent) res.end();
    else if (format === 'claude') writeClaudeError(res, 500, 'internal server error', 'api_error');
    else writeOpenAIError(res, 500, 'internal server error', 'server_error', '');
  } catch {}
}

function isSessionInvalid(status, body) {
  if (status < 400) return false;
  let error;
  try {
    error = JSON.parse(body).error;
  } catch {
    return false;
  }
  if (typeof error !== 'string') return false;
  const code = error.trim();
  return (
    code === 'freebuff_update_required' || code === 'waiting_room_required' || code === 'waiting_room_queued' ||
    code === 'session_superseded' || code === 'session_expired'
  );
}

function isRunInvalid(status, body) {
  if (status !== 400) return false;
  const message = body.toLowerCase();
  return message.includes('runid not found') || message.includes('runid not running');
}

// Sync OpenAI clients get the accumulated JSON completion (the upstream is
// always asked to stream - the CLI never sends sync chat - so the SSE is
// rebuilt into a chat.completion response here).
function pipeOpenAISync(res, upstream, genId) {
  return new Promise((resolve) => {
    accumulateOpenAIStream(upstream)
      .then((json) => {
        if (res.headersSent) {
          res.end();
          resolve();
          return;
        }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(json);
        resolve();
      })
      .catch((e) => {
        logger.logErr(`${genId} | sync accumulate failed: ${e.message}`);
        try {
          if (!res.headersSent) writeOpenAIError(res, 502, e.message, 'server_error', '');
        } catch {}
        resolve();
      });
  });
}

function pipeThrough(res, upstream, genId, isSSE) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    try {
      const headers = {};
      for (const [k, v] of Object.entries(upstream.headers || {})) {
        if (k.toLowerCase() !== 'content-length') headers[k] = v;
      }
      res.writeHead(upstream.statusCode, { ...CORS, ...headers });
    } catch (e) {
      logger.logErr(`${genId} | pipe failed before start: ${e.message}`);
      upstream.destroy();
      done();
      return;
    }

    upstream.on('data', (c) => {
      try {
        res.write(c);
      } catch {
        upstream.destroy();
      }
    });
    upstream.on('end', () => {
      try {
        res.end();
      } catch {}
      logger.logDone(`${genId} | pipe end`);
      done();
    });
    upstream.on('error', (e) => {
      logger.logErr(`${genId} | upstream stream error: ${e.message}`);
      try {
        if (isSSE) {
          res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'upstream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        res.end();
      } catch {}
      done();
    });
    upstream.on('close', done);
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
  });
}

async function proxyChat(req, res, payload, model, format, stream) {
  const agentID = registry.agentForModel(model);
  if (!agentID) {
    if (format === 'claude') writeClaudeError(res, 400, `unsupported model "${model}"`, 'invalid_request_error');
    else writeOpenAIError(res, 400, `unsupported model "${model}"`, 'invalid_request_error', 'model_not_found');
    return;
  }

  const t0 = Date.now();
  const genId = 'chatcmpl-' + Date.now();
  logger.logReq(`${model} | ${req.socket.remoteAddress || '-'} | ${format} | ${stream ? 'stream' : 'sync'}`);

  const clientGone = { flag: false };
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone.flag = true;
      controller.abort();
    }
  });
  const gone = () => clientGone.flag;
  const release = (lease) => {
    pool.release(lease.run);
    lease.run = null;
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (gone()) return;
    let lease;
    try {
      lease = await pool.acquire(agentID, model);
    } catch (e) {
      if (gone()) return;
      if (e instanceof WaitingRoomError) {
        if (e.retryAfter > 0) res.setHeader('Retry-After', String(Math.ceil(e.retryAfter / 1000)));
        logger.logErr(`${model} | ${e.message}`);
        if (format === 'claude') writeClaudeError(res, 503, e.message, 'overloaded_error');
        else writeOpenAIError(res, 503, e.message, 'server_error', 'waiting_room_queued');
        return;
      }
      logger.logErr(`${model} | acquire failed: ${e.message}`);
      if (format === 'claude') writeClaudeError(res, 502, 'no healthy upstream auth token available', 'api_error');
      else writeOpenAIError(res, 502, 'no healthy upstream auth token available', 'server_error', '');
      return;
    }
    if (gone()) {
      release(lease);
      return;
    }

    let sessionInstanceID;
    try {
      sessionInstanceID = await pool.ensureSession(model);
    } catch (e) {
      release(lease);
      if (gone()) return;
      if (e instanceof WaitingRoomError) {
        if (e.retryAfter > 0) res.setHeader('Retry-After', String(Math.ceil(e.retryAfter / 1000)));
        logger.logErr(`${model} | ${e.message}`);
        if (format === 'claude') writeClaudeError(res, 503, e.message, 'overloaded_error');
        else writeOpenAIError(res, 503, e.message, 'server_error', 'waiting_room_queued');
        return;
      }
      logger.logErr(`${model} | session failed: ${e.message}`);
      if (format === 'claude') writeClaudeError(res, 502, 'failed to acquire upstream free session', 'api_error');
      else writeOpenAIError(res, 502, 'failed to acquire upstream free session', 'server_error', '');
      return;
    }
    if (gone()) {
      release(lease);
      return;
    }

    const upstreamBody = injectMetadata(payload, {
      model,
      runId: lease.run.id,
      sessionInstanceID,
      traceSessionId: lease.run.traceSessionId,
    });

    let up;
    try {
      up = await client.chatCompletions(TOKEN, upstreamBody, { signal: controller.signal });
    } catch (e) {
      release(lease);
      if (gone()) return;
      logger.logErr(`${model} | upstream: ${e.message}`);
      if (format === 'claude') writeClaudeError(res, 502, e.message, 'api_error');
      else writeOpenAIError(res, 502, e.message, 'server_error', '');
      return;
    }
    if (gone()) {
      release(lease);
      return;
    }

    logger.logUp(`${up.statusCode} ${up.statusCode >= 200 && up.statusCode < 300 ? 'OK' : 'ERR'} | ${model} | ${Date.now() - t0}ms | run ${lease.run.id}`);

    if (up.statusCode >= 200 && up.statusCode < 300) {
      try {
        dumpStream(genId, up);
      } catch (e) {
        logger.logErr(`${model} | dump failed: ${e.message}`);
      }
      try {
        if (format === 'claude') {
          await pipeClaude(res, up, model, stream, genId);
        } else if (stream) {
          await pipeThrough(res, up, genId, true);
        } else {
          await pipeOpenAISync(res, up, genId);
        }
      } catch (e) {
        logger.logErr(`${model} | response pipe failed: ${e.message}`);
        if (!res.headersSent) {
          if (format === 'claude') writeClaudeError(res, 502, e.message, 'api_error');
          else writeOpenAIError(res, 502, e.message, 'server_error', '');
        } else {
          res.end();
        }
      }
      release(lease);
      logger.logDone(`${model} | ${Date.now() - t0}ms`);
      return;
    }

    const errorBody = await readBody(up, 1024 * 1024).catch(() => Buffer.from(''));

    if (isSessionInvalid(up.statusCode, errorBody)) {
      logger.logErr(`${model} | session invalid, refreshing and retrying: ${errorBody}`);
      pool.invalidateSession(String(errorBody).trim());
      release(lease);
      continue;
    }
    if (isRunInvalid(up.statusCode, errorBody)) {
      logger.logErr(`${model} | run invalid, rotating and retrying: ${errorBody}`);
      pool.invalidate(agentID, String(errorBody).trim());
      release(lease);
      continue;
    }
    if (up.statusCode === 401) {
      pool.markCooldown(30 * 60 * 1000, 'upstream auth rejected token');
      pool.invalidateSession('upstream auth rejected token');
    }

    release(lease);
    if (gone()) return;
    logger.logErr(`${model} | upstream ${up.statusCode}: ${errorBody}`);
    writeUpstreamError(format, res, up.statusCode, errorBody);
    return;
  }

  if (gone()) return;
  logger.logErr(`${model} | upstream run expired twice in a row`);
  if (format === 'claude') writeClaudeError(res, 502, 'upstream run expired twice in a row', 'api_error');
  else writeOpenAIError(res, 502, 'upstream run expired twice in a row', 'server_error', '');
}

function pipeClaude(res, upstream, model, stream, genId) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    upstream.on('close', settle(() => resolve()));
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });

    if (!stream) {
      // The upstream is always SSE now (the CLI never sends sync chat), so
      // accumulate it back into an OpenAI completion, then convert to Claude.
      accumulateOpenAIStream(upstream)
        .then(settle((openAIJSON) => {
          try {
            if (upstream.statusCode >= 400) {
              writeUpstreamError('claude', res, upstream.statusCode, Buffer.from(openAIJSON));
              resolve();
              return;
            }
            const converted = convertOpenAIResponseToClaude(openAIJSON);
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
            res.end(converted);
            resolve();
          } catch (e) {
            logger.logErr(`${genId} | claude convert failed: ${e.message}`);
            try {
              if (!res.headersSent) writeClaudeError(res, 502, e.message, 'api_error');
            } catch {}
            resolve();
          }
        }))
        .catch(settle((e) => {
          try {
            if (!res.headersSent) writeClaudeError(res, 502, e.message, 'api_error');
          } catch {}
          resolve();
        }));
      return;
    }

    try {
      res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    } catch (e) {
      upstream.destroy();
      resolve();
      return;
    }

    const converter = createClaudeStreamConverter(model);
    let buffer = '';
    let pendingData = '';
    let sawDone = false;

    function flushData() {
      if (!pendingData.trim()) return;
      if (pendingData.trim() === '[DONE]') {
        sawDone = true;
        return;
      }
      const events = converter.processPayload(pendingData);
      for (const evt of events) {
        res.write(`event: ${evt.name}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
      }
      pendingData = '';
    }

    upstream.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) pendingData = pendingData ? pendingData + '\n' + payload : payload;
        } else if (line === '') {
          flushData();
        }
      }
    });

    upstream.on('end', settle(() => {
      if (buffer.trim().startsWith('data:')) {
        const payload = buffer.slice(5).trim();
        if (payload) pendingData = pendingData ? pendingData + '\n' + payload : payload;
        buffer = '';
      }
      flushData();
      if (!sawDone) {
        const events = converter.finish();
        for (const evt of events) {
          res.write(`event: ${evt.name}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
        }
      }
      res.end();
      resolve();
    }));

    upstream.on('error', settle((e) => {
      logger.logErr(`${genId} | claude upstream stream error: ${e.message}`);
      try {
        if (!res.headersSent) {
          writeClaudeError(res, 502, e.message, 'api_error');
        } else {
          const events = converter.finish();
          for (const evt of events) res.write(`event: ${evt.name}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
          res.end();
        }
      } catch {}
      resolve();
    }));
  });
}

function handleRequest(req, res) {
  res.on('error', () => {});
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (!authorized(req)) {
    if (req.url.startsWith('/v1/messages')) writeClaudeError(res, 401, 'invalid proxy api key', 'authentication_error');
    else writeOpenAIError(res, 401, 'invalid proxy api key', 'authentication_error', '');
    return;
  }

  if (req.method === 'GET' && req.url === '/healthz') {
    writeJSON(res, 200, {
      ok: true,
      started_at: new Date(startedAt).toISOString(),
      uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
      token_configured: Boolean(TOKEN),
      models: registry.models().length,
      token_state: [pool.snapshot()],
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    const created = Math.floor(startedAt / 1000);
    writeJSON(res, 200, {
      object: 'list',
      data: registry.models().map((model) => ({
        id: model,
        object: 'model',
        created,
        owned_by: 'Freebuff2API',
        root: model,
        permission: [],
      })),
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/messages/count_tokens')) {
    readBody(req, MAX_BODY)
      .then((body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          writeClaudeError(res, 400, 'request body must be valid JSON', 'invalid_request_error');
          return;
        }
        const model = String(parsed.model || '').trim();
        if (!model) {
          writeClaudeError(res, 400, 'model is required', 'invalid_request_error');
          return;
        }
        if (!registry.hasModel(model)) {
          writeClaudeError(res, 400, `unsupported model "${model}"`, 'invalid_request_error');
          return;
        }
        let converted;
        try {
          converted = convertClaudeToOpenAI(parsed);
        } catch (e) {
          writeClaudeError(res, 400, e.message, 'invalid_request_error');
          return;
        }
        writeJSON(res, 200, { input_tokens: countOpenAIPayloadTokens(converted.payload) });
      })
      .catch((e) => handleBodyError(req, res, 'claude', e));
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    if (!TOKEN) {
      writeOpenAIError(res, 502, 'FB_TOKEN is not configured', 'server_error', '');
      return;
    }
    readBody(req, MAX_BODY)
      .then((body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          writeOpenAIError(res, 400, 'request body must be valid JSON', 'invalid_request_error', '');
          return;
        }
        const model = String(parsed.model || '').trim();
        if (!model) {
          writeOpenAIError(res, 400, 'model is required', 'invalid_request_error', '');
          return;
        }
        return proxyChat(req, res, parsed, model, 'openai', parsed.stream === true);
      })
      .catch((e) => handleBodyError(req, res, 'openai', e));
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
    if (!TOKEN) {
      writeClaudeError(res, 502, 'FB_TOKEN is not configured', 'api_error');
      return;
    }
    readBody(req, MAX_BODY)
      .then((body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          writeClaudeError(res, 400, 'request body must be valid JSON', 'invalid_request_error');
          return;
        }
        let converted;
        try {
          converted = convertClaudeToOpenAI(parsed);
        } catch (e) {
          writeClaudeError(res, 400, e.message, 'invalid_request_error');
          return;
        }
        return proxyChat(req, res, converted.payload, converted.model, 'claude', converted.stream);
      })
      .catch((e) => handleBodyError(req, res, 'claude', e));
    return;
  }

  writeOpenAIError(res, 404, 'not found', 'invalid_request_error', '');
}

if (process.platform === 'win32') {
  try {
    const netstat = execSync('netstat -ano', { encoding: 'utf8', timeout: 5000 });
    const re = new RegExp(`^\\s*TCP\\s+\\S+:${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'gim');
    const pids = new Set();
    for (const m of netstat.matchAll(re)) pids.add(m[1]);
    for (const pid of pids) {
      try {
        const tasklist = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', timeout: 5000 });
        let isNode = false;
        for (const line of tasklist.split(/\r?\n/)) {
          const cols = line.trim().replace(/^"|"$/g, '').split('","');
          if (cols[0] && /node/i.test(cols[0]) && cols[1] === pid) {
            isNode = true;
            break;
          }
        }
        if (isNode) {
          logger.log(`port ${PORT} is held by a previous node process (PID ${pid}) - killing it`);
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
        } else {
          logger.logErr(`port ${PORT} is in use by non-node process PID ${pid} - NOT killing it (free the port or change FB_PORT)`);
        }
      } catch (e) {
        logger.logErr(`port ${PORT}: could not inspect PID ${pid} (${e.message}) - not killing it`);
      }
    }
  } catch (e) {
    logger.logErr(`port check failed (${e.message}) - will rely on EADDRINUSE handling`);
  }
} else {
  logger.log(`not on Windows - skipping auto-kill of stale processes on port ${PORT}`);
}

const server = http.createServer(handleRequest);
server.timeout = REQUEST_TIMEOUT;
server.keepAliveTimeout = 120000;
server.listen(PORT, HOST, () => logger.log(`listening on http://${HOST}:${PORT}`));
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    logger.logErr(`Port ${PORT} still in use after kill attempt`);
    process.exit(1);
  }
  throw e;
});

registry.loadFallback();
(async () => {
  try {
    await registry.refresh();
  } catch (e) {
    logger.logErr(`registry: initial fetch failed (${e.message}), keeping fallback`);
  }
  setInterval(() => {
    registry.refresh().catch((e) => logger.logErr(`registry: refresh failed: ${e.message}`));
  }, REGISTRY_REFRESH_MS);
})();

if (TOKEN) {
  setInterval(() => {
    pool.maintain().catch((e) => logger.logErr(`maintain failed: ${e.message}`));
  }, MAINTAIN_MS);
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.log('shutting down...');
  const t = setTimeout(() => process.exit(0), 10000);
  t.unref();
  server.close(() => {
    (async () => {
      if (TOKEN) {
        try {
          await pool.shutdown();
        } catch (e) {
          logger.logErr(`shutdown: ${e.message}`);
        }
      }
      logger.end(() => process.exit(0));
    })();
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
