'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { createLogger, C } = require('./lib/log');
const { UpstreamClient, parseProxy, createTunnelAgent } = require('./lib/upstream');
const { RunManager } = require('./lib/runs');
const { WaitingRoomError } = require('./lib/sessions');
const { ModelRegistry, DEFAULT_SOURCE_URL } = require('./lib/registry');
const {
  injectMetadata,
  convertClaudeToOpenAI,
  convertOpenAIResponseToClaude,
  createClaudeStreamConverter,
  countOpenAIPayloadTokens,
  extractUpstreamError,
  openAIErrorBody,
  claudeErrorBody,
  normalizeClaudeErrorType,
} = require('./lib/convert');

const PORT = parseInt(process.env.FB_PORT || '3457', 10);
const HOST = process.env.FB_HOST || '127.0.0.1';
const TOKEN = (process.env.FB_TOKEN || '').trim();
const UPSTREAM_BASE = process.env.FB_UPSTREAM || 'https://codebuff.com';
const REQUEST_TIMEOUT = parseInt(process.env.FB_TIMEOUT || String(15 * 60 * 1000), 10);
const ROTATION_MS = parseInt(process.env.FB_ROTATION || String(6 * 60 * 60 * 1000), 10);
const API_KEYS = (process.env.FB_API_KEYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEBUG = process.env.FB_DEBUG === '1';
const PROXY = parseProxy(process.env.FB_PROXY || '');
const REGISTRY_REFRESH_MS = 6 * 60 * 60 * 1000;
const MAINTAIN_MS = 60 * 1000;
const MAX_BODY = 64 * 1024 * 1024;

const logger = createLogger(path.join(__dirname, 'proxy.log'));
const dumpDir = path.join(__dirname, 'dump');

function dumpStream(genId, upstream) {
  if (!DEBUG) return null;
  fs.mkdirSync(dumpDir, { recursive: true });
  const file = fs.createWriteStream(path.join(dumpDir, `dump-${genId}.txt`));
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
  `${C.bold}Token${C.reset}        ${TOKEN ? `${C.green}configured${C.reset}` : `${C.yellow}MISSING${C.reset}`}`,
  `${C.bold}Timeout${C.reset}      ${REQUEST_TIMEOUT}ms`,
  `${C.bold}Debug${C.reset}        ${DEBUG ? `${C.green}ON${C.reset}` : `${C.yellow}OFF${C.reset}`}`,
]);
logger.log(`=== proxy started (debug: ${DEBUG ? 'ON' : 'OFF'}) ===`);

if (!TOKEN) {
  logger.logErr('FB_TOKEN is not set - chat requests will fail until you set it');
}

const agent = PROXY
  ? createTunnelAgent(PROXY)
  : new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 10, timeout: REQUEST_TIMEOUT });
const client = new UpstreamClient({ baseURL: UPSTREAM_BASE, timeoutMs: REQUEST_TIMEOUT, agent });
const pool = new RunManager({ name: 'token-1', token: TOKEN, client, logger, rotationMs: ROTATION_MS });
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
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

