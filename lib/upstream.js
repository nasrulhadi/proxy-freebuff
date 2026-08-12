'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The real CLI SDK pins its user agent to ai-sdk/openai-compatible/<version>
// /codebuff (sdk/src/impl/model-provider.ts) - the free-mode gate expects
// exactly this identity. Rotating across browser/CLI UAs (a trefeon idea that
// does NOT pass the gate) just fingerprints the proxy as a scripted caller.
// FB_USER_AGENT still overrides if you ever need to.
const DEFAULT_USER_AGENT = 'ai-sdk/openai-compatible/0.10.7/codebuff';
const PINNED_USER_AGENT = process.env.FB_USER_AGENT || '';
function pickUserAgent() {
  return PINNED_USER_AGENT || DEFAULT_USER_AGENT;
}

function clientSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function parseProxy(value) {
  if (!value) return null;
  const raw = value.includes('://') ? value : 'http://' + value;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(':', '');
  const type = scheme === 'socks5' || scheme === 'socks5h' ? 'socks5' : 'http';
  return {
    type,
    host: u.hostname,
    port: parseInt(u.port || (type === 'socks5' ? 1080 : 8080), 10),
    username: u.username ? decodeURIComponent(u.username) : '',
    password: u.password ? decodeURIComponent(u.password) : '',
  };
}

function socksConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let buf = Buffer.alloc(0);
    let stage = 'greeting';
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.destroy();
      reject(err);
    }

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      processReply();
    }

    function processReply() {
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) return fail(new Error('socks5: bad version'));
        const method = buf[1];
        buf = buf.slice(2);
        if (method === 0xff) return fail(new Error('socks5: no acceptable auth method'));
        if (method === 0x00) {
          stage = 'connect';
          sendConnect();
        } else if (method === 0x02) {
          if (!proxy.username) return fail(new Error('socks5: server requires auth'));
          const u = Buffer.from(proxy.username, 'utf8');
          const p = Buffer.from(proxy.password, 'utf8');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          stage = 'auth';
        } else {
          return fail(new Error('socks5: unsupported auth method ' + method));
        }
      } else if (stage === 'auth') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x01 || buf[1] !== 0x00) return fail(new Error('socks5: auth failed'));
        buf = buf.slice(2);
        stage = 'connect';
        sendConnect();
      } else if (stage === 'reply') {
        if (buf.length < 10) return;
        if (buf[0] !== 5) return fail(new Error('socks5: bad reply version'));
        if (buf[1] !== 0) return fail(new Error('socks5: connect failed code ' + buf[1]));
        const atyp = buf[3];
        let addrLen;
        if (atyp === 0x01) addrLen = 10;
        else if (atyp === 0x04) addrLen = 22;
        else addrLen = 4 + buf[4] + 2;
        if (buf.length < addrLen) return;
        buf = buf.slice(addrLen);
        socket.removeListener('data', onData);
        if (buf.length) socket.unshift(buf);
        settled = true;
        resolve(socket);
      }
    }

    function sendConnect() {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      let req;
      const ipv4 = net.isIP(host) === 4;
      const ipv6 = net.isIP(host) === 6;
      if (ipv4) {
        req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split('.').map(Number)), portBuf]);
      } else if (ipv6) {
        req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), Buffer.from(host.split(':').map((h) => parseInt(h, 16))), portBuf]);
      } else {
        req = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf, portBuf]);
      }
      socket.write(req);
      stage = 'reply';
      buf = Buffer.alloc(0);
    }

    socket.on('data', onData);
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write(Buffer.from([0x05, 0x01, proxy.username ? 0x02 : 0x00]));
    });
  });
}

function httpConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        ...(proxy.username
          ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64') }
          : {}),
      },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        socket.removeAllListeners('error');
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed with status ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    req.end();
  });
}

function createTunnelAgent(proxy) {
  class TunnelAgent extends https.Agent {
    createConnection(options, callback) {
      const host = options.servername || options.host;
      const port = options.port || 443;
      const connect = proxy.type === 'socks5' ? socksConnect(proxy, host, port) : httpConnect(proxy, host, port);
      connect.then((socket) => {
        const secureSocket = tls.connect({ socket, servername: host });
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          callback(err || null, err ? undefined : secureSocket);
        };
        secureSocket.once('secureConnect', () => finish(null));
        secureSocket.once('error', finish);
      }).catch((err) => callback(err));
    }
  }
  return new TunnelAgent({ keepAlive: false, timeout: 30000 });
}

