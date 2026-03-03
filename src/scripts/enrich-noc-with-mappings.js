#!/usr/bin/env node
/**
 * NOC Enrichment Preparation Script
 *
 * Enriches each NOC 2021 occupation with LLM-generated mappings to skills, traits, and values
 * (high compatibility only, rating 1–5). Validates IDs against the data files; on invalid IDs
 * sends one correction request to the LLM, then re-validates.
 *
 * Run from bft-api project root or from src/scripts (e.g. node enrich-noc-with-mappings.js):
 *   node src/scripts/enrich-noc-with-mappings.js [--debug] [--input path] [--output path] [--limit N] [--noc CODE]
 * .env is loaded from ../../.env (bft-api/.env) relative to this script.
 *
 * If output file exists, occupations already present (by nocCode) are skipped (resume).
 * If an occupation fails after max retries (or any LLM error), it is skipped and not written; on the next run it will be reprocessed.
 * Use --limit N (or NOC_ENRICHMENT_LIMIT) to process only the first N occupations and exit (e.g. for testing).
 * Use --noc CODE (or NOC_ENRICHMENT_NOC) to process only the occupation with that nocCode (e.g. 00010).
 *
 * Uses .env for LLM config: LLM_PROVIDER, LLM_BASE_URL, LLM_MODEL, LLM_API_KEY (for cloud),
 * LLM_TEMPERATURE, LLM_MAX_TOKENS, LLM_TOP_P. Optional: NOC_JSON_INPUT, NOC_JSON_OUTPUT,
 * NOC_ENRICHMENT_SYSTEM_PROMPT_FILE, NOC_ENRICHMENT_LIMIT, NOC_LLM_DELAY_MS, NOC_LLM_REQUEST_TIMEOUT_MS, NOC_LLM_MAX_RETRIES, DEBUG.
 * See env.example.
 *
 * Local (e.g. RTX 3090 24GB): if a 27B+ model hangs or OOMs, use a smaller model
 * (e.g. qwen2.5-coder:14b, deepseek-r1:14b) or set LLM_NUM_CTX=8192 to reduce VRAM.
 */

const fs = require('fs');
const path = require('path');

/** Request timeout in ms; env NOC_LLM_TIMEOUT_MS overrides. Prevents indefinite hang when model is slow or OOM. */
const DEFAULT_LLM_TIMEOUT_MS = 300000; // 5 minutes

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  const result = require('dotenv').config({ path: envPath, override: true });
  if (result.error && process.env.DEBUG) {
    console.error('[enrich-noc] .env load error:', result.error.message);
  }
} else {
  require('dotenv').config({ override: true });
}

const DEFAULT_SYSTEM_PROMPT = `You are a mapping assistant. You will receive a JSON object with:

1. **occupation** – One NOC (National Occupational Classification) job, with only these fields (use them to judge fit):
   - **name**: Job title.
   - **nocCode**: Classification code.
   - **mainDuties**: What people in this job typically do (tasks and responsibilities). Base your mapping primarily on this.
   - **employmentRequirements**: What is required to get this job (education, experience, credentials).
   - **additionalInformation**: Exclusions, mobility, or other official notes about the role.

2. **skills**, **traits**, **values** – Reference lists. Each item has id, name, and description. Use only these IDs.

Your task: Output ONLY a single JSON object (no markdown, no explanation) with this structure:
{
  "skills": [ { "id": "<skill_id>", "compatibilityRating": <integer> }, ... ],
  "traits": [ { "id": "<trait_id>", "compatibilityRating": <integer> }, ... ],
  "values": [ { "id": "<value_id>", "compatibilityRating": <integer> }, ... ]
}

Rules:
- Be **highly selective**. Most jobs are defined by a small set of skills and even fewer traits and values. Prefer fewer, high-confidence items over padding the list.
  - **skills**: Pick only the 0–5 most defining skills for this occupation (not everything that could apply).
  - **traits**: Pick only 0–3 traits that best predict who fits this work.
  - **values**: Pick only 0–3 values that this occupation most strongly satisfies.
- **compatibilityRating**: Use the integer you believe (1–5). Only include items you would rate 4 or 5; omit anything you would rate 3 or below. Use 5 for the strongest matches, 4 for clear but slightly weaker—do not default everything to 5.
- Every "id" MUST be exactly one of the IDs from the corresponding list in the input. Do not invent or modify IDs.
- **Matching**: Prefer the most specific match to the day-to-day work in mainDuties. For example: repetitive, well-defined tasks (operate equipment, follow procedures, clean, replace parts) → routine_execution; breaking down complex problems and planning steps → structured_problem_solving. When two items both fit, choose the one that matches mainDuties more directly.
- Reply with nothing but the JSON object.`;

