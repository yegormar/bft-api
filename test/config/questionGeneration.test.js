'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const envKey = 'BFT_QUESTION_LLM_TIMEOUT_MS';

/** Run getQuestionGenConfig() in a subprocess with given env; returns { status, stderr }. envOverrides: keys set to null are omitted. */
function runConfigInSubprocess(envOverrides = {}) {
  const base = { ...process.env };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === null) delete base[k];
    else base[k] = String(v);
  }
  const child = spawnSync(
    process.execPath,
    ['-e', "require('./config/questionGeneration').getQuestionGenConfig()"],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: base,
      encoding: 'utf8',
    }
  );
  return { status: child.status, signal: child.signal, stderr: child.stderr || '' };
}

describe('config/questionGeneration', () => {
  it('returns { timeoutMs } when valid positive number', () => {
    const prev = process.env[envKey];
    process.env[envKey] = '20000';
    try {
      const { getQuestionGenConfig } = require('../../config/questionGeneration');
      const config = getQuestionGenConfig();
      assert.strictEqual(config.timeoutMs, 20000);
    } finally {
      if (prev !== undefined) process.env[envKey] = prev;
      else delete process.env[envKey];
    }
  });

  it('process exits when BFT_QUESTION_LLM_TIMEOUT_MS is missing', () => {
    const result = runConfigInSubprocess({ [envKey]: null });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /BFT_QUESTION_LLM_TIMEOUT_MS is required/);
  });

  it('process exits when BFT_QUESTION_LLM_TIMEOUT_MS is empty string', () => {
    const result = runConfigInSubprocess({ [envKey]: '' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /BFT_QUESTION_LLM_TIMEOUT_MS is required/);
  });

  it('process exits when BFT_QUESTION_LLM_TIMEOUT_MS is not a positive number', () => {
    const resultAbc = runConfigInSubprocess({ [envKey]: 'abc' });
    assert.strictEqual(resultAbc.status, 1);
    assert.match(resultAbc.stderr, /must be a positive number/);
    const resultZero = runConfigInSubprocess({ [envKey]: '0' });
    assert.strictEqual(resultZero.status, 1);
    assert.match(resultZero.stderr, /must be a positive number/);
  });
});