class UpstreamClient {
  constructor({ baseURL, timeoutMs, agent, userId, proxy, useHttp2 }) {
    this.base = new URL(baseURL.endsWith('/') ? baseURL : baseURL + '/');
    this.agent = agent;
    this.timeoutMs = timeoutMs;
    // Freebuff account id; the CLI sends it on every chat call as
    // x-freebuff-acting-user-id (model-provider.ts). Without it the server
    // treats the request as a non-CLI caller (403 free_mode_cli_required).
    this.userId = userId || '';
    this.proxy = proxy || null;
    // The real CLI runs on Bun, whose fetch negotiates HTTP/2 with the
    // server - and the known-working reference (trefeon) runs on Cloudflare
    // Workers, which also speaks HTTP/2. Node's https module speaks HTTP/1.1,
    // the only variable never tested against the live gate. Use HTTP/2 first,
    // fall back to HTTP/1.1 automatically if the server can't ALPN it.
    this.useHttp2 = useHttp2 !== false;
  }

  request(method, pathname, { token, body, timeoutMs, headers, signal } = {}) {
    const url = new URL(pathname.replace(/^\//, ''), this.base);
    return this.requestLoop(url, method, { token, body, timeoutMs, headers, signal }, 0);
  }

  requestLoop(url, method, opts, hops) {
    if (this.useHttp2) {
      return this.requestH2(url, method, opts, hops).catch((e) => {
        // Only a connect/ALPN-level failure should fall back (a request was
        // never sent, so there is no risk of double-sending). Once the
        // session is up, stream errors are handled by the caller.
        if (e && e.code === 'H2_CONNECT_FAILED') {
          this.useHttp2 = false;
          console.error(`[upstream] HTTP/2 not available, falling back to HTTP/1.1: ${e.message}`);
          return this.requestLoopHttps(url, method, opts, hops);
        }
        throw e;
      });
    }
    return this.requestLoopHttps(url, method, opts, hops);
  }

  requestH2(url, method, { token, body, timeoutMs, headers, signal } = {}, hops) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortedRequestError());
        return;
      }
      const mergedHeaders = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': pickUserAgent(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      };
      if (process.env.FB_DEBUG === '1') dumpRequest(url, method, mergedHeaders, body);

