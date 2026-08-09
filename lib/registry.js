'use strict';

const https = require('https');

const RAW_BASE = 'https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants/';
const SOURCE_FILES = [
  'free-agents.ts',
  'freebuff-model-ids.ts',
  'freebuff-models.ts',
  'gemini.ts',
  'model-config.ts',
];

const FALLBACK = {
  'base2-free': [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'minimax/minimax-m3',
    'openai/gpt-5.6-luna',
    'mimo/mimo-v2.5',
  ],
  'base2-free-minimax-m3': ['minimax/minimax-m3'],
  'base2-free-luna': ['openai/gpt-5.6-luna'],
  'base2-free-deepseek': ['deepseek/deepseek-v4-pro'],
  'base2-free-deepseek-flash': ['deepseek/deepseek-v4-flash'],
  'base2-free-mimo': ['mimo/mimo-v2.5'],
  'base2-free-glm': ['z-ai/glm-5.2'],
  'base2-free-laguna-s-2-1': ['poolside/laguna-s-2.1'],
  'base2-free-laguna-s-2-1-openrouter': ['openrouter/poolside/laguna-s-2.1'],
  'base2-free-ling-3-flash': ['inclusionai/ling-3.0-flash:free'],
  'base2-free-greg-2-ultra': ['crof/greg-2-ultra'],
  'base2-free-greg-2-super': ['crof/greg-2-super'],
  'base2-free-fable': ['anthropic/claude-fable-5'],
  'file-picker': ['google/gemini-2.5-flash-lite'],
  'file-picker-max': ['google/gemini-3.1-flash-lite', 'google/gemini-3.5-flash-lite'],
  'file-lister': ['google/gemini-3.1-flash-lite', 'google/gemini-3.5-flash-lite'],
  'researcher-web': ['google/gemini-3.1-flash-lite', 'google/gemini-3.5-flash-lite'],
  'researcher-docs': ['google/gemini-3.1-flash-lite', 'google/gemini-3.5-flash-lite'],
  'basher': ['google/gemini-3.1-flash-lite', 'google/gemini-3.5-flash-lite'],
  'code-reviewer-lite': ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'mimo/mimo-v2.5'],
};

const RE_LITERAL = /export const\s+([A-Za-z_][A-Za-z0-9_]*)[^=]*?=\s*'((?:[^'\\]|\\.)*)'/gs;
const RE_ALIAS = /export const\s+([A-Za-z_][A-Za-z0-9_]*)[^=]*?=\s*(?!['{0-9nOf])([A-Za-z_][A-Za-z0-9_.]*)\s*(?:as\s+const)?\s*$/gm;
const RE_OBJECT = /export const\s+([A-Za-z_][A-Za-z0-9_]*)[^=]*?=\s*\{([\s\S]*?)\n\}/g;
const RE_SET_CONST = /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)[^=]*?=\s*new\s+Set(?:<[^>]*>)?\(\[([\s\S]*?)\]\)/g;

function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { Accept: 'text/plain', 'User-Agent': 'proxy-freebuff/1.0' },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchText(new URL(res.headers.location, url).toString(), timeoutMs));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`fetch ${url} status ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => { req.destroy(new Error('fetch timeout')); });
    req.on('error', reject);
  });
}

function buildConstantResolver(texts) {
  const literals = {};
  const aliases = {};
  const objects = {};
  const sets = {};
  const allText = texts.join('\n');

  for (const m of allText.matchAll(RE_LITERAL)) literals[m[1]] = m[2];
  for (const m of allText.matchAll(RE_ALIAS)) aliases[m[1]] = m[2];
  for (const m of allText.matchAll(RE_OBJECT)) objects[m[1]] = m[2];
  for (const m of allText.matchAll(RE_SET_CONST)) sets[m[1]] = resolveSetMembers(m[2]);

  function resolveSetMembers(inner) {
    const models = [];
    for (const m of inner.matchAll(/'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*)/g)) {
      if (m[1] != null) models.push(m[1]);
      else models.push(m[2]);
    }
    return models;
  }

  function resolve(name, depth = 0) {
    if (depth > 8) return null;
    if (Object.prototype.hasOwnProperty.call(literals, name)) return literals[name];
    if (!Object.prototype.hasOwnProperty.call(aliases, name)) return null;
    const target = aliases[name];
    if (target.includes('.')) {
      const [obj, prop] = target.split('.', 2);
      if (!Object.prototype.hasOwnProperty.call(objects, obj)) return null;
      const objMatch = objects[obj].match(new RegExp(`\\b${prop}\\s*:\\s*'([^']+)'`));
      return objMatch ? objMatch[1] : null;
    }
    return resolve(target, depth + 1);
  }

  return { resolve, sets };
}

