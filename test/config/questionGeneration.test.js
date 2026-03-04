'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { getQuestionGenConfig } = require('../../config/questionGeneration');

describe('config/questionGeneration', () => {
  const envKey = 'BFT_QUESTION_LLM_TIMEOUT_MS';

  it('returns { timeoutMs } when valid positive number', () => {
    const prev = process.env[envKey];
    process.env[envKey] = '20000';
    try {
      const config = getQuestionGenConfig();
      assert.strictEqual(config.timeoutMs, 20000);
    } finally {
      if (prev !== undefined) process.env[envKey] = prev;
      else delete process.env[envKey];
    }
  });

  it('throws when BFT_QUESTION_LLM_TIMEOUT_MS is missing', () => {
    const prev = process.env[envKey];
    delete process.env[envKey];
    try {
      assert.throws(
        () => getQuestionGenConfig(),
        /BFT_QUESTION_LLM_TIMEOUT_MS is required/
      );
    } finally {
      if (prev !== undefined) process.env[envKey] = prev;
    }
  });

  it('throws when BFT_QUESTION_LLM_TIMEOUT_MS is empty string', () => {
    const prev = process.env[envKey];
    process.env[envKey] = '';
    try {
      assert.throws(
        () => getQuestionGenConfig(),
        /BFT_QUESTION_LLM_TIMEOUT_MS is required/
      );
    } finally {
      if (prev !== undefined) process.env[envKey] = prev;
      else delete process.env[envKey];
    }
  });

  it('throws when BFT_QUESTION_LLM_TIMEOUT_MS is not a positive number', () => {
    const prev = process.env[envKey];
    try {
      process.env[envKey] = 'abc';
      assert.throws(
        () => getQuestionGenConfig(),
        /must be a positive number/
      );
      process.env[envKey] = '0';
      assert.throws(
        () => getQuestionGenConfig(),
        /must be a positive number/
      );
    } finally {
      if (prev !== undefined) process.env[envKey] = prev;
      else delete process.env[envKey];
    }
  });
});
