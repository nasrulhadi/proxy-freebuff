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
  constructor({ name, token, client, logger, initialInstanceId, cliOwnerPid, ownerReader }) {
    this.name = name;
    this.token = token;
    this.client = client;
    this.logger = logger;
    this.session = null;
    this.lastError = '';
    this.refreshPromise = null;
    // Optional pre-existing instance (e.g. the Freebuff CLI's active session)
    // to adopt instead of creating a new one - respects the single-session
    // per account policy.
    this.initialInstanceId = initialInstanceId || null;
    // PID of the CLI that owns that instance (from freebuff-instance-owner.json).
    // While it is alive we must never create a competing session.
    this.cliOwnerPid = cliOwnerPid || null;
    // Re-reads freebuff-instance-owner.json on every refresh so a CLI restart
    // (new pid + instance) is picked up instead of trusting a stale snapshot.
    this.ownerReader = typeof ownerReader === 'function' ? ownerReader : null;
    // True only when WE created the session (CLI was not running). Sessions
    // we adopted belong to the CLI and must never be DELETEd by us - doing so
    // logs the CLI out.
    this.createdByUs = false;
    // Set when a competing session creation was refused; persists so later
    // requests can't sneak a POST past the refusal.
    this.refuseMessage = null;
    this.currentModel = '';
  }

  readyInstanceID(now, model) {
    const s = this.session;
    if (!s) return undefined;
    if (s.status === 'disabled') return '';
    if (s.status === 'active') {
      if (!s.instanceID) return undefined;
      if (model && s.model && s.model !== model) return undefined; // model-bound
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

  async ensureSession(model) {
    if (model) this.currentModel = model;
    for (;;) {
      const now = Date.now();
      const ready = this.readyInstanceID(now, this.currentModel);
      if (ready !== undefined) return ready;
      const waitErr = this.waitingError(now);
      if (waitErr) throw waitErr;
      if (this.refreshPromise) {
        await this.refreshPromise;
        continue;
      }
      this.refreshPromise = this.refreshSession(this.currentModel).finally(() => { this.refreshPromise = null; });
      await this.refreshPromise;
      this.lastError = '';
    }
  }

  async refreshSession(model) {
    // A refusal persists while the CLI is alive, but lifts if the CLI
    // process has since exited so the proxy can take over.
    if (this.refuseMessage) {
      const owner = this.ownerReader ? this.ownerReader() : null;
      const pid = (owner && owner.pid) || this.cliOwnerPid;
      if (isProcessAlive(pid)) throw new Error(this.refuseMessage);
      this.refuseMessage = null;
    }
    const current = this.session;

    // Fresh owner info: the CLI rewrites freebuff-instance-owner.json when
    // its session changes (restart, rotation, new conversation), so re-read
    // it on every refresh instead of trusting the startup snapshot.
    const owner = this.ownerReader ? this.ownerReader() : null;
    const ownerInstance = (owner && owner.instanceId) || this.initialInstanceId;
    const ownerPid = (owner && owner.pid) || this.cliOwnerPid;
    const cliAlive = isProcessAlive(ownerPid);

    const refuse = (message) => {
      this.refuseMessage = message;
      throw new Error(message);
    };

    // While the CLI process is alive we only adopt or refresh ITS session -
    // never POST a competing one (creating a session supersedes the CLI's and
    // logs it out). We GET the instance to poll its status/expiry; this also
    // picks up a CLI restart, because the owner file is re-read above.
    if (cliAlive) {
      // Prefer the owner file's CURRENT instance: if the CLI restarted and
      // rotated to a new instance, adopt that one instead of polling a stale
      // cached instance (which would read as superseded and refuse forever).
      const currentID = current && current.instanceID;
      const instanceID = ownerInstance && ownerInstance !== currentID ? ownerInstance : currentID || ownerInstance;
      if (!instanceID) {
        return refuse('Freebuff CLI is running but no session instance was recorded - refusing to create a competing session (stop the CLI or retry)');
      }
      let state;
      try {
        state = await this.client.getSession(this.token, instanceID);
      } catch (e) {
        this.logger.logErr(`${this.name}: adopt session check failed (${e.message})`);
        return refuse('Freebuff CLI is running and its session could not be verified - refusing to create a competing session (stop the CLI or retry)');
      }
      const status = String((state && state.status) || '').trim();
      const stateInstanceID = String((state && state.instanceId) || '').trim();
      const stateModel = String((state && state.model) || '').trim();
      if (status === 'active' && stateInstanceID) {
        if (model && stateModel && stateModel !== model) {
          return refuse(`CLI session is for model ${stateModel} but ${model} was requested - use ${stateModel} or stop the CLI`);
        }
        this.createdByUs = false;
        this.session = { status: 'active', instanceID: stateInstanceID, expiresAt: parseTime(state.expiresAt), model: stateModel };
        this.logger.log(`${this.name}: adopted existing freebuff session ${stateInstanceID}`);
        return stateInstanceID;
      }
      if (status === 'queued' && stateInstanceID) {
        this.logQueuePosition(state);
        const delay = queuedPollDelay(state);
        this.session = {
          status: 'queued',
          instanceID: stateInstanceID,
          position: Math.max(state.position || 0, 1),
          queueDepth: Math.max(state.queueDepth || 0, Math.max(state.position || 0, 1)),
          pollAt: Date.now() + delay,
          retryAfter: delay,
        };
        return '';
      }
      if (status === 'disabled') {
        // No instance needed; requests proceed without the header.
        this.createdByUs = false;
        this.session = { status: 'disabled' };
        return '';
      }
      return refuse(`CLI session ${stateInstanceID || instanceID} is not adoptable (status ${status || 'unknown'}) - refusing to create a competing session (restart the CLI or stop it)`);
    }

    // CLI is not running: we may create (and own) a session for the proxy.
    let state;
    if (current && current.status === 'queued' && current.instanceID) {
      state = await this.client.getSession(this.token, current.instanceID);
    } else {
      this.createdByUs = true;
      state = await this.client.createSession(this.token, model);
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
          model: String(state.model || '').trim(),
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
        state = await this.client.createSession(this.token, model);
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
    const instanceID = this.session && this.session.instanceID;
    this.session = null;
    if (!this.createdByUs) {
      // The session belongs to the CLI (or we never created one). DELETing it
      // would log the CLI out, so leave it alone.
      if (instanceID) this.logger.log(`${this.name}: not ending session ${instanceID} - it belongs to the CLI`);
      return;
    }
    await this.client.endSession(this.token, instanceID);
  }

  snapshot() {
    const s = this.session;
    return {
      status: s ? s.status : null,
      instance_id: s ? s.instanceID : null,
      model: s ? s.model || null : null,
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

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

module.exports = { FreeSession, WaitingRoomError };
