#!/usr/bin/env node
/**
 * Dimension-to-Skills Mapping Generator
 *
 * Uses an LLM to generate dimension_skill_weights: for each dimension (aptitudes, traits, values),
 * produces a mapping of skill_id -> weight (0-1). Validates JSON and that no dimension/skill ids
 * are invented; on validation failure sends one correction request to the LLM, then re-validates.
 *
 * Run from bft-api project root or from src/scripts:
 *   node src/scripts/generate-dimension-skill-mapping.js [--debug] [--output path] [--limit N] [--dimension-id ID]
 *
 * Config: script loads bft-api/.env then src/scripts/.env_skills (override). Prompt path and LLM_*
 * go in .env_skills. See src/scripts/env_skills.example. Output path is hardcoded unless --output is passed.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LLM_TIMEOUT_MS = 300000;
const DEFAULT_OUTPUT_PATH = path.join(path.resolve(__dirname, '..', '..', 'src', 'data'), 'dimension_skill_mapping_generated.json');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = __dirname;
const DATA_DIR = path.join(PROJECT_ROOT, 'src', 'data');
const ENV_SKILLS_PATH = path.join(SCRIPTS_DIR, '.env_skills');
const projectEnvPath = path.join(PROJECT_ROOT, '.env');

if (fs.existsSync(projectEnvPath)) {
  require('dotenv').config({ path: projectEnvPath });
}
if (fs.existsSync(ENV_SKILLS_PATH)) {
  require('dotenv').config({ path: ENV_SKILLS_PATH, override: true });
}

const DEFAULT_SYSTEM_PROMPT = `You are an expert at mapping psychological and cognitive dimensions to skills. You will receive a dimension and a list of skills. Output a single JSON object with the dimension id as the only key and an object mapping each skill id to a weight in [0, 1]. Use only the dimension id and skill ids from the input. Include every skill id exactly once. Reply with nothing but the JSON object.`;

function exit(message) {
  console.error('[dimension-skill-mapping]', message);
  process.exit(1);
}

const MAX_DESC_LENGTH = 320;

function condenseDescription(text) {
  if (!text || typeof text !== 'string') return '';
  const s = text.trim();
  if (!s) return '';
  const sentenceEnd = /[.!?]\s+/g;
  let match;
  let lastEnd = 0;
  let count = 0;
  while ((match = sentenceEnd.exec(s)) !== null && count < 2) {
    lastEnd = match.index + match[0].length;
    count++;
  }
  let out = count >= 2 ? s.slice(0, lastEnd).trim() : s;
  if (out.length <= MAX_DESC_LENGTH) return out;
  out = s.slice(0, MAX_DESC_LENGTH);
  const lastSentence = /[.!?]\s+[^.!?]*$/;
  const m = out.match(lastSentence);
  if (m) out = out.slice(0, out.length - m[0].length).trim();
  return out;
}

/**
 * Build a dimension payload for the LLM with all useful fields. Long text fields are condensed.
 */
function dimensionForLlm(raw) {
  const d = {
    id: raw.id,
    name: raw.name,
    short_label: raw.short_label,
    description: condenseDescription(raw.description),
    ai_future_rationale: raw.ai_future_rationale || '',
    how_measured_or_observed: raw.how_measured_or_observed || '',
  };
  if (raw.scenario_constraint) {
    d.scenario_constraint = condenseDescription(raw.scenario_constraint);
  }
  if (raw.question_hints && Array.isArray(raw.question_hints)) {
    d.question_hints = raw.question_hints;
  }
  if (raw.score_scale && typeof raw.score_scale === 'object') {
    d.score_scale = {
      min: raw.score_scale.min,
      max: raw.score_scale.max,
      interpretation: raw.score_scale.interpretation || {},
    };
  }
  return d;
}

function getLlmConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) exit('LLM_BASE_URL (or OLLAMA_BASE_URL) is required. Set it in scripts/.env_skills (see scripts/env_skills.example).');

  const model = (process.env.LLM_MODEL || process.env.OLLAMA_MODEL || '').trim();
  if (!model) exit('LLM_MODEL (or OLLAMA_MODEL) is required. Set it in scripts/.env_skills (see scripts/env_skills.example).');

  const providerRaw = (process.env.LLM_PROVIDER || process.env.OLLAMA_MODE || 'ollama').toLowerCase();
  const provider = providerRaw === 'cloud' ? 'ollama_cloud' : providerRaw;
  const isCloud = provider === 'ollama_cloud';
  let apiKeyRaw = (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || '').trim();
  if (isCloud && !apiKeyRaw && process.env.LLM_API_KEY_FILE) {
    const keyPath = path.isAbsolute(process.env.LLM_API_KEY_FILE)
      ? process.env.LLM_API_KEY_FILE
      : path.resolve(PROJECT_ROOT, process.env.LLM_API_KEY_FILE);
    if (fs.existsSync(keyPath)) {
      apiKeyRaw = fs.readFileSync(keyPath, 'utf8').trim();
    }
  }
  if (isCloud && !apiKeyRaw) {
    exit(
      'LLM_API_KEY (or OLLAMA_API_KEY) is required for ollama_cloud. Set it in scripts/.env_skills (see scripts/env_skills.example), or set LLM_API_KEY_FILE to a file path containing the key.'
    );
  }

  const tempRaw = process.env.LLM_TEMPERATURE || process.env.OLLAMA_TEMPERATURE;
  if (tempRaw === undefined || tempRaw === '') exit('LLM_TEMPERATURE is required. Set it in scripts/.env_skills (see scripts/env_skills.example).');
  const temperature = parseFloat(tempRaw, 10);
  if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) exit(`LLM_TEMPERATURE must be 0-2. Got: ${tempRaw}`);

  const maxRaw = process.env.LLM_MAX_TOKENS || process.env.OLLAMA_MAX_TOKENS;
  if (maxRaw === undefined || maxRaw === '') exit('LLM_MAX_TOKENS is required. Set it in scripts/.env_skills (see scripts/env_skills.example).');
  const maxTokens = parseInt(maxRaw, 10);
  if (Number.isNaN(maxTokens) || maxTokens < 1) exit(`LLM_MAX_TOKENS must be a positive integer. Got: ${maxRaw}`);

  const topPRaw = process.env.LLM_TOP_P || process.env.OLLAMA_TOP_P;
  if (topPRaw === undefined || topPRaw === '') exit('LLM_TOP_P is required. Set it in scripts/.env_skills (see scripts/env_skills.example).');
  const topP = parseFloat(topPRaw, 10);
  if (Number.isNaN(topP) || topP < 0 || topP > 1) exit(`LLM_TOP_P must be 0-1. Got: ${topPRaw}`);

  const numCtxRaw = (process.env.LLM_NUM_CTX || process.env.OLLAMA_NUM_CTX || '').trim();
  if (numCtxRaw === '') exit('LLM_NUM_CTX (or OLLAMA_NUM_CTX) is required. Set it in scripts/.env_skills (e.g. 32768).');
  const numCtx = parseInt(numCtxRaw, 10);
  if (Number.isNaN(numCtx) || numCtx < 1) exit(`LLM_NUM_CTX (or OLLAMA_NUM_CTX) must be a positive integer. Got: ${numCtxRaw}`);

  const thinkRaw = (process.env.LLM_THINK || process.env.OLLAMA_THINK || '').trim().toLowerCase();
  if (thinkRaw === '') exit('LLM_THINK (or OLLAMA_THINK) is required. Set it in scripts/.env_skills (see scripts/env_skills.example).');
  const validThink = ['low', 'medium', 'high', 'true', 'false', '0', '1', 'no', 'off'];
  if (!validThink.includes(thinkRaw)) exit(`LLM_THINK must be one of: low, medium, high, true, false. Got: ${process.env.LLM_THINK || process.env.OLLAMA_THINK}`);
  const thinkLevelRaw = (process.env.LLM_THINK_LEVEL || '').trim().toLowerCase();
  const thinkLevel = thinkLevelRaw && ['low', 'medium', 'high'].includes(thinkLevelRaw) ? thinkLevelRaw : (['low', 'medium', 'high'].includes(thinkRaw) ? thinkRaw : undefined);
  const think = thinkLevel === undefined ? !['false', '0', 'no', 'off'].includes(thinkRaw) : undefined;

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    model,
    apiKey: isCloud ? apiKeyRaw : null,
    temperature,
    maxTokens,
    topP,
    numCtx,
    thinkLevel,
    think,
  };
}

