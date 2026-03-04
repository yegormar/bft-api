'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const questionStore = require('../src/services/questionStore');

function makeTmpDir() {
  const tmpDir = path.join(os.tmpdir(), `bft-qstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

describe('questionStore', () => {
  describe('getProfileKey', () => {
    it('returns same key for same profile object', () => {
      const profile = { dominant: ['creative'], secondaryTone: 'adventurous', demographics: {} };
      const a = questionStore.getProfileKey(profile);
      const b = questionStore.getProfileKey(profile);
      assert.strictEqual(a, b);
    });

    it('returns same key for same profile with different key order', () => {
      const p1 = { dominant: ['creative'], secondaryTone: 'adventurous' };
      const p2 = { secondaryTone: 'adventurous', dominant: ['creative'] };
      assert.strictEqual(questionStore.getProfileKey(p1), questionStore.getProfileKey(p2));
    });

    it('returns 16-char hex string', () => {
      const key = questionStore.getProfileKey({ dominant: ['x'] });
      assert.match(key, /^[a-f0-9]{16}$/);
    });

    it('handles null and empty object', () => {
      const kNull = questionStore.getProfileKey(null);
      const kEmpty = questionStore.getProfileKey({});
      assert.strictEqual(kNull, kEmpty);
    });
  });

  describe('computeContentHash', () => {
    it('returns same hash for same question', () => {
      const q = { title: 'Test?', options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }] };
      assert.strictEqual(questionStore.computeContentHash(q), questionStore.computeContentHash(q));
    });

    it('different option order produces same hash (options sorted by text)', () => {
      const q1 = { title: 'X', options: [{ text: 'B', value: 'b' }, { text: 'A', value: 'a' }] };
      const q2 = { title: 'X', options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }] };
      assert.strictEqual(questionStore.computeContentHash(q1), questionStore.computeContentHash(q2));
    });

    it('different title produces different hash', () => {
      const q1 = { title: 'A', options: [{ text: 'X', value: 'x' }] };
      const q2 = { title: 'B', options: [{ text: 'X', value: 'x' }] };
      assert.notStrictEqual(questionStore.computeContentHash(q1), questionStore.computeContentHash(q2));
    });

    it('handles missing options', () => {
      const hash = questionStore.computeContentHash({ title: 'Only title' });
      assert.ok(typeof hash === 'string' && hash.length > 0);
    });
  });

  describe('save and listByProfile', () => {
    it('save is no-op when storeDir is null', () => {
      assert.doesNotThrow(() => {
        questionStore.save(null, 'abc123', { title: 'Q', options: [] }, [], null);
      });
    });

    it('saves and lists one question', () => {
      const tmpDir = makeTmpDir();
      try {
        const profileKey = questionStore.getProfileKey({ dominant: ['test'] });
        const question = { title: 'Stored question?', type: 'single_choice', options: [{ text: 'Yes', value: 'y' }] };
        const dimensionSet = [{ dimensionType: 'aptitude', dimensionId: 'logical_analytical_reasoning' }];
        questionStore.save(tmpDir, profileKey, question, dimensionSet, 'Summary');
        const list = questionStore.listByProfile(tmpDir, profileKey);
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].question.title, question.title);
        assert.deepStrictEqual(list[0].dimensionSet, dimensionSet);
        assert.strictEqual(list[0].assessmentSummary, 'Summary');
        assert.ok(list[0].createdAt);
        assert.strictEqual(list[0].contentHash, questionStore.computeContentHash(question));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('listByProfile returns [] when storeDir is null', () => {
      assert.deepStrictEqual(questionStore.listByProfile(null, 'any'), []);
    });

    it('listByProfile returns [] for missing profile dir', () => {
      const tmpDir = makeTmpDir();
      try {
        assert.deepStrictEqual(questionStore.listByProfile(tmpDir, 'nonexistent'), []);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('sorts listed questions by createdAt ascending', () => {
      const tmpDir = makeTmpDir();
      try {
        const profileKey = 'pk1';
        const q1 = { title: 'First', options: [{ text: 'A', value: 'a' }] };
        const q2 = { title: 'Second', options: [{ text: 'B', value: 'b' }] };
        questionStore.save(tmpDir, profileKey, q1, [], null);
        questionStore.save(tmpDir, profileKey, q2, [], null);
        const list = questionStore.listByProfile(tmpDir, profileKey);
        assert.strictEqual(list.length, 2);
        assert.ok(new Date(list[0].createdAt) <= new Date(list[1].createdAt));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('getUsedSet and markUsed', () => {
    it('getUsedSet returns empty set when storeDir is null and no prior markUsed', () => {
      const uid = 'user-' + Date.now();
      const used = questionStore.getUsedSet(null, uid);
      assert.ok(used instanceof Set);
      assert.strictEqual(used.size, 0);
    });

    it('markUsed (no storeDir) adds to in-memory set and getUsedSet returns it', () => {
      const uid = 'user-mem-' + Date.now();
      const hash = 'abc123hash';
      questionStore.markUsed(null, uid, hash);
      const used = questionStore.getUsedSet(null, uid);
      assert.ok(used.has(hash));
    });

    it('markUsed with storeDir persists and getUsedSet reads it', () => {
      const tmpDir = makeTmpDir();
      try {
        const uid = 'user-file-' + Date.now();
        const hash = 'def456hash';
        questionStore.markUsed(tmpDir, uid, hash);
        const used = questionStore.getUsedSet(tmpDir, uid);
        assert.ok(used.has(hash));
        const filePath = path.join(tmpDir, 'used', `${uid}.json`);
        assert.ok(fs.existsSync(filePath));
        const raw = fs.readFileSync(filePath, 'utf8');
        const arr = JSON.parse(raw);
        assert.ok(Array.isArray(arr) && arr.includes(hash));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('multiple markUsed for same user accumulate', () => {
      const tmpDir = makeTmpDir();
      try {
        const uid = 'user-multi-' + Date.now();
        questionStore.markUsed(tmpDir, uid, 'h1');
        questionStore.markUsed(tmpDir, uid, 'h2');
        const used = questionStore.getUsedSet(tmpDir, uid);
        assert.ok(used.has('h1') && used.has('h2'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
