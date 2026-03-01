/**
 * Low-level client for Ollama chat API (local or cloud).
 * Uses config/llm.js for base URL, API key, model, and generation options.
 */

const llmConfig = require('../../config/llm');

const CHAT_PATH = '/api/chat';

const useOllama =
  llmConfig.enabled &&
  (llmConfig.provider === 'ollama' || llmConfig.provider === 'ollama_cloud');

/**
 * Call Ollama chat API with the given messages.
 * @param {Array<{ role: 'system' | 'user' | 'assistant', content: string }>} messages
 * @param {{ stream?: boolean }} options - stream: false for single response (default)
 * @returns {Promise<{ content: string, done: boolean }>} - message content and done flag
 */
async function chat(messages, options = {}) {
  if (!useOllama) {
    throw new Error('Ollama is not configured or provider is not ollama/ollama_cloud');
  }

  const url = `${llmConfig.baseUrl}${CHAT_PATH}`;
  const headers = {
    'Content-Type': 'application/json',
  };
  if (llmConfig.apiKey) {
    headers.Authorization = `Bearer ${llmConfig.apiKey}`;
  }

  const body = {
    model: llmConfig.model,
    messages,
    stream: false,
    options: {
      temperature: llmConfig.temperature,
      num_predict: llmConfig.maxTokens,
      top_p: llmConfig.topP,
    },
  };

  logRequest(url, body);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`\n${BORDER}`);
    console.error(`[LLM] ERROR  ${new Date().toISOString()}  ${res.status} ${res.statusText}`);
    console.error(`${BORDER}`);
    console.error(text.slice(0, 2000));
    if (text.length > 2000) console.error('... (truncated)');
    console.error(`${BORDER}\n`);
    const err = new Error(`Ollama API error: ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const data = await res.json();
  const content = data.message?.content ?? '';
  const done = data.done ?? true;

  logResponse(content);

  return { content, done };
}

const BORDER = '══════════════════════════════════════════════════════════════';

function logRequest(url, body) {
  const ts = new Date().toISOString();
  console.log(`\n${BORDER}`);
  console.log(`[LLM] REQUEST  ${ts}`);
  console.log(`${BORDER}`);
  console.log(`  URL:    ${url}`);
  console.log(`  Model:  ${body.model}`);
  console.log(`  Options: temperature=${body.options.temperature}, num_predict=${body.options.num_predict}, top_p=${body.options.top_p}`);
  console.log('  ---');
  body.messages.forEach((m, i) => {
    console.log(`  Message[${i}] role: ${m.role}  (${m.content.length} chars)`);
    console.log('  ─────────────────────────────────────────────────────────────');
    console.log(m.content);
    console.log('  ─────────────────────────────────────────────────────────────');
  });
  console.log(`${BORDER}\n`);
}

function logResponse(content) {
  const ts = new Date().toISOString();
  console.log(`\n${BORDER}`);
  console.log(`[LLM] RESPONSE  ${ts}  (${content.length} chars)`);
  console.log(`${BORDER}`);
  let raw = content.trim();
  const codeMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch) raw = codeMatch[1].trim();
  try {
    const parsed = JSON.parse(raw);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(content);
  }
  console.log(`${BORDER}\n`);
}

/**
 * Check if Ollama is configured and reachable (optional quick check).
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  if (!useOllama) return false;
  try {
    const url = `${llmConfig.baseUrl}/api/tags`;
    const headers = {};
    if (llmConfig.apiKey) headers.Authorization = `Bearer ${llmConfig.apiKey}`;
    const res = await fetch(url, { method: 'GET', headers });
    return res.ok;
  } catch {
    return false;
  }
}

/** Config compatible with previous ollama.js shape (for code that checks .enabled, .model, etc.) */
const config = {
  get enabled() {
    return useOllama;
  },
  get baseUrl() {
    return llmConfig.baseUrl;
  },
  get model() {
    return llmConfig.model;
  },
  get provider() {
    return llmConfig.provider;
  },
};

module.exports = {
  chat,
  isAvailable,
  config,
};