function getScriptConfig() {
  const args = process.argv.slice(2);
  const debug = process.env.DEBUG === '1' || process.env.DEBUG === 'true' || args.includes('--debug');
  const outputIdx = args.indexOf('--output');
  const output = outputIdx >= 0 && args[outputIdx + 1]
    ? path.resolve(process.cwd(), args[outputIdx + 1])
    : DEFAULT_OUTPUT_PATH;

  const promptFile = (process.env.GENERATE_DIMENSION_SKILL_MAPPING_PROMPT_FILE || '').trim();
  if (!promptFile) {
    exit('GENERATE_DIMENSION_SKILL_MAPPING_PROMPT_FILE must be set in scripts/.env_skills (e.g. prompts/dimension_skill_mapping_system_prompt.txt). See scripts/env_skills.example.');
  }
  const systemPromptPath = path.isAbsolute(promptFile)
    ? promptFile
    : path.join(SCRIPTS_DIR, promptFile);

  const limitIdx = args.indexOf('--limit');
  const limitArg = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : NaN;
  const limit = (!Number.isNaN(limitArg) && limitArg > 0) ? limitArg : null;

  const dimIdIdx = args.indexOf('--dimension-id');
  const dimensionIdFilter = dimIdIdx >= 0 && args[dimIdIdx + 1] ? String(args[dimIdIdx + 1]).trim() : null;

  return { debug, output, systemPromptPath, limit, dimensionIdFilter, delayMs: 0 };
}

function loadSystemPrompt(systemPromptPath) {
  if (!systemPromptPath || !fs.existsSync(systemPromptPath)) {
    exit(`Prompt file not found: ${systemPromptPath}. Set GENERATE_DIMENSION_SKILL_MAPPING_PROMPT_FILE in scripts/.env_skills (path relative to src/scripts). See scripts/env_skills.example.`);
  }
  return fs.readFileSync(systemPromptPath, 'utf8').trim();
}

function loadData() {
  const skillsPath = path.join(DATA_DIR, 'skills.json');
  const traitsPath = path.join(DATA_DIR, 'dimension_traits.json');
  const valuesPath = path.join(DATA_DIR, 'dimension_values.json');
  const aptitudesPath = path.join(DATA_DIR, 'dimension_aptitudes.json');

  for (const p of [skillsPath, traitsPath, valuesPath, aptitudesPath]) {
    if (!fs.existsSync(p)) exit(`Data file not found: ${p}`);
  }

  const skillsData = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
  const traitsData = JSON.parse(fs.readFileSync(traitsPath, 'utf8'));
  const valuesData = JSON.parse(fs.readFileSync(valuesPath, 'utf8'));
  const aptitudesData = JSON.parse(fs.readFileSync(aptitudesPath, 'utf8'));

  const skills = (skillsData.skills || []).map((s) => ({
    id: s.id,
    name: s.name,
    description: condenseDescription(s.description),
  }));

  const validSkillIds = new Set(skills.map((s) => s.id));

  const dimensions = [];
  for (const t of traitsData.traits || []) {
    dimensions.push(dimensionForLlm(t));
  }
  for (const v of valuesData.values || []) {
    dimensions.push(dimensionForLlm(v));
  }
  for (const a of aptitudesData.aptitudes || []) {
    dimensions.push(dimensionForLlm(a));
  }

  const validDimensionIds = new Set(dimensions.map((d) => d.id));

  return { skills, dimensions, validSkillIds, validDimensionIds };
}