function parseRootAgentMap(text, resolver) {
  const map = {};
  const block = text.match(/export const FREEBUFF_ROOT_AGENT_ID_BY_MODEL[^=]*?=\s*\{([\s\S]*?)\n\}/);
  if (!block) return map;
  for (const m of block[1].matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)\]\s*:\s*'([^']+)'/g)) {
    const model = resolver.resolve(m[1]);
    if (model) map[model] = m[2];
  }
  return map;
}

function parseAgentModels(text, resolver) {
  const agents = {};
  const block = text.match(/export const FREE_MODE_AGENT_MODELS[^=]*?=\s*\{([\s\S]*?)\n\}/);
  if (!block) return agents;
  const inner = block[1];
  for (const m of inner.matchAll(/'([^']+)'\s*:\s*(?:new\s+Set(?:<[^>]*>)?\(\[([\s\S]*?)\]\)|([A-Za-z_][A-Za-z0-9_]*))/g)) {
    const agentID = m[1];
    const models = new Set();
    if (m[2] != null) {
      for (const member of m[2].matchAll(/'([^']+)'|([A-Za-z_][A-Za-z0-9_.]*)/g)) {
        if (member[1] != null) models.add(member[1]);
        else {
          const resolved = resolver.resolve(member[2]);
          if (resolved) models.add(resolved);
        }
      }
    } else {
      const setConst = resolver.sets[m[3]];
      if (setConst) {
        for (const member of setConst) {
          const resolved = resolver.resolve(member);
          models.add(resolved || member);
        }
      }
    }
    if (models.size) agents[agentID] = [...models];
  }
  return agents;
}

function buildModelMapping(agentModels, rootAgentByModel) {
  const modelToAgent = {};
  for (const [model, agent] of Object.entries(rootAgentByModel)) {
    modelToAgent[model] = agent;
  }
  for (const [agent, models] of Object.entries(agentModels)) {
    for (const model of models) {
      if (!modelToAgent[model]) modelToAgent[model] = agent;
    }
  }
  return { modelToAgent, allModels: Object.keys(modelToAgent).sort() };
}

class ModelRegistry {
  constructor({ logger, sourceUrl }) {
    this.logger = logger;
    this.sourceUrl = sourceUrl || RAW_BASE;
    this.agentModels = {};
    this.modelToAgent = {};
    this.allModels = [];
  }

  async refresh() {
    const files = await Promise.all(
      SOURCE_FILES.map((f) => fetchText(this.sourceUrl.endsWith('/') ? this.sourceUrl + f : this.sourceUrl + '/' + f, 30000))
    );
    const agentsText = files[0];
    const resolver = buildConstantResolver(files);
    const rootAgentByModel = parseRootAgentMap(agentsText, resolver);
    const agentModels = parseAgentModels(agentsText, resolver);

    if (!Object.keys(agentModels).length && !Object.keys(rootAgentByModel).length) {
      throw new Error('no free agents found in source');
    }

    const { modelToAgent, allModels } = buildModelMapping(agentModels, rootAgentByModel);
    if (!allModels.length) throw new Error('no models resolved from source');

    this.agentModels = agentModels;
    this.modelToAgent = modelToAgent;
    this.allModels = allModels;
    this.logger.log(`registry: updated ${Object.keys(agentModels).length} agents, ${allModels.length} models`);
    return allModels;
  }

  loadFallback() {
    const { modelToAgent, allModels } = buildModelMapping(FALLBACK, {});
    this.agentModels = FALLBACK;
    this.modelToAgent = modelToAgent;
    this.allModels = allModels;
    this.logger.log(`registry: loaded fallback models (${allModels.length}): ${allModels.join(', ')}`);
  }

  hasModel(model) {
    return Object.prototype.hasOwnProperty.call(this.modelToAgent, model);
  }

  agentForModel(model) {
    return this.modelToAgent[model] || null;
  }

  models() {
    return this.allModels.slice();
  }

  agentIDs() {
    return Object.keys(this.agentModels);
  }
}

module.exports = { ModelRegistry, RAW_BASE };