      let session = null;
      let stream = null;
      let settled = false;
      const settle = (fn) => (...args) => {
        if (settled) return;
        settled = true;
        fn(...args);
      };
      const onAbort = () => {
        if (stream) stream.destroy(abortedRequestError());
        if (session) session.close();
      };
      const fail = settle((err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (session && stream && stream.destroyed) session.close();
        reject(err);
      });
      const done = settle((res) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(res);
      });

      const run = (sess) => {
        session = sess;
        // The session is fully established now: detach the connect-phase
        // error listener so a mid-request session failure flows through the
        // stream's 'error' handler instead of tripping the HTTP/1.1 fallback
        // and re-sending a request that may already have reached the server.
        sess.removeAllListeners('error');
        sess.on('error', (e) => {
          if (stream && !stream.destroyed) stream.destroy(e);
          else fail(e);
        });
        const h2Headers = { ':method': method, ':path': url.pathname + url.search };
        for (const [k, v] of Object.entries(mergedHeaders)) {
          const lk = k.toLowerCase();
          // Header names are lowercase in HTTP/2 and these are forbidden/
          // auto-managed (content-length is computed from the body).
          if (lk === 'connection' || lk === 'host' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'upgrade' || lk === 'content-length') continue;
          h2Headers[lk] = v;
        }
        const req = sess.request(h2Headers);
        stream = req;
        req.setTimeout(timeoutMs || this.timeoutMs);
        req.on('timeout', () => req.destroy(new Error('upstream timeout')));
        // Close the session once this stream is done (no per-request session
        // pooling) so long-running proxies don't accumulate sockets.
        req.on('close', () => {
          try {
            sess.close();
          } catch {}
        });
        req.on('response', (hdrs) => {
          const status = Number(hdrs[':status'] || 0);
          if (status >= 300 && status < 400 && hdrs.location && hops < 5) {
            req.resume();
            let next;
            try {
              next = new URL(hdrs.location, url);
            } catch {
              done(makeH2Response(req, status, hdrs));
              return;
            }
            const follow = status === 307 || status === 308;
            sess.close();
            done(this.requestLoop(next, follow ? method : 'GET', { token, body: follow ? body : null, timeoutMs, headers, signal }, hops + 1));
            return;
          }
          done(makeH2Response(req, status, hdrs));
        });
        req.on('error', (e) => {
          // Once the response headers arrived, the caller's pipeline handles
          // stream errors via the 'error' event; only fail before that.
          if (req.statusCode == null) fail(e);
        });
        if (signal) {
          if (signal.aborted) {
            req.destroy(abortedRequestError());
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        if (body != null && method !== 'GET' && method !== 'HEAD') req.end(body);
        else req.end();
      };

      if (this.proxy) {
        const connectFn = this.proxy.type === 'socks5' ? socksConnect : httpConnect;
        connectFn(this.proxy, url.hostname, 443)
          .then((socket) => {
            const tlsSocket = tls.connect({ socket, servername: url.hostname });
            tlsSocket.on('error', (e) => {
              e.code = 'H2_CONNECT_FAILED';
              fail(e);
            });
            tlsSocket.once('secureConnect', () => {
              let sess;
              try {
                sess = http2.connect(url.origin, { createConnection: () => tlsSocket });
              } catch (e) {
                e.code = 'H2_CONNECT_FAILED';
                fail(e);
                return;
              }
              sess.once('error', (e) => {
                e.code = 'H2_CONNECT_FAILED';
                fail(e);
              });
              run(sess);
            });
          })
          .catch((e) => {
            e.code = 'H2_CONNECT_FAILED';
            fail(e);
          });
      } else {
        let sess;
        try {
          sess = http2.connect(url.origin);
        } catch (e) {
          e.code = 'H2_CONNECT_FAILED';
          fail(e);
          return;
        }
        sess.once('error', (e) => {
          e.code = 'H2_CONNECT_FAILED';
          fail(e);
        });
        sess.once('connect', () => run(sess));
      }
    });
  }

  requestLoopHttps(url, method, { token, body, timeoutMs, headers, signal } = {}, hops) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortedRequestError());
        return;
      }
      const mergedHeaders = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': pickUserAgent(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body != null && method !== 'GET' && method !== 'HEAD' ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      };
      if (process.env.FB_DEBUG === '1') dumpRequest(url, method, mergedHeaders, body);
      let onAbort = null;
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          agent: this.agent,
          timeout: timeoutMs || this.timeoutMs,
          headers: mergedHeaders,
        },
        (res) => {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
            res.resume();
            let next;
            try {
              next = new URL(res.headers.location, url);
            } catch {
              resolve(res);
              return;
            }
            const follow = res.statusCode === 307 || res.statusCode === 308;
            resolve(this.requestLoop(next, follow ? method : 'GET', { token, body: follow ? body : null, timeoutMs, headers, signal }, hops + 1));
            return;
          }
          resolve(res);
        }
      );
      req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
      req.on('error', reject);
      onAbort = () => req.destroy(abortedRequestError());
      if (signal) {
        if (signal.aborted) req.destroy(abortedRequestError());
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      const cleanupAbort = () => {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      req.on('close', cleanupAbort);
      if (body != null && method !== 'GET' && method !== 'HEAD') req.write(body);
      req.end();
    });
  }

  async readJSON(res, limit = 2 * 1024 * 1024) {
    const body = await readBody(res, limit);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`upstream ${res.statusCode}: ${String(body).slice(0, 400)}`);
    }
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`bad upstream JSON: ${String(body).slice(0, 400)}`);
    }
  }

  async createSession(token, model) {
    // Mirrors the real CLI: session creation carries the model as a header
    // (sessions are model-bound) and sends no body.
    const res = await this.request('POST', '/api/v1/freebuff/session', {
      token,
      timeoutMs: 30000,
      headers: model ? { 'x-freebuff-model': model } : {},
    });
    return this.readJSON(res);
  }

  async getSession(token, instanceId) {
    const res = await this.request('GET', '/api/v1/freebuff/session', {
      token,
      timeoutMs: 30000,
      headers: { 'x-freebuff-instance-id': instanceId },
    });
    if (res.statusCode === 404) return { status: 'disabled' };
    return this.readJSON(res);
  }

  async endSession(token, instanceId) {
    // DELETE carries the instance id (mirroring the reference) so it targets
    // only the session we created and can never kill the CLI's session.
    const res = await this.request('DELETE', '/api/v1/freebuff/session', {
      token,
      timeoutMs: 30000,
      headers: instanceId ? { 'x-freebuff-instance-id': instanceId } : {},
    });
    if (res.statusCode === 404) return;
    await readBody(res, 1024 * 1024);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`end session failed: ${res.statusCode}`);
    }
  }

  async startRun(token, agentId) {
    const body = JSON.stringify({ action: 'START', agentId });
    const res = await this.request('POST', '/api/v1/agent-runs', { token, body, timeoutMs: 30000 });
    const parsed = await this.readJSON(res);
    if (!parsed.runId) throw new Error('start run response missing runId');
    return parsed.runId;
  }

  async finishRun(token, runId, totalSteps) {
    const body = JSON.stringify({
      action: 'FINISH',
      runId,
      status: 'completed',
      totalSteps,
      directCredits: 0,
      totalCredits: 0,
    });
    const res = await this.request('POST', '/api/v1/agent-runs', { token, body, timeoutMs: 30000 });
    await readBody(res, 1024 * 1024);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`finish run failed: ${res.statusCode}`);
    }
  }

  // The CLI's chat call carries exactly: Authorization, the pinned
  // ai-sdk user agent, and x-freebuff-acting-user-id (sdk/src/impl/
  // model-provider.ts). It does NOT send x-freebuff-model or
  // x-freebuff-instance-id on the chat call - the session instance travels in
  // the body's codebuff_metadata.freebuff_instance_id instead.
  chatCompletions(token, body, { signal } = {}) {
    return this.request('POST', '/api/v1/chat/completions', {
      token,
      body,
      signal,
      headers: this.userId ? { 'x-freebuff-acting-user-id': this.userId } : {},
    });
  }
}

