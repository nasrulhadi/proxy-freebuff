'use strict';

const fs = require('fs');
const path = require('path');

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m' };

function createLogger(logPath) {
  const logFile = fs.createWriteStream(logPath, { flags: 'a' });

  function writeLog(level, msg) {
    const ts = `[${new Date().toISOString()}]`;
    const colors = { req: C.cyan, upstream: C.green, done: C.bold, error: C.yellow, default: C.reset };
    const c = colors[level] || C.reset;
    const tag = level ? `${c}${level}${C.reset}` : '';
    const full = `${C.dim}${ts}${C.reset} ${tag ? `[${tag}] ` : ''}${msg}`;
    process.stdout.write(full + '\n');
    logFile.write(`${ts}${tag ? ` [${level}] ` : ' '}${msg}\n`);
  }

  const logReq = (...a) => writeLog('req', a.join(' '));
  const logUp = (...a) => writeLog('upstream', a.join(' '));
  const logDone = (...a) => writeLog('done', a.join(' '));
  const logErr = (...a) => writeLog('error', a.join(' '));
  const log = (...a) => writeLog('', a.join(' '));

  function banner(rows) {
    const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const pad = (s, w) => s + ' '.repeat(Math.max(0, w - strip(s).length));
    const L = (s) => `${C.bold}${s}${C.reset}`;

    const title = `${C.cyan}${C.bold}Proxy Freebuff${C.reset}`;
    const sub = `${C.dim}OpenAI/Anthropic → codebuff.com free agents${C.reset}`;
    const all = [title, sub, ...rows];
    const w = Math.max(...all.map((s) => strip(s).length));
    const box = (s) => `${C.cyan}\u2502${C.reset}  ${pad(s, w)}  ${C.cyan}\u2502${C.reset}`;

    console.log(`${C.cyan}\u250c${'\u2500'.repeat(w + 4)}\u2510${C.reset}`);
    console.log(box(title));
    console.log(box(sub));
    console.log(`${C.cyan}\u251c${'\u2500'.repeat(w + 4)}\u2524${C.reset}`);
    for (const r of rows) console.log(box(r));
    console.log(`${C.cyan}\u2514${'\u2500'.repeat(w + 4)}\u2518${C.reset}`);
  }

  return { banner, log, logReq, logUp, logDone, logErr, end: () => logFile.end() };
}

module.exports = { createLogger, C };
