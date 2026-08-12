'use strict';

const crypto = require('crypto');
const { FreeSession } = require('./sessions');

class RunManager {
  constructor({ name, token, client, logger, rotationMs, initialInstanceId, cliOwnerPid, ownerReader }) {
    this.name = name;
    this.token = token;
    this.client = client;
    this.logger = logger;
    this.rotationMs = rotationMs;
    this.session = new FreeSession({ name, token, client, logger, initialInstanceId, cliOwnerPid, ownerReader });
    this.runs = new Map();
    this.draining = [];
    this.cooldownUntil = 0;
    this.lastError = '';
    // Dedupes repeated maintain-tick session failures (e.g. a persistent
    // refusal while the CLI is alive) so the log doesn't spam every 60s.
    this.lastMaintainErr = '';
  }

  async acquire(agentID, model) {
    if (Date.now() < this.cooldownUntil) {
      throw new Error(`token cooling down until ${new Date(this.cooldownUntil).toISOString()}`);
    }
    let run = this.runs.get(agentID);
    const needsRotate = !run || Date.now() - run.startedAt >= this.rotationMs;
    if (needsRotate) await this.rotateAgent(agentID);
    await this.session.ensureSession(model);
    run = this.runs.get(agentID);
    if (!run) throw new Error('run missing after rotation');
    run.inflight++;
    run.requestCount++;
    return { run };
  }

  async rotateAgent(agentID) {
    if (Date.now() < this.cooldownUntil) {
      throw new Error(`token cooling down until ${new Date(this.cooldownUntil).toISOString()}`);
    }
    const runId = await this.client.startRun(this.token, agentID);
    const oldRun = this.runs.get(agentID);
    // traceSessionId is minted once per run and reused across its requests,
    // exactly like the CLI (run.ts: previousRun?.traceSessionId ?? randomUUID).
    this.runs.set(agentID, { id: runId, agentID, startedAt: Date.now(), inflight: 0, requestCount: 0, finishing: false, traceSessionId: crypto.randomUUID() });
    this.lastError = '';
    if (oldRun) {
      this.draining.push(oldRun);
      this.finishIfReady(oldRun).catch((e) => this.logger.logErr(`${this.name}: finish rotated run ${oldRun.id} (${agentID}) failed: ${e.message}`));
    }
  }

  async ensureSession(model) {
    return this.session.ensureSession(model);
  }

  release(run) {
    if (!run) return;
    if (run.inflight > 0) run.inflight--;
    this.finishIfReady(run).catch((e) => this.logger.logErr(`${this.name}: finish released run ${run.id} failed: ${e.message}`));
  }

  invalidate(agentID, reason) {
    const run = this.runs.get(agentID);
    if (run) this.runs.delete(agentID);
    this.draining = this.draining.filter((r) => r !== run);
    if (reason) this.lastError = reason;
  }

  invalidateSession(reason) {
    this.session.invalidate(reason);
  }

  markCooldown(durationMs, reason) {
    this.cooldownUntil = Date.now() + durationMs;
    if (reason) this.lastError = reason;
  }

  async finishIfReady(run) {
    if (!run || run.inflight > 0 || run.finishing) return;
    const current = this.runs.get(run.agentID);
    if (current === run) return;
    run.finishing = true;
    try {
      await this.client.finishRun(this.token, run.id, run.requestCount);
      this.draining = this.draining.filter((r) => r !== run);
    } catch (e) {
      run.finishing = false;
      this.lastError = e.message;
      throw e;
    }
  }

  async maintain() {
    try {
      await this.session.ensureSession();
      this.lastMaintainErr = '';
    } catch (e) {
      const msg = `${this.name}: refresh free session failed: ${e.message}`;
      if (msg !== this.lastMaintainErr) {
        this.logger.logErr(msg);
        this.lastMaintainErr = msg;
      }
    }
    const toRotate = [];
    for (const [agentID, run] of this.runs) {
      if (Date.now() - run.startedAt >= this.rotationMs) toRotate.push(agentID);
    }
    for (const agentID of toRotate) {
      try {
        await this.rotateAgent(agentID);
      } catch (e) {
        this.logger.logErr(`${this.name}: rotate agent ${agentID} failed: ${e.message}`);
      }
    }
    for (const run of [...this.draining]) {
      try {
        await this.finishIfReady(run);
      } catch (e) {
        this.logger.logErr(`${this.name}: finish draining run ${run.id} failed: ${e.message}`);
      }
    }
  }

  async shutdown() {
    const allRuns = [...this.runs.values(), ...this.draining];
    this.runs.clear();
    this.draining = [];
    const errors = [];
    for (const run of allRuns) {
      try {
        await this.client.finishRun(this.token, run.id, run.requestCount);
      } catch (e) {
        errors.push(e.message);
      }
    }
    try {
      await this.session.endSession();
    } catch (e) {
      errors.push(e.message);
    }
    if (errors.length) this.logger.logErr(`${this.name}: shutdown: ${errors.join('; ')}`);
  }

  snapshot() {
    return {
      name: this.name,
      session: this.session.snapshot(),
      runs: [...this.runs.values()].map((r) => ({
        agent_id: r.agentID,
        run_id: r.id,
        started_at: new Date(r.startedAt).toISOString(),
        inflight: r.inflight,
        request_count: r.requestCount,
      })),
      draining_runs: this.draining.length,
      cooldown_until: this.cooldownUntil ? new Date(this.cooldownUntil).toISOString() : null,
      last_error: this.lastError || null,
    };
  }
}

module.exports = { RunManager };
