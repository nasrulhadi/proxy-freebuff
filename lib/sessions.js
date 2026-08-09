'use strict';

const FREE_SESSION_POLL_INTERVAL = 5000;

class WaitingRoomError extends Error {
  constructor({ token, position, queueDepth, retryAfter }) {
    let message = 'freebuff waiting room queued';
    if (token) message += ` for ${token}`;
    if (queueDepth >= position) message += ` (position ${position}/${queueDepth})`;
    else if (position > 0) message += ` (position ${position})`;
    if (retryAfter > 0) message += `, retry in about ${Math.max(1, Math.round(retryAfter / 1000))}s`;
    super(message);
    this.name = 'WaitingRoomError';
    this.token = token;
    this.position = position;
    this.queueDepth = queueDepth;
    this.retryAfter = retryAfter;
  }
}

class FreeSession {
  constructor({ name, token, client, logger }) {
    this.name = name;
    this.token = token;
    this.client = client;
    this.logger = logger;
    this.session = null;
    this.lastError = '';
    this.refreshPromise = null;
  }

  readyInstanceID(now) {
    const s = this.session;
    if (!s) return undefined;
    if (s.status === 'disabled') return '';
    if (s.status === 'active') {
      if (!s.instanceID) return undefined;
      if (!s.expiresAt || now < s.expiresAt - 5000) return s.instanceID;
    }
    return undefined;
  }

  waitingError(now) {
    const s = this.session;
    if (!s || s.status !== 'queued') return null;
    if (s.pollAt && now < s.pollAt) {
      return new WaitingRoomError({
        token: this.name,
        position: s.position,
        queueDepth: s.queueDepth,
        retryAfter: s.pollAt - now,
      });
    }
    return null;
  }

  async ensureSession() {
    for (;;) {
      const now = Date.now();
      const ready = this.readyInstanceID(now);
      if (ready !== undefined) return ready;
      const waitErr = this.waitingError(now);
      if (waitErr) throw waitErr;
      if (this.refreshPromise) {
        await this.refreshPromise;
        continue;
      }
      this.refreshPromise = this.refreshSession().finally(() => { this.refreshPromise = null; });
      await this.refreshPromise;
      this.lastError = '';
    }
  }

  async refreshSession() {
    const current = this.session;
    let state;
    if (current && current.status === 'queued' && current.instanceID) {
      state = await this.client.getSession(this.token, current.instanceID);
    } else {
      state = await this.client.createSession(this.token);
    }

    for (let i = 0; i < 5; i++) {
      const status = String(state.status || '').trim();
      if (status === 'disabled') {
        this.session = { status: 'disabled' };
        return '';
      }
      if (status === 'active') {
        const instanceID = String(state.instanceId || '').trim();
        if (!instanceID) throw new Error('free session active response missing instanceId');
        this.session = {
          status: 'active',
          instanceID,
          expiresAt: parseTime(state.expiresAt),
        };
        return instanceID;
      }
      if (status === 'queued') {
        const instanceID = String(state.instanceId || '').trim();
        if (!instanceID) throw new Error('free session queued response missing instanceId');
        this.logQueuePosition(state);
        const delay = queuedPollDelay(state);
        this.session = {
          status: 'queued',
          instanceID,
          position: Math.max(state.position || 0, 1),
          queueDepth: Math.max(state.queueDepth || 0, Math.max(state.position || 0, 1)),
          pollAt: Date.now() + delay,
          retryAfter: delay,
        };
        return '';
      }
      if (status === 'none' || status === 'ended' || status === 'superseded') {
        state = await this.client.createSession(this.token);
        continue;
      }
      throw new Error(`unexpected free session status "${state.status}"`);
    }
    throw new Error('free session refresh did not settle');
  }

  logQueuePosition(state) {
    const parts = [];
    if (state.queueDepth > 0) parts.push(`position ${state.position}/${state.queueDepth}`);
    else if (state.position > 0) parts.push(`position ${state.position}`);
    if (state.estimatedWaitMs > 0) parts.push(`~${formatWait(state.estimatedWaitMs)} remaining`);
    this.logger.log(`${this.name}: waiting room: ${parts.length ? parts.join(', ') : 'queued'}`);
  }

  invalidate(reason) {
    this.session = null;
    if (reason) this.lastError = reason;
  }

  async endSession() {
    this.session = null;
    await this.client.endSession(this.token);
  }

  snapshot() {
    const s = this.session;
    return {
      status: s ? s.status : null,
      instance_id: s ? s.instanceID : null,
      expires_at: s && s.expiresAt ? new Date(s.expiresAt).toISOString() : null,
      position: s ? s.position : null,
      queue_depth: s ? s.queueDepth : null,
      poll_at: s && s.pollAt ? new Date(s.pollAt).toISOString() : null,
      last_error: this.lastError || null,
    };
  }
}

function parseTime(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

function queuedPollDelay(state) {
  if (!state.estimatedWaitMs || state.estimatedWaitMs <= 0) return FREE_SESSION_POLL_INTERVAL;
  const delay = state.estimatedWaitMs;
  if (delay < 1000) return 1000;
  if (delay > FREE_SESSION_POLL_INTERVAL) return FREE_SESSION_POLL_INTERVAL;
  return delay;
}

function formatWait(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  return `${min} min`;
}

module.exports = { FreeSession, WaitingRoomError };