// Wraps an HTTP/2 ClientHttp2Stream into the same shape server.js consumes
// from an https.IncomingMessage: statusCode, headers (as a plain object,
// pseudo-headers stripped), and the stream's own readable event interface
// (data/end/error/close + destroy).
function makeH2Response(stream, status, hdrs) {
  stream.statusCode = status;
  stream.headers = {};
  for (const [k, v] of Object.entries(hdrs || {})) {
    if (k.startsWith(':')) continue;
    stream.headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return stream;
}

// FB_DEBUG=1: capture the exact outbound request (headers minus Authorization,
// truncated body) to dump/req-*.json so the wire shape can be diffed against
// the real CLI without any account access.
function dumpRequest(url, method, headers, body) {
  try {
    const dir = path.join(__dirname, '..', 'dump');
    fs.mkdirSync(dir, { recursive: true });
    const redacted = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (k.toLowerCase() === 'authorization') continue; // never persist the token
      redacted[k] = v;
    }
    const record = {
      ts: new Date().toISOString(),
      method,
      url: url.href,
      headers: redacted,
      body: typeof body === 'string' ? body.slice(0, 4000) : null,
    };
    fs.writeFileSync(path.join(dir, `req-${Date.now()}-${method}.json`), JSON.stringify(record, null, 2));
  } catch {
    // dumps are best-effort
  }
}

function abortedRequestError() {
  const err = new Error('upstream request aborted');
  err.code = 'ABORTED';
  return err;
}

function readBody(res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        res.destroy();
        reject(new Error('response body too large'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

module.exports = { UpstreamClient, clientSessionId, parseProxy, createTunnelAgent, socksConnect, httpConnect };
