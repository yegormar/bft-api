/**
 * LLM configuration for Built for Tomorrow assessment (interview Q&A).
 * All values must be set in .env; no code defaults. See env.example.
 * Invalid or missing required vars cause process exit when this module is loaded.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function exit(message) {
  console.error('[config/llm]', message);
  process.exit(1);
}

const providerRaw = (process.env.LLM_PROVIDER || process.env.OLLAMA_MODE || '').toLowerCase();
if (!providerRaw) {
  exit('LLM_PROVIDER (or OLLAMA_MODE) is required. Set it in .env: ollama (local) or ollama_cloud.');
}
const provider = providerRaw === 'cloud' ? 'ollama_cloud' : providerRaw;
const validProviders = ['ollama', 'ollama_cloud'];
if (!validProviders.includes(provider)) {
  exit(`LLM_PROVIDER must be ollama or ollama_cloud. Got: ${providerRaw}`);
}

const isOllamaCloud = provider === 'ollama_cloud';
const isOllama = provider === 'ollama' || isOllamaCloud;

const baseUrl = process.env.LLM_BASE_URL || process.env.OLLAMA_BASE_URL || null;
if ((!baseUrl || baseUrl.trim() === '')) {
  exit('LLM_BASE_URL (or OLLAMA_BASE_URL) is required. Set it in .env.');
}

const apiKey = process.env.LLM_API_KEY || process.env.OLLAMA_API_KEY || null;
if (isOllamaCloud && (!apiKey || apiKey.trim() === '')) {
  exit('LLM_API_KEY (or OLLAMA_API_KEY) is required for ollama_cloud. Set it in .env.');
}

const model = process.env.LLM_MODEL || process.env.OLLAMA_MODEL || null;
if (!model || model.trim() === '') {
  exit('LLM_MODEL (or OLLAMA_MODEL) is required. Set it in .env.');
}

if (isOllamaCloud && process.env.LLM_WEB_SEARCH === undefined) {
  exit('LLM_WEB_SEARCH is required for ollama_cloud. Set it in .env (true or false).');
}
const webSearchRaw = process.env.LLM_WEB_SEARCH;
const webSearch = webSearchRaw !== undefined && (webSearchRaw === 'true' || webSearchRaw === '1');

const temperatureRaw = process.env.LLM_TEMPERATURE;
if (temperatureRaw === undefined || temperatureRaw === '') {
  exit('LLM_TEMPERATURE is required. Set it in .env (e.g. 0.5).');
}
const temperature = parseFloat(temperatureRaw, 10);
if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
  exit(`LLM_TEMPERATURE must be a number between 0 and 2. Got: ${temperatureRaw}`);
}

const maxTokensRaw = process.env.LLM_MAX_TOKENS;
if (maxTokensRaw === undefined || maxTokensRaw === '') {
  exit('LLM_MAX_TOKENS is required. Set it in .env (e.g. 32768).');
}
const maxTokens = parseInt(maxTokensRaw, 10);
if (Number.isNaN(maxTokens) || maxTokens < 1) {
  exit(`LLM_MAX_TOKENS must be a positive integer. Got: ${maxTokensRaw}`);
}

const topPRaw = process.env.LLM_TOP_P;
if (topPRaw === undefined || topPRaw === '') {
  exit('LLM_TOP_P is required. Set it in .env (e.g. 0.9).');
}
const topP = parseFloat(topPRaw, 10);
if (Number.isNaN(topP) || topP < 0 || topP > 1) {
  exit(`LLM_TOP_P must be a number between 0 and 1. Got: ${topPRaw}`);
}

const numCtxRaw = (process.env.LLM_NUM_CTX || process.env.OLLAMA_NUM_CTX || '').trim();
if (numCtxRaw === '') {
  exit('LLM_NUM_CTX (or OLLAMA_NUM_CTX) is required. Set it in .env (e.g. 32768).');
}
const numCtx = parseInt(numCtxRaw, 10);
if (Number.isNaN(numCtx) || numCtx < 1) {
  exit(`LLM_NUM_CTX (or OLLAMA_NUM_CTX) must be a positive integer. Got: ${numCtxRaw}`);
}

/** Optional. When set, file must exist at that path. No fallback. Not used by current two-step scenario flow. */
const systemPromptFileRaw = (process.env.LLM_SYSTEM_PROMPT_FILE || '').trim();
let systemPromptFile = systemPromptFileRaw || null;
if (systemPromptFile) {
  const systemPromptPath = path.isAbsolute(systemPromptFile)
    ? systemPromptFile
    : path.join(PROJECT_ROOT, systemPromptFile);
  if (!fs.existsSync(systemPromptPath)) {
    exit(`LLM_SYSTEM_PROMPT_FILE does not exist: ${systemPromptPath}`);
  }
}

const handoffSystemPromptFile = (process.env.LLM_HANDOFF_SYSTEM_PROMPT_FILE || '').trim();
if (handoffSystemPromptFile) {
  const handoffPath = path.isAbsolute(handoffSystemPromptFile)
    ? handoffSystemPromptFile
    : path.join(PROJECT_ROOT, handoffSystemPromptFile);
  if (!fs.existsSync(handoffPath)) {
    exit(`LLM_HANDOFF_SYSTEM_PROMPT_FILE does not exist: ${handoffPath}`);
  }
}

