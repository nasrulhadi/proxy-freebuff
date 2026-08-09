'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'codebuff-cli/1.0.0 (Windows; Node.js v22.3.0)',
  'codebuff-cli/1.1.2 (darwin; Node.js v22.5.1)',
  'freebuff/0.2.4 (linux; Node.js v20.11.1)',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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
  constructor({ baseURL, timeoutMs, agent }) {
    this.base = new URL(baseURL.endsWith('/') ? baseURL : baseURL + '/');
    this.agent = agent;
    this.timeoutMs = timeoutMs;
  }

  request(method, pathname, { token, body, timeoutMs, headers, signal } = {}) {
    const url = new URL(pathname.replace(/^\//, ''), this.base);
    return this.requestLoop(url, method, { token, body, timeoutMs, headers, signal }, 0);
  }

  requestLoop(url, method, { token, body, timeoutMs, headers, signal } = {}, hops) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortedRequestError());
        return;
      }
      let onAbort = null;
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          agent: this.agent,
          timeout: timeoutMs || this.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'User-Agent': randomUA(),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body != null && method !== 'GET' && method !== 'HEAD' ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            ...headers,
          },
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

  async createSession(token) {
    const res = await this.request('POST', '/api/v1/freebuff/session', { token, body: '{}', timeoutMs: 30000 });
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

  async endSession(token) {
    const res = await this.request('DELETE', '/api/v1/freebuff/session', { token, timeoutMs: 30000 });
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

  chatCompletions(token, body, { model, instanceId, signal } = {}) {
    return this.request('POST', '/api/v1/chat/completions', {
      token,
      body,
      signal,
      headers: {
        ...(model ? { 'x-freebuff-model': model } : {}),
        ...(instanceId ? { 'x-freebuff-instance-id': instanceId } : {}),
      },
    });
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
