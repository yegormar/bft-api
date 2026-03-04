/**
 * Config for the question generation component (FIFO queue, LLM timeout, store fallback).
 * Required when the component is used (e.g. assessment next-question flow).
 * No defaults in code: BFT_QUESTION_LLM_TIMEOUT_MS must be set in .env.
 * Invalid or missing value causes process exit.
 */

function exit(message) {
  console.error('[config/questionGeneration]', message);
  process.exit(1);
}

function getQuestionGenConfig() {
  const raw = process.env.BFT_QUESTION_LLM_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    exit('BFT_QUESTION_LLM_TIMEOUT_MS is required for question generation. Set it in .env (see .env.example).');
  }
  const timeoutMs = parseInt(raw, 10);
  if (Number.isNaN(timeoutMs) || timeoutMs < 1) {
    exit(`BFT_QUESTION_LLM_TIMEOUT_MS must be a positive number. Got: ${raw}`);
  }
  return { timeoutMs };
}

module.exports = { getQuestionGenConfig };