const reportProfileSystemPromptFile = (process.env.LLM_REPORT_PROFILE_SYSTEM_PROMPT_FILE || '').trim();
if (!reportProfileSystemPromptFile) {
  exit('LLM_REPORT_PROFILE_SYSTEM_PROMPT_FILE is required. Set it in .env (e.g. conf/report_profile_system_prompt.txt).');
}
const reportProfilePath = path.isAbsolute(reportProfileSystemPromptFile)
  ? reportProfileSystemPromptFile
  : path.join(PROJECT_ROOT, reportProfileSystemPromptFile);
if (!fs.existsSync(reportProfilePath)) {
  exit(`LLM_REPORT_PROFILE_SYSTEM_PROMPT_FILE does not exist: ${reportProfilePath}`);
}

// Required. Path to AI-era context file appended to report profile prompt. Set to empty to disable. Must be present in .env (see .env.example).
if (process.env.LLM_REPORT_AI_CONTEXT_FILE === undefined) {
  exit('LLM_REPORT_AI_CONTEXT_FILE must be set in .env. Use empty value to disable, or path (e.g. conf/report_ai_context.txt). See .env.example.');
}
const reportAiContextFile = (process.env.LLM_REPORT_AI_CONTEXT_FILE || '').trim();

// Required. For GPT-OSS: use "low"|"medium"|"high". For other thinking models: true/false (or 0, 1, no, off).
const thinkRaw = (process.env.LLM_THINK || process.env.OLLAMA_THINK || '').trim().toLowerCase();
if (thinkRaw === '') {
  exit('LLM_THINK (or OLLAMA_THINK) is required. Set it in .env (e.g. false or low).');
}
const validThink = ['low', 'medium', 'high', 'true', 'false', '0', '1', 'no', 'off'];
if (!validThink.includes(thinkRaw)) {
  exit(`LLM_THINK must be one of: low, medium, high, true, false. Got: ${process.env.LLM_THINK || process.env.OLLAMA_THINK}`);
}
const thinkLevelRaw = (process.env.LLM_THINK_LEVEL || '').trim().toLowerCase();
const thinkLevelFromEnv = ['low', 'medium', 'high'].includes(thinkLevelRaw) ? thinkLevelRaw : null;
const thinkFallback = thinkRaw;
const thinkLevel = thinkLevelFromEnv || (['low', 'medium', 'high'].includes(thinkFallback) ? thinkFallback : undefined);
const think = (thinkLevel === undefined) ? !['false', '0', 'no', 'off'].includes(thinkFallback) : undefined;

const checkupIntervalSecRaw = (process.env.LLM_CHECKUP_INTERVAL_SEC || '').trim();
if (checkupIntervalSecRaw === '') {
  exit('LLM_CHECKUP_INTERVAL_SEC is required. Set it in .env (e.g. 180).');
}
const checkupIntervalSec = parseInt(checkupIntervalSecRaw, 10);
if (Number.isNaN(checkupIntervalSec) || checkupIntervalSec < 1) {
  exit(`LLM_CHECKUP_INTERVAL_SEC must be a positive integer. Got: ${checkupIntervalSecRaw}`);
}

function resolveProjectPath(relativePath) {
  if (!relativePath) return null;
  const normalized = path.isAbsolute(relativePath) ? relativePath : path.join(PROJECT_ROOT, relativePath);
  return normalized;
}

function loadPromptFile(relativePath) {
  const filePath = resolveProjectPath(relativePath);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

const llm = {
  provider,
  baseUrl,
  apiKey,
  model,
  webSearch,
  temperature,
  maxTokens,
  topP,
  numCtx,
  /** For GPT-OSS: "low"|"medium"|"high" when LLM_THINK is low/medium/high. */
  thinkLevel,
  /** For other thinking models (Qwen, DeepSeek): true/false from LLM_THINK. Ignored when model is GPT-OSS. */
  think,
  systemPromptFile: systemPromptFile || null,
  handoffSystemPromptFile: handoffSystemPromptFile || null,
  reportProfileSystemPromptFile,
  reportAiContextFile,
  /** Seconds between periodic LLM checkups (keep-alive). From LLM_CHECKUP_INTERVAL_SEC. */
  checkupIntervalSec,

  get enabled() {
    if (!this.model) return false;
    if (isOllamaCloud && !this.apiKey) return false;
    return true;
  },

  getSystemPrompt() {
    return this.systemPromptFile ? loadPromptFile(this.systemPromptFile) : null;
  },

  getHandoffSystemPrompt() {
    return this.handoffSystemPromptFile ? loadPromptFile(this.handoffSystemPromptFile) : null;
  },

  getReportProfileSystemPrompt() {
    return reportProfileSystemPromptFile ? loadPromptFile(reportProfileSystemPromptFile) : null;
  },

  /** Resolved path to AI-era context file (appended to report profile prompt when path non-empty). Returns null when LLM_REPORT_AI_CONTEXT_FILE is empty (disabled). */
  getReportAiContextPath() {
    return reportAiContextFile ? resolveProjectPath(reportAiContextFile) : null;
  },

  resolveProjectPath,
};

module.exports = llm;