function pipeThrough(res, upstream, genId, isSSE) {
  const headers = {};
  for (const [k, v] of upstream.headers) {
    if (k.toLowerCase() !== 'content-length') headers[k] = v;
  }
  res.writeHead(upstream.statusCode, { ...CORS, ...headers });

  upstream.on('data', (c) => res.write(c));
  upstream.on('end', () => {
    res.end();
    logger.logDone(`${genId} | pipe end`);
  });
  upstream.on('error', (e) => {
    logger.logErr(`${genId} | upstream stream error: ${e.message}`);
    if (!res.headersSent) {
      writeOpenAIError(res, 502, e.message, 'upstream_error', '');
      return;
    }
    if (isSSE) {
      res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'upstream_error' } })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
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

  for (let attempt = 0; attempt < 2; attempt++) {
    let lease;
    try {
      lease = await pool.acquire(agentID);
    } catch (e) {
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

    let sessionInstanceID;
    try {
      sessionInstanceID = await pool.ensureSession();
    } catch (e) {
      pool.release(lease.run);
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

    const upstreamBody = injectMetadata(payload, { model, runId: lease.run.id, sessionInstanceID });

    let up;
    try {
      up = await client.chatCompletions(TOKEN, upstreamBody, { model, instanceId: sessionInstanceID });
    } catch (e) {
      pool.release(lease.run);
      logger.logErr(`${model} | upstream: ${e.message}`);
      if (format === 'claude') writeClaudeError(res, 502, e.message, 'api_error');
      else writeOpenAIError(res, 502, e.message, 'server_error', '');
      return;
    }

    logger.logUp(`${up.statusCode} ${up.statusCode >= 200 && up.statusCode < 300 ? 'OK' : 'ERR'} | ${model} | ${Date.now() - t0}ms | run ${lease.run.id}`);

    if (up.statusCode >= 200 && up.statusCode < 300) {
      dumpStream(genId, up);
      try {
        if (format === 'claude') {
          await pipeClaude(res, up, model, stream, genId);
        } else {
          pipeThrough(res, up, genId, stream);
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
      pool.release(lease.run);
      logger.logDone(`${model} | ${Date.now() - t0}ms`);
      return;
    }

    const errorBody = await readBody(up, 1024 * 1024).catch(() => Buffer.from(''));

    if (isSessionInvalid(up.statusCode, errorBody)) {
      logger.logErr(`${model} | session invalid, refreshing and retrying: ${errorBody}`);
      pool.invalidateSession(String(errorBody).trim());
      pool.release(lease.run);
      continue;
    }
    if (isRunInvalid(up.statusCode, errorBody)) {
      logger.logErr(`${model} | run invalid, rotating and retrying: ${errorBody}`);
      pool.invalidate(agentID, String(errorBody).trim());
      pool.release(lease.run);
      continue;
    }
    if (up.statusCode === 401) {
      pool.markCooldown(30 * 60 * 1000, 'upstream auth rejected token');
      pool.invalidateSession('upstream auth rejected token');
    }

    pool.release(lease.run);
    logger.logErr(`${model} | upstream ${up.statusCode}: ${errorBody}`);
    writeUpstreamError(format, res, up.statusCode, errorBody);
    return;
  }

  logger.logErr(`${model} | upstream run expired twice in a row`);
  if (format === 'claude') writeClaudeError(res, 502, 'upstream run expired twice in a row', 'api_error');
  else writeOpenAIError(res, 502, 'upstream run expired twice in a row', 'server_error', '');
}

function pipeClaude(res, upstream, model, stream, genId) {
  return new Promise((resolve, reject) => {
    if (!stream) {
      readBody(upstream, 64 * 1024 * 1024)
        .then((body) => {
          if (upstream.statusCode >= 400) {
            writeUpstreamError('claude', res, upstream.statusCode, body);
            resolve();
            return;
          }
          const converted = convertOpenAIResponseToClaude(body.toString());
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
          res.end(converted);
          resolve();
        })
        .catch(reject);
      return;
    }

    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

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

    upstream.on('end', () => {
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
    });

    upstream.on('error', (e) => {
      logger.logErr(`${genId} | claude upstream stream error: ${e.message}`);
      if (!res.headersSent) {
        writeClaudeError(res, 502, e.message, 'api_error');
      } else {
        const events = converter.finish();
        for (const evt of events) res.write(`event: ${evt.name}\ndata: ${JSON.stringify(evt.payload)}\n\n`);
        res.end();
      }
      resolve();
    });

    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
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
        const { payload } = convertClaudeToOpenAI(parsed);
        writeJSON(res, 200, { input_tokens: countOpenAIPayloadTokens(payload) });
      })
      .catch(() => writeClaudeError(res, 400, 'request body too large', 'invalid_request_error'));
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
      .catch(() => writeOpenAIError(res, 400, 'request body too large', 'invalid_request_error', ''));
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
      .catch(() => writeClaudeError(res, 400, 'request body too large', 'invalid_request_error'));
    return;
  }

  writeOpenAIError(res, 404, 'not found', 'invalid_request_error', '');
}

try {
  const netstat = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: 'utf8', timeout: 5000 });
  const match = netstat.trim().match(/(\d+)\s*$/m);
  if (match) {
    const pid = match[1];
    logger.log(`killing existing process on port ${PORT} (PID ${pid})`);
    execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
  }
} catch {}

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
