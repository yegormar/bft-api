/**
 * Config for the question generation component (FIFO queue, LLM timeout, store fallback).
 * Required when the component is used (e.g. assessment next-question flow).
 * No defaults in code: BFT_QUESTION_LLM_TIMEOUT_MS and BFT_SCENARIO_STORE_FIRST must be set in .env.
 * Invalid or missing values cause process exit.
 */

function exit(message) {
  console.error('[config/questionGeneration]', message);
  process.exit(1);
}

function parseBoolean(name, raw) {
  if (raw === undefined || raw === '') {
    exit(`${name} is required. Set to true or false in .env (see env.example).`);
  }
  const s = raw.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  exit(`${name} must be true or false. Got: ${raw}`);
}

function getQuestionGenConfig() {
  const raw = process.env.BFT_QUESTION_LLM_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    exit('BFT_QUESTION_LLM_TIMEOUT_MS is required for question generation. Set it in .env (see env.example).');
  }
  const timeoutMs = parseInt(raw, 10);
  if (Number.isNaN(timeoutMs) || timeoutMs < 1) {
    exit(`BFT_QUESTION_LLM_TIMEOUT_MS must be a positive number. Got: ${raw}`);
  }

  const storeFirst = parseBoolean('BFT_SCENARIO_STORE_FIRST', process.env.BFT_SCENARIO_STORE_FIRST);

  return { timeoutMs, storeFirst };
}

module.exports = { getQuestionGenConfig };