function exit(message) {
  console.error('[enrich-noc]', message);
  process.exit(1);
}

/** Max length for description sent to LLM; keeps "Distinct from..." in most entries. */
const MAX_DESC_LENGTH = 320;

/**
 * Condense description for LLM: first 2 sentences or up to MAX_DESC_LENGTH chars, truncating at a sentence boundary when possible.
 */
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
 * Massage a list of items (skills, traits, values) for LLM input: id, name, and a condensed description only.
 */
function massageForLlm(arr) {
  return (arr || []).map((o) => ({
    id: o.id,
    name: o.name,
    description: condenseDescription(o.description),
  }));
}

/**
 * Append valid IDs to the system prompt so the LLM can copy them exactly and avoid invalid IDs.
 */
function augmentSystemPromptWithValidIds(systemPrompt, validSkillIds, validTraitIds, validValueIds) {
  const skillList = [...validSkillIds].sort().join(', ');
  const traitList = [...validTraitIds].sort().join(', ');
  const valueList = [...validValueIds].sort().join(', ');
  return `${systemPrompt.trim()}

Valid IDs (use only these exact strings in your JSON):
- skills: ${skillList}
- traits: ${traitList}
- values: ${valueList}`;
}

function getLlmConfig() {
  const baseUrl = (process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || '').trim();
  if (!baseUrl) exit('LLM_BASE_URL (or OLLAMA_BASE_URL) is required. Set it in .env.');

  const model = (process.env.LLM_MODEL || process.env.OLLAMA_MODEL || '').trim();
  if (!model) exit('LLM_MODEL (or OLLAMA_MODEL) is required. Set it in .env.');

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
      'LLM_API_KEY (or OLLAMA_API_KEY) is required for ollama_cloud. Set it in .env (bft-api/.env), or set LLM_API_KEY_FILE to a file path containing the key.'
    );
  }

  const tempRaw = process.env.LLM_TEMPERATURE || process.env.OLLAMA_TEMPERATURE;
  if (tempRaw === undefined || tempRaw === '') exit('LLM_TEMPERATURE is required. Set it in .env.');
  const temperature = parseFloat(tempRaw, 10);
  if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) exit(`LLM_TEMPERATURE must be 0-2. Got: ${tempRaw}`);

  const maxRaw = process.env.LLM_MAX_TOKENS || process.env.OLLAMA_MAX_TOKENS;
  if (maxRaw === undefined || maxRaw === '') exit('LLM_MAX_TOKENS is required. Set it in .env.');
  const maxTokens = parseInt(maxRaw, 10);
  if (Number.isNaN(maxTokens) || maxTokens < 1) exit(`LLM_MAX_TOKENS must be a positive integer. Got: ${maxRaw}`);

  const topPRaw = process.env.LLM_TOP_P || process.env.OLLAMA_TOP_P;
  if (topPRaw === undefined || topPRaw === '') exit('LLM_TOP_P is required. Set it in .env.');
  const topP = parseFloat(topPRaw, 10);
  if (Number.isNaN(topP) || topP < 0 || topP > 1) exit(`LLM_TOP_P must be 0-1. Got: ${topPRaw}`);

  const numCtxRaw = (process.env.LLM_NUM_CTX || process.env.OLLAMA_NUM_CTX || '').trim();
  const numCtx = numCtxRaw === '' ? null : (() => {
    const n = parseInt(numCtxRaw, 10);
    if (Number.isNaN(n) || n < 1) exit(`LLM_NUM_CTX (or OLLAMA_NUM_CTX) must be a positive integer when set. Got: ${numCtxRaw}`);
    return n;
  })();

  const thinkRaw = (process.env.LLM_THINK || process.env.OLLAMA_THINK || '').trim().toLowerCase();
  const think = thinkRaw === '' ? undefined : !['false', '0', 'no', 'off'].includes(thinkRaw);

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    model,
    apiKey: isCloud ? apiKeyRaw : null,
    temperature,
    maxTokens,
    topP,
    numCtx,
    think,
  };
}