function augmentSystemPromptWithValidIds(systemPrompt, validSkillIds) {
  const skillList = [...validSkillIds].sort().join(', ');
  return `${systemPrompt.trim()}

Valid skill IDs (use each exactly once in your output; no other keys allowed): ${skillList}`;
}

async function callOllama(llmConfig, messages, debug) {
  const url = `${llmConfig.baseUrl}/api/chat`;
  const options = {
    temperature: llmConfig.temperature,
    num_predict: llmConfig.maxTokens,
    top_p: llmConfig.topP,
  };
  if (llmConfig.numCtx != null) options.num_ctx = llmConfig.numCtx;
  const body = {
    model: llmConfig.model,
    messages,
    stream: false,
    options,
  };
  const isGptOss = llmConfig.model && llmConfig.model.toLowerCase().includes('gpt-oss');
  if (isGptOss && llmConfig.thinkLevel) body.think = llmConfig.thinkLevel;
  else if (llmConfig.think !== undefined) body.think = llmConfig.think;
  const headers = { 'Content-Type': 'application/json' };
  if (llmConfig.apiKey) headers.Authorization = `Bearer ${llmConfig.apiKey}`;

  if (debug) {
    console.log('\n' + '═'.repeat(70));
    console.log('[dimension-skill-mapping] LLM REQUEST');
    console.log('═'.repeat(70));
    console.log('URL:', url);
    console.log('Model:', body.model);
    body.messages.forEach((m, i) => {
      console.log(`\n--- Message ${i} (${m.role}) ---`);
      console.log(m.content.slice(0, 2000) + (m.content.length > 2000 ? '...' : ''));
    });
    console.log('═'.repeat(70) + '\n');
  }

  const effectiveTimeout = DEFAULT_LLM_TIMEOUT_MS;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${effectiveTimeout / 1000}s.`);
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (!res.ok) {
    const text = await res.text();
    console.error('[dimension-skill-mapping] LLM error:', res.status, res.statusText, text.slice(0, 500));
    throw new Error(`LLM API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const content = (data.message && data.message.content) || '';

  if (debug) {
    console.log('\n[dimension-skill-mapping] LLM RESPONSE (first 1500 chars):', content.slice(0, 1500));
  }

  return content;
}

function stripJsonFromResponse(content) {
  let raw = (content || '').trim();
  const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) raw = codeMatch[1].trim();
  return raw;
}

/**
 * Parse LLM response into { dimensionId, weights }.
 * weights: { skill_id: number } with values clamped to [0, 1].
 * Returns null if not valid JSON or structure wrong.
 */
function parseDimensionWeights(content) {
  const raw = stripJsonFromResponse(content);
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return null;
  const dimensionId = keys[0];
  const inner = obj[dimensionId];
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return null;

  const weights = {};
  for (const [skillId, val] of Object.entries(inner)) {
    const n = typeof val === 'number' ? val : parseFloat(val);
    const w = Number.isNaN(n) ? 0 : Math.max(0, Math.min(1, n));
    weights[String(skillId).trim()] = w;
  }
  return { dimensionId, weights };
}

/**
 * Validate: dimensionId matches expected; all keys in weights are valid skill ids; all skill ids present; values in [0,1].
 * Returns { valid: boolean, errors: string[] }.
 */
