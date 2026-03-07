'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const timeoutKey = 'BFT_QUESTION_LLM_TIMEOUT_MS';
const storeFirstKey = 'BFT_SCENARIO_STORE_FIRST';

const minimalEnv = { [timeoutKey]: '20000', [storeFirstKey]: 'false' };

/** Run getQuestionGenConfig() in a subprocess with given env; returns { status, stderr }. envOverrides: keys set to null are omitted. */
function runConfigInSubprocess(envOverrides = {}) {
  const base = { ...process.env, ...minimalEnv };
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
  it('returns { timeoutMs, storeFirst } when valid (false)', () => {
    const prevTimeout = process.env[timeoutKey];
    const prevStoreFirst = process.env[storeFirstKey];
    process.env[timeoutKey] = '20000';
    process.env[storeFirstKey] = 'false';
    try {
      const { getQuestionGenConfig } = require('../../config/questionGeneration');
      const config = getQuestionGenConfig();
      assert.strictEqual(config.timeoutMs, 20000);
      assert.strictEqual(config.storeFirst, false);
    } finally {
      if (prevTimeout !== undefined) process.env[timeoutKey] = prevTimeout;
      else delete process.env[timeoutKey];
      if (prevStoreFirst !== undefined) process.env[storeFirstKey] = prevStoreFirst;
      else delete process.env[storeFirstKey];
    }
  });

  it('returns storeFirst true when set to true or 1', () => {
    const prevTimeout = process.env[timeoutKey];
    const prevStoreFirst = process.env[storeFirstKey];
    process.env[timeoutKey] = '20000';
    process.env[storeFirstKey] = '  true  ';
    try {
      const { getQuestionGenConfig } = require('../../config/questionGeneration');
      const config = getQuestionGenConfig();
      assert.strictEqual(config.storeFirst, true);
    } finally {
      if (prevTimeout !== undefined) process.env[timeoutKey] = prevTimeout;
      else delete process.env[timeoutKey];
      if (prevStoreFirst !== undefined) process.env[storeFirstKey] = prevStoreFirst;
      else delete process.env[storeFirstKey];
    }
  });

  it('process exits when BFT_QUESTION_LLM_TIMEOUT_MS is missing', () => {
    const result = runConfigInSubprocess({ [timeoutKey]: null });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /BFT_QUESTION_LLM_TIMEOUT_MS is required/);
  });

  it('process exits when BFT_QUESTION_LLM_TIMEOUT_MS is empty string', () => {
    const result = runConfigInSubprocess({ [timeoutKey]: '' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /BFT_QUESTION_LLM_TIMEOUT_MS is required/);
  });

  it('process exits when BFT_QUESTION_LLM_TIMEOUT_MS is not a positive number', () => {
    const resultAbc = runConfigInSubprocess({ [timeoutKey]: 'abc' });
    assert.strictEqual(resultAbc.status, 1);
    assert.match(resultAbc.stderr, /must be a positive number/);
    const resultZero = runConfigInSubprocess({ [timeoutKey]: '0' });
    assert.strictEqual(resultZero.status, 1);
    assert.match(resultZero.stderr, /must be a positive number/);
  });

  it('process exits when BFT_SCENARIO_STORE_FIRST is missing', () => {
    const result = runConfigInSubprocess({ [storeFirstKey]: null });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /BFT_SCENARIO_STORE_FIRST is required/);
  });

  it('process exits when BFT_SCENARIO_STORE_FIRST is empty string', () => {
    const result = runConfigInSubprocess({ [storeFirstKey]: '' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /BFT_SCENARIO_STORE_FIRST is required/);
  });

  it('process exits when BFT_SCENARIO_STORE_FIRST is invalid', () => {
    const result = runConfigInSubprocess({ [storeFirstKey]: 'yes' });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /must be true or false/);
  });
});