function logEnvHint(envPathUsed) {
  const providerRaw = (process.env.LLM_PROVIDER || process.env.OLLAMA_MODE || 'ollama').toLowerCase();
  const isCloud = providerRaw === 'cloud' || providerRaw === 'ollama_cloud';
  if (!isCloud) return;
  const key = (process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || '').trim();
  console.error('[enrich-noc] .env:', envPathUsed, '|', isCloud ? `API key: ${key ? 'set' : 'NOT SET'}` : '');
}

function getScriptConfig() {
  const args = process.argv.slice(2);
  const debug = process.env.DEBUG === '1' || process.env.DEBUG === 'true' || args.includes('--debug');
  const inputIdx = args.indexOf('--input');
  const outputIdx = args.indexOf('--output');
  const inputFromEnv = (process.env.NOC_JSON_INPUT || '').trim();
  const outputFromEnv = (process.env.NOC_JSON_OUTPUT || '').trim();

  const input = inputIdx >= 0 && args[inputIdx + 1]
    ? path.resolve(process.cwd(), args[inputIdx + 1])
    : (inputFromEnv ? path.resolve(PROJECT_ROOT, inputFromEnv) : path.join(PROJECT_ROOT, 'data', 'noc-2021.json'));
  const output = outputIdx >= 0 && args[outputIdx + 1]
    ? path.resolve(process.cwd(), args[outputIdx + 1])
    : (outputFromEnv ? path.resolve(PROJECT_ROOT, outputFromEnv) : path.join(PROJECT_ROOT, 'data', 'noc-2021-enriched.json'));

  const promptFile = (process.env.NOC_ENRICHMENT_SYSTEM_PROMPT_FILE || '').trim();
  const systemPromptPath = promptFile
    ? (path.isAbsolute(promptFile) ? promptFile : path.join(PROJECT_ROOT, promptFile))
    : null;

  const limitIdx = args.indexOf('--limit');
  const limitArg = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : NaN;
  const limitEnv = process.env.NOC_ENRICHMENT_LIMIT ? parseInt(process.env.NOC_ENRICHMENT_LIMIT, 10) : NaN;
  const limit = (!Number.isNaN(limitArg) && limitArg > 0) ? limitArg : (!Number.isNaN(limitEnv) && limitEnv > 0) ? limitEnv : null;

  const nocIdx = args.indexOf('--noc');
  const nocArg = nocIdx >= 0 && args[nocIdx + 1] ? String(args[nocIdx + 1]).trim() : '';
  const nocEnv = (process.env.NOC_ENRICHMENT_NOC || '').trim();
  const nocId = nocArg || nocEnv || null;

  const delayRaw = (process.env.NOC_LLM_DELAY_MS || '').trim();
  const delayMs = delayRaw === '' ? 0 : (() => {
    const n = parseInt(delayRaw, 10);
    if (Number.isNaN(n) || n < 0) return 0;
    return n;
  })();

  return { debug, input, output, systemPromptPath, limit, nocId, delayMs };
}

function loadSystemPrompt(systemPromptPath) {
  if (systemPromptPath && fs.existsSync(systemPromptPath)) {
    return fs.readFileSync(systemPromptPath, 'utf8').trim();
  }
  return DEFAULT_SYSTEM_PROMPT;
}