function validateDimensionWeights(parsed, expectedDimensionId, validSkillIds) {
  const errors = [];
  if (parsed.dimensionId !== expectedDimensionId) {
    errors.push(`Dimension id must be "${expectedDimensionId}" but got "${parsed.dimensionId}". Do not invent or change the dimension id.`);
  }
  const invalidSkillIds = Object.keys(parsed.weights).filter((id) => !validSkillIds.has(id));
  if (invalidSkillIds.length > 0) {
    errors.push(`Invalid or invented skill ids: ${invalidSkillIds.join(', ')}. Use only skill ids from the list provided.`);
  }
  const missingSkillIds = [...validSkillIds].filter((id) => !Object.prototype.hasOwnProperty.call(parsed.weights, id));
  if (missingSkillIds.length > 0) {
    errors.push(`Missing skill ids (every skill must appear exactly once): ${missingSkillIds.slice(0, 10).join(', ')}${missingSkillIds.length > 10 ? ' ... and ' + (missingSkillIds.length - 10) + ' more' : ''}.`);
  }
  const invalidValues = Object.entries(parsed.weights).filter(([, w]) => typeof w !== 'number' || w < 0 || w > 1);
  if (invalidValues.length > 0) {
    errors.push(`All weights must be numbers in [0, 1]. Found invalid entries.`);
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Normalize weights: ensure every validSkillId has a key; clamp values to [0,1]. Use 0 for any missing.
 */
function normalizeWeights(weights, validSkillIds) {
  const out = {};
  for (const id of validSkillIds) {
    const v = weights[id];
    const n = typeof v === 'number' ? v : parseFloat(v);
    out[id] = Number.isNaN(n) ? 0 : Math.max(0, Math.min(1, n));
  }
  return out;
}

const OUTPUT_DESCRIPTION = 'Compatibility mapping between measured dimensions (aptitudes, traits, values) and skills. Each dimension id maps to an object of skill_id -> weight (0-1). All skill applicability calculation is based only on this file: applicability = weighted average of dimension means (1-5) by these weights. Band is for display/labels only and is not used in skill calculation.';

async function main() {
  console.log('[dimension-skill-mapping] Loading config and data...');
  const scriptConfig = getScriptConfig();
  const llmConfig = getLlmConfig();
  let systemPrompt = loadSystemPrompt(scriptConfig.systemPromptPath);
  const { skills, dimensions, validSkillIds, validDimensionIds } = loadData();
  systemPrompt = augmentSystemPromptWithValidIds(systemPrompt, validSkillIds);

  let dimensionsToProcess = dimensions;
  if (scriptConfig.dimensionIdFilter) {
    dimensionsToProcess = dimensions.filter((d) => d.id === scriptConfig.dimensionIdFilter);
    if (dimensionsToProcess.length === 0) {
      exit(`Dimension id "${scriptConfig.dimensionIdFilter}" not found. Check --dimension-id.`);
    }
  }
  if (scriptConfig.limit != null && scriptConfig.limit > 0) {
    dimensionsToProcess = dimensionsToProcess.slice(0, scriptConfig.limit);
  }

  const total = dimensionsToProcess.length;
  console.log('[dimension-skill-mapping] Output:', scriptConfig.output);
  console.log('[dimension-skill-mapping] LLM:', llmConfig.baseUrl, '| model:', llmConfig.model);
  console.log('[dimension-skill-mapping] Dimensions to process:', total, scriptConfig.dimensionIdFilter ? `(id: ${scriptConfig.dimensionIdFilter})` : scriptConfig.limit != null ? `(limit ${scriptConfig.limit})` : `(of ${dimensions.length})`);
  if (scriptConfig.delayMs > 0) console.log('[dimension-skill-mapping] Delay between requests:', scriptConfig.delayMs, 'ms');
  console.log('[dimension-skill-mapping] Debug:', scriptConfig.debug);

  const dimension_skill_weights = {};

  for (let i = 0; i < total; i++) {
    const dim = dimensionsToProcess[i];
    const label = `${dim.id} (${(dim.name || '').slice(0, 40)})`;
    console.log(`[dimension-skill-mapping] [${i + 1}/${total}] Processing: ${label}`);

    const userMessage = JSON.stringify({
      dimension: dim,
      skills,
    }, null, 2);

    let content;
    try {
      content = await callOllama(
        llmConfig,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        scriptConfig.debug
      );
    } catch (err) {
      console.error(`[dimension-skill-mapping] [${i + 1}/${total}] LLM call failed for ${dim.id}:`, err.message);
      continue;
    }

    let parsed = parseDimensionWeights(content);
    if (!parsed) {
      console.warn(`[dimension-skill-mapping] [${i + 1}/${total}] Invalid JSON for ${dim.id}; requesting correction...`);
      const correctionMessage = `Your previous response was not valid JSON in the required form. Required: a single JSON object with exactly one key (the dimension id "${dim.id}") and a value that is an object mapping each skill id to a number in [0, 1]. You must include every skill id from the list exactly once. Reply with ONLY that JSON object, no markdown or explanation.`;
      try {
        content = await callOllama(
          llmConfig,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
            { role: 'user', content: correctionMessage },
          ],
          scriptConfig.debug
        );
        parsed = parseDimensionWeights(content);
      } catch (err) {
        console.error(`[dimension-skill-mapping] [${i + 1}/${total}] Correction request failed:`, err.message);
        continue;
      }
    }

    if (!parsed) {
      console.warn(`[dimension-skill-mapping] [${i + 1}/${total}] Still invalid JSON after correction; skipping ${dim.id}.`);
      continue;
    }

    let validation = validateDimensionWeights(parsed, dim.id, validSkillIds);
    if (!validation.valid) {
      console.warn(`[dimension-skill-mapping] [${i + 1}/${total}] Validation failed for ${dim.id}; requesting correction...`, validation.errors);
      const correctionMessage = `Your previous response had these errors:\n${validation.errors.map((e) => '- ' + e).join('\n')}\n\nPlease reply with a single JSON object. The only top-level key must be exactly "${dim.id}". The value must be an object that contains every skill id from the list exactly once, each with a number in [0, 1]. Do not invent any dimension or skill id. Reply with ONLY the JSON object.`;
      try {
        content = await callOllama(
          llmConfig,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
            { role: 'user', content: correctionMessage },
          ],
          scriptConfig.debug
        );
        parsed = parseDimensionWeights(content);
        if (parsed) validation = validateDimensionWeights(parsed, dim.id, validSkillIds);
      } catch (err) {
        console.error(`[dimension-skill-mapping] [${i + 1}/${total}] Correction request failed:`, err.message);
      }
    }

    if (!validation.valid) {
      console.warn(`[dimension-skill-mapping] [${i + 1}/${total}] Still invalid after correction; using normalized weights for ${dim.id}.`);
      const normalized = normalizeWeights(parsed.weights, validSkillIds);
      dimension_skill_weights[dim.id] = normalized;
    } else {
      dimension_skill_weights[dim.id] = normalizeWeights(parsed.weights, validSkillIds);
      console.log(`[dimension-skill-mapping] [${i + 1}/${total}] OK: ${dim.id}`);
    }

    if (scriptConfig.delayMs > 0 && i < total - 1) {
      await new Promise((r) => setTimeout(r, scriptConfig.delayMs));
    }
  }

  const outDir = path.dirname(scriptConfig.output);
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const payload = {
    description: OUTPUT_DESCRIPTION,
    dimension_skill_weights,
  };
  fs.writeFileSync(scriptConfig.output, JSON.stringify(payload, null, 2), 'utf8');
  console.log('[dimension-skill-mapping] Done. Wrote', Object.keys(dimension_skill_weights).length, 'dimensions to', scriptConfig.output);
}

main().catch((err) => {
  console.error('[dimension-skill-mapping]', err);
  process.exit(1);
});
