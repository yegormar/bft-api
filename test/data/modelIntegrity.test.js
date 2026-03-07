'use strict';

/**
 * Model integrity tests: validate dimension/skill data and all ID references.
 * Ensures no missing IDs, no duplicate IDs across files, and consistent references
 * in scenarioBatches, ai_relevance_ranking, noc-2021-enriched, and related_skill_clusters.
 */

const path = require('path');
const fs = require('fs');
const { describe, it, before } = require('node:test');
const assert = require('node:assert');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(PROJECT_ROOT, 'src', 'data');

const assessmentModel = require('../../src/data/assessmentModel');

function loadJson(filename) {
  const filePath = path.join(DATA_DIR, filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

describe('data/modelIntegrity', () => {
  let model;
  let validDimensionIds;
  let validSkillIds;
  let traitIds;
  let valueIds;

  before(() => {
    model = assessmentModel.load();
    validDimensionIds = new Set(model.dimensionsById.keys());
    validSkillIds = new Set(model.skills.map((s) => s.id));
    traitIds = new Set(model.traits.map((t) => t.id));
    valueIds = new Set(model.values.map((v) => v.id));
  });

  describe('dimension and skill uniqueness', () => {
    it('every dimension and skill has a non-empty unique id', () => {
      const ids = [...validDimensionIds];
      const empty = ids.filter((id) => !id || typeof id !== 'string' || !id.trim());
      assert.strictEqual(empty.length, 0, `Found empty or invalid ids: ${JSON.stringify(empty)}`);
      const unique = new Set(ids);
      assert.strictEqual(unique.size, ids.length, 'Duplicate ids across all dimensions and skills');
    });

    it('dimension id prefix matches type (aptitude_*, trait_*, value_*)', () => {
      const bad = [];
      model.aptitudes.forEach((a) => {
        if (!a.id.startsWith('aptitude_')) bad.push({ type: 'aptitude', id: a.id });
      });
      model.traits.forEach((t) => {
        if (!t.id.startsWith('trait_')) bad.push({ type: 'trait', id: t.id });
      });
      model.values.forEach((v) => {
        if (!v.id.startsWith('value_')) bad.push({ type: 'value', id: v.id });
      });
      assert.strictEqual(bad.length, 0, `Ids with wrong prefix: ${JSON.stringify(bad)}`);
    });

    it('skill ids do not use dimension prefix (no aptitude_/trait_/value_)', () => {
      const prefixed = model.skills.filter(
        (s) => s.id.startsWith('aptitude_') || s.id.startsWith('trait_') || s.id.startsWith('value_')
      );
      assert.strictEqual(
        prefixed.length,
        0,
        `Skill ids must not use dimension prefix: ${prefixed.map((s) => s.id).join(', ')}`
      );
    });
  });

  describe('required fields', () => {
    const required = ['id', 'name'];

    it('every aptitude has required fields', () => {
      model.aptitudes.forEach((a, i) => {
        required.forEach((field) => {
          assert.ok(a[field] != null && String(a[field]).trim() !== '', `aptitudes[${i}] missing or empty: ${field}`);
        });
      });
    });

    it('every trait has required fields', () => {
      model.traits.forEach((t, i) => {
        required.forEach((field) => {
          assert.ok(t[field] != null && String(t[field]).trim() !== '', `traits[${i}] missing or empty: ${field}`);
        });
      });
    });

    it('every value has required fields', () => {
      model.values.forEach((v, i) => {
        required.forEach((field) => {
          assert.ok(v[field] != null && String(v[field]).trim() !== '', `values[${i}] missing or empty: ${field}`);
        });
      });
    });

    it('every skill has required fields', () => {
      model.skills.forEach((s, i) => {
        required.forEach((field) => {
          assert.ok(s[field] != null && String(s[field]).trim() !== '', `skills[${i}] missing or empty: ${field}`);
        });
      });
    });
  });

  describe('related_skill_clusters', () => {
    it('related_skill_clusters in aptitudes reference existing skill ids', () => {
      const missing = [];
      model.aptitudes.forEach((a) => {
        (a.related_skill_clusters || []).forEach((sid) => {
          if (!validSkillIds.has(sid)) missing.push({ dimension: a.id, skillId: sid });
        });
      });
      assert.strictEqual(missing.length, 0, `Aptitudes reference missing skills: ${JSON.stringify(missing)}`);
    });

    it('related_skill_clusters in traits reference existing skill ids', () => {
      const missing = [];
      model.traits.forEach((t) => {
        (t.related_skill_clusters || []).forEach((sid) => {
          if (!validSkillIds.has(sid)) missing.push({ dimension: t.id, skillId: sid });
        });
      });
      assert.strictEqual(missing.length, 0, `Traits reference missing skills: ${JSON.stringify(missing)}`);
    });

    it('related_skill_clusters in values reference existing skill ids', () => {
      const missing = [];
      model.values.forEach((v) => {
        (v.related_skill_clusters || []).forEach((sid) => {
          if (!validSkillIds.has(sid)) missing.push({ dimension: v.id, skillId: sid });
        });
      });
      assert.strictEqual(missing.length, 0, `Values reference missing skills: ${JSON.stringify(missing)}`);
    });
  });

  describe('scenarioBatches.json', () => {
    it('every batch dimension dimensionId exists in model and dimensionType matches', () => {
      const batches = loadJson('scenarioBatches.json');
      const errors = [];
      (batches.batches || []).forEach((batch) => {
        (batch.dimensions || []).forEach((d) => {
          const dim = model.dimensionsById.get(d.dimensionId);
          if (!dim) {
            errors.push({ batch: batch.id, dimensionId: d.dimensionId, msg: 'missing in model' });
            return;
          }
          const expectedPrefix = d.dimensionType === 'aptitude' ? 'aptitude_' : d.dimensionType === 'trait' ? 'trait_' : 'value_';
          if (!d.dimensionId.startsWith(expectedPrefix)) {
            errors.push({ batch: batch.id, dimensionId: d.dimensionId, dimensionType: d.dimensionType, msg: 'id prefix does not match type' });
          }
        });
      });
      assert.strictEqual(errors.length, 0, `scenarioBatches errors: ${JSON.stringify(errors)}`);
    });
  });

  describe('ai_relevance_ranking.json', () => {
    it('every trait_id references an existing dimension or skill', () => {
      const ranking = loadJson('ai_relevance_ranking.json');
      const missing = [];
      (ranking.rankings || []).forEach((r) => {
        const id = r.trait_id;
        if (!id) return;
        if (!validDimensionIds.has(id) && !validSkillIds.has(id)) {
          missing.push(id);
        }
      });
      assert.strictEqual(missing.length, 0, `ai_relevance_ranking references missing ids: ${missing.join(', ')}`);
    });
  });

  describe('noc-2021-enriched.json', () => {
    it('traitMappings and valueMappings use valid trait/value ids', () => {
      const nocPath = path.join(DATA_DIR, 'noc-2021-enriched.json');
      if (!fs.existsSync(nocPath)) {
        return;
      }
      const noc = loadJson('noc-2021-enriched.json');
      const invalidTrait = new Set();
      const invalidValue = new Set();
      (noc.occupations || []).forEach((occ) => {
        (occ.traitMappings || []).forEach((m) => {
          if (m.id && !traitIds.has(m.id)) invalidTrait.add(m.id);
        });
        (occ.valueMappings || []).forEach((m) => {
          if (m.id && !valueIds.has(m.id)) invalidValue.add(m.id);
        });
      });
      assert.strictEqual(invalidTrait.size, 0, `noc-2021-enriched invalid trait ids: ${[...invalidTrait].join(', ')}`);
      assert.strictEqual(invalidValue.size, 0, `noc-2021-enriched invalid value ids: ${[...invalidValue].join(', ')}`);
    });
  });
});