function loadExistingOutput(outputPath) {
  if (!fs.existsSync(outputPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    if (!data.occupations || !Array.isArray(data.occupations)) return null;
    const byCode = new Map();
    for (const o of data.occupations) {
      if (o && o.nocCode) byCode.set(o.nocCode, o);
    }
    return { data, byCode };
  } catch {
    return null;
  }
}

function loadData(inputPath) {
  if (!fs.existsSync(inputPath)) exit(`NOC input file not found: ${inputPath}`);
  let noc;
  try {
    noc = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    exit(`Failed to parse NOC JSON: ${e.message}`);
  }
  if (!noc.occupations || !Array.isArray(noc.occupations)) exit('NOC JSON must have an "occupations" array.');

  const skillsPath = path.join(PROJECT_ROOT, 'src', 'data', 'skills.json');
  const traitsPath = path.join(PROJECT_ROOT, 'src', 'data', 'traits.json');
  const valuesPath = path.join(PROJECT_ROOT, 'src', 'data', 'values.json');
  for (const p of [skillsPath, traitsPath, valuesPath]) {
    if (!fs.existsSync(p)) exit(`Data file not found: ${p}`);
  }

  const skillsData = JSON.parse(fs.readFileSync(skillsPath, 'utf8'));
  const traitsData = JSON.parse(fs.readFileSync(traitsPath, 'utf8'));
  const valuesData = JSON.parse(fs.readFileSync(valuesPath, 'utf8'));

  const skills = skillsData.skills || [];
  const traits = traitsData.traits || [];
  const values = valuesData.values || [];

  const validSkillIds = new Set(skills.map((s) => s.id));
  const validTraitIds = new Set(traits.map((t) => t.id));
  const validValueIds = new Set(values.map((v) => v.id));

  return {
    noc,
    skills: massageForLlm(skills),
    traits: massageForLlm(traits),
    values: massageForLlm(values),
    validSkillIds,
    validTraitIds,
    validValueIds,
  };
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
  if (llmConfig.think !== undefined) body.think = llmConfig.think;
  const headers = { 'Content-Type': 'application/json' };
  if (llmConfig.apiKey) headers.Authorization = `Bearer ${llmConfig.apiKey}`;

  if (debug) {
    console.log('\n' + '═'.repeat(70));
    console.log('[enrich-noc] LLM REQUEST');
    console.log('═'.repeat(70));
    console.log('URL:', url);
    console.log('Model:', body.model);
    body.messages.forEach((m, i) => {
      console.log(`\n--- Message ${i} (${m.role}) ---`);
      console.log(m.content);
    });
    console.log('═'.repeat(70) + '\n');
  }

  const requestTimeoutRaw = (process.env.NOC_LLM_REQUEST_TIMEOUT_MS || '').trim();
  const requestTimeoutMs = requestTimeoutRaw === '' ? null : parseInt(requestTimeoutRaw, 10);
  const useRetry = requestTimeoutMs != null && !Number.isNaN(requestTimeoutMs) && requestTimeoutMs > 0;
  const maxRetries = Math.max(1, parseInt(process.env.NOC_LLM_MAX_RETRIES || '3', 10));
  const timeoutMs = useRetry
    ? requestTimeoutMs
    : (parseInt(process.env.NOC_LLM_TIMEOUT_MS || '', 10) || DEFAULT_LLM_TIMEOUT_MS);

  let lastErr;
  for (let attempt = 1; attempt <= (useRetry ? maxRetries : 1); attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
      lastErr = err;
      if (err.name === 'AbortError') {
        if (useRetry && attempt < maxRetries) {
          console.warn(`[enrich-noc] Request timed out after ${timeoutMs / 1000}s, retrying (attempt ${attempt}/${maxRetries})...`);
          continue;
        }
        throw new Error(
          `LLM request timed out after ${timeoutMs / 1000}s${useRetry ? ` (${maxRetries} attempts)` : ''}. Try a smaller model or increase NOC_LLM_REQUEST_TIMEOUT_MS / NOC_LLM_TIMEOUT_MS in .env.`
        );
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text();
      console.error('[enrich-noc] LLM error:', res.status, res.statusText, text.slice(0, 500));
      if (res.status === 401) {
        console.error('[enrich-noc] 401 Unauthorized: check LLM_API_KEY (or OLLAMA_API_KEY) in .env.');
        console.error('[enrich-noc] For Ollama Cloud use a key from https://ollama.com/settings/keys');
        console.error('[enrich-noc] Ensure LLM_PROVIDER=ollama_cloud and the key has no extra spaces or newlines.');
      }
      if (res.status === 404) {
        console.error('[enrich-noc] 404 Model not found: check LLM_MODEL in .env.');
        console.error('[enrich-noc] For Ollama Cloud direct API (https://ollama.com), use a model from https://ollama.com/search?c=cloud (e.g. qwen3.5:cloud).');
      }
      throw new Error(`LLM API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const content = (data.message && data.message.content) || '';

    if (debug) {
      console.log('\n' + '═'.repeat(70));
      console.log('[enrich-noc] LLM RESPONSE');
      console.log('═'.repeat(70));
      try {
        const stripped = content.replace(/```(?:json)?\s*([\s\S]*?)```/, '$1').trim();
        const parsed = JSON.parse(stripped);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(content);
      }
      console.log('═'.repeat(70) + '\n');
    }

    return content;
  }
}

function stripJsonFromResponse(content) {
  let raw = (content || '').trim();
  const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) raw = codeMatch[1].trim();
  return raw;
}

function parseMappings(content) {
  const raw = stripJsonFromResponse(content);
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  const skills = Array.isArray(obj.skills) ? obj.skills : [];
  const traits = Array.isArray(obj.traits) ? obj.traits : [];
  const values = Array.isArray(obj.values) ? obj.values : [];
  return {
    skills: skills.map((s) => ({
      id: s && String(s.id).trim(),
      compatibilityRating: typeof s.compatibilityRating === 'number' ? Math.min(5, Math.max(1, s.compatibilityRating)) : 4,
    })).filter((s) => s.id),
    traits: traits.map((t) => ({
      id: t && String(t.id).trim(),
      compatibilityRating: typeof t.compatibilityRating === 'number' ? Math.min(5, Math.max(1, t.compatibilityRating)) : 4,
    })).filter((t) => t.id),
    values: values.map((v) => ({
      id: v && String(v.id).trim(),
      compatibilityRating: typeof v.compatibilityRating === 'number' ? Math.min(5, Math.max(1, v.compatibilityRating)) : 4,
    })).filter((v) => v.id),
  };
}

function validateMappings(mappings, validSkillIds, validTraitIds, validValueIds) {
  const invalid = { skills: [], traits: [], values: [] };
  for (const s of mappings.skills) {
    if (!validSkillIds.has(s.id)) invalid.skills.push(s.id);
  }
  for (const t of mappings.traits) {
    if (!validTraitIds.has(t.id)) invalid.traits.push(t.id);
  }
  for (const v of mappings.values) {
    if (!validValueIds.has(v.id)) invalid.values.push(v.id);
  }
  const valid = invalid.skills.length === 0 && invalid.traits.length === 0 && invalid.values.length === 0;
  return { valid, invalid };
}

function filterValidOnly(mappings, validSkillIds, validTraitIds, validValueIds) {
  return {
    skills: mappings.skills.filter((s) => validSkillIds.has(s.id)),
    traits: mappings.traits.filter((t) => validTraitIds.has(t.id)),
    values: mappings.values.filter((v) => validValueIds.has(v.id)),
  };
}

const CHECKPOINT_EVERY = 10;

const OLLAMA_CLOUD_HOST = 'ollama.com';

async function validateCloudModel(llmConfig) {
  const isCloudHost = llmConfig.baseUrl && llmConfig.baseUrl.includes(OLLAMA_CLOUD_HOST);
  if (!isCloudHost || !llmConfig.apiKey) return;
  const url = `${llmConfig.baseUrl.replace(/\/$/, '')}/api/tags`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${llmConfig.apiKey}` },
    });
  } catch (e) {
    console.error('[enrich-noc] Could not reach', url, '-', e.message);
    return;
  }
  if (!res.ok) {
    console.error('[enrich-noc]', url, res.status, res.statusText);
    return;
  }
  const data = await res.json().catch(() => ({}));
  const names = (data.models || []).map((m) => m.name || m.model || m).filter(Boolean);
  const exact = names.includes(llmConfig.model);
  if (exact) return;
  const hint = llmConfig.model.toLowerCase().includes('qwen3.5') && names.some((n) => n.toLowerCase().includes('qwen3.5'))
    ? ' (e.g. try LLM_MODEL=qwen3.5:397b for a similar model)'
    : '';
  console.error('[enrich-noc] Model "' + llmConfig.model + '" is not available on Ollama Cloud.' + hint);
  console.error('[enrich-noc] Set LLM_MODEL in .env to one of:');
  names.slice(0, 20).forEach((n) => console.error('[enrich-noc]   -', n));
  if (names.length > 20) console.error('[enrich-noc]   ... and', names.length - 20, 'more. Full list: ' + url);
  exit('Invalid LLM_MODEL for Ollama Cloud. Pick a model from the list above.');
}

