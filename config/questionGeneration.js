/**
 * Config for the question generation component (FIFO queue, LLM timeout, store fallback).
 * Required when the component is used (e.g. assessment next-question flow).
 * No defaults in code: BFT_QUESTION_LLM_TIMEOUT_MS must be set in .env.
 */

function getQuestionGenConfig() {
  const raw = process.env.BFT_QUESTION_LLM_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    throw new Error(
      'BFT_QUESTION_LLM_TIMEOUT_MS is required for question generation. Set it in .env (see .env.example).'
    );
  }
  const timeoutMs = parseInt(raw, 10);
  if (Number.isNaN(timeoutMs) || timeoutMs < 1) {
    throw new Error(
      `BFT_QUESTION_LLM_TIMEOUT_MS must be a positive number. Got: ${raw}`
    );
  }
  return { timeoutMs };
}

module.exports = { getQuestionGenConfig };