function writeOutput(noc, enriched, outputPath) {
  const payload = {
    version: noc.version,
    ...(noc.fetchedAt != null && { fetchedAt: noc.fetchedAt }),
    enrichedAt: new Date().toISOString(),
    occupations: enriched,
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
}

async function main() {
  logEnvHint(fs.existsSync(envPath) ? envPath : '(cwd or default)');
  const scriptConfig = getScriptConfig();
  const llmConfig = getLlmConfig();
  await validateCloudModel(llmConfig);
  let systemPrompt = loadSystemPrompt(scriptConfig.systemPromptPath);
  const { noc, skills, traits, values, validSkillIds, validTraitIds, validValueIds } = loadData(scriptConfig.input);
  systemPrompt = augmentSystemPromptWithValidIds(systemPrompt, validSkillIds, validTraitIds, validValueIds);

  const outDir = path.dirname(scriptConfig.output);
  if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const existing = loadExistingOutput(scriptConfig.output);
  let occupationsToProcess = noc.occupations;
  if (scriptConfig.nocId) {
    occupationsToProcess = noc.occupations.filter((o) => o && o.nocCode === scriptConfig.nocId);
    if (occupationsToProcess.length === 0) {
      exit(`NOC code "${scriptConfig.nocId}" not found in ${scriptConfig.input}. Check --noc / NOC_ENRICHMENT_NOC.`);
    }
  }
  const limit = scriptConfig.limit;
  if (limit != null && limit > 0) {
    occupationsToProcess = occupationsToProcess.slice(0, limit);
  }
  const totalInput = noc.occupations.length;
  const total = occupationsToProcess.length;

  console.log('[enrich-noc] Input:', scriptConfig.input);
  console.log('[enrich-noc] Output:', scriptConfig.output);
  console.log('[enrich-noc] LLM:', llmConfig.baseUrl, '| model:', llmConfig.model, llmConfig.apiKey ? '| auth: set' : '| auth: none', llmConfig.think !== undefined ? `| think: ${llmConfig.think ? 'on' : 'off'}` : '');
  console.log('[enrich-noc] Occupations to process:', total, scriptConfig.nocId ? `(NOC ${scriptConfig.nocId})` : limit != null ? `(limit ${limit})` : `(of ${totalInput})`);
  if (scriptConfig.delayMs > 0) console.log('[enrich-noc] Delay between requests:', scriptConfig.delayMs, 'ms');
  const reqTimeout = (process.env.NOC_LLM_REQUEST_TIMEOUT_MS || '').trim();
  if (reqTimeout) {
    const maxR = process.env.NOC_LLM_MAX_RETRIES || '3';
    console.log('[enrich-noc] Request timeout:', reqTimeout, 'ms; restart on timeout, max', maxR, 'attempts');
  }
  if (existing) console.log('[enrich-noc] Resuming: output exists, skipping already-enriched occupations.');
  console.log('[enrich-noc] Debug:', scriptConfig.debug);

  const enriched = [];
  for (let i = 0; i < total; i++) {
    const occ = occupationsToProcess[i];
    const label = `${occ.nocCode} ${(occ.name || '').slice(0, 50)}`;
    const existingEntry = existing && existing.byCode.get(occ.nocCode);
    if (existingEntry) {
      console.log(`[enrich-noc] Skipping ${i + 1}/${total} (already in output): ${label}`);
      enriched.push(existingEntry);
      if (enriched.length % CHECKPOINT_EVERY === 0) {
        writeOutput(noc, enriched, scriptConfig.output);
        console.log(`[enrich-noc] Checkpoint: wrote ${enriched.length} occupations.`);
      }
      continue;
    }
    console.log(`[enrich-noc] Processing occupation ${i + 1}/${total} (${label})`);

    try {
      const occupationForLlm = {
        name: occ.name,
        nocCode: occ.nocCode,
        mainDuties: occ.mainDuties ?? '',
        employmentRequirements: occ.employmentRequirements ?? '',
        additionalInformation: occ.additionalInformation ?? '',
      };
      const userMessage = JSON.stringify({
        occupation: occupationForLlm,
        skills,
        traits,
        values,
      }, null, 2);

      let content = await callOllama(
        llmConfig,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        scriptConfig.debug
      );

      let mappings = parseMappings(content);
      if (!mappings) {
        console.warn(`[enrich-noc] Failed to parse JSON for ${label}; using empty mappings.`);
        enriched.push({
          ...occ,
          skillMappings: [],
          traitMappings: [],
          valueMappings: [],
        });
      } else {
        let { valid, invalid } = validateMappings(mappings, validSkillIds, validTraitIds, validValueIds);

        if (!valid) {
          const correction = `The following IDs are invalid and must not be used. Use ONLY these exact IDs from the lists I provided earlier.\nInvalid skill IDs you used: ${invalid.skills.join(', ') || 'none'}.\nInvalid trait IDs: ${invalid.traits.join(', ') || 'none'}.\nInvalid value IDs: ${invalid.values.join(', ') || 'none'}.\n\nValid skill IDs: ${[...validSkillIds].join(', ')}.\nValid trait IDs: ${[...validTraitIds].join(', ')}.\nValid value IDs: ${[...validValueIds].join(', ')}.\n\nReply with ONLY the same JSON structure: { "skills": [...], "traits": [...], "values": [...] } with compatibilityRating 4 or 5, using only the valid IDs above.`;
          content = await callOllama(
            llmConfig,
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
              { role: 'user', content: correction },
            ],
            scriptConfig.debug
          );
          mappings = parseMappings(content);
          if (!mappings) {
            mappings = { skills: [], traits: [], values: [] };
          } else {
            const recheck = validateMappings(mappings, validSkillIds, validTraitIds, validValueIds);
            if (!recheck.valid) {
              console.warn(`[enrich-noc] After correction, still invalid IDs for ${label}; keeping only valid entries.`);
              mappings = filterValidOnly(mappings, validSkillIds, validTraitIds, validValueIds);
            }
          }
        }

        enriched.push({
          ...occ,
          skillMappings: mappings.skills,
          traitMappings: mappings.traits,
          valueMappings: mappings.values,
        });
      }

      if (enriched.length % CHECKPOINT_EVERY === 0) {
        writeOutput(noc, enriched, scriptConfig.output);
        console.log(`[enrich-noc] Checkpoint: wrote ${enriched.length} occupations.`);
      }
      if (scriptConfig.delayMs > 0 && i < total - 1) {
        await new Promise((r) => setTimeout(r, scriptConfig.delayMs));
      }
    } catch (err) {
      console.warn(`[enrich-noc] Skipping ${label} after error (will retry on next run):`, err.message);
    }
  }

  let toWrite = enriched;
  if (scriptConfig.nocId && existing && existing.data.occupations.length > 0) {
    const others = existing.data.occupations.filter((o) => o.nocCode !== scriptConfig.nocId);
    toWrite = [...others, ...enriched];
  }
  writeOutput(noc, toWrite, scriptConfig.output);
  console.log('[enrich-noc] Done. Wrote', toWrite.length, 'enriched occupations to', scriptConfig.output);
  if (!scriptConfig.nocId && limit != null && totalInput > limit) {
    console.log('[enrich-noc] Limit was', limit, '; run again without --limit to process remaining', totalInput - limit, 'occupations (output will be merged).');
  }
}

main().catch((err) => {
  console.error('[enrich-noc]', err);
  process.exit(1);
});
