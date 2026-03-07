#!/usr/bin/env node
'use strict';

/**
 * Migrates dimension IDs in data/questions-store from short form to full form
 * (aptitude_*, trait_*, value_*) after the dimension_*.json ID rename.
 *
 * Updates:
 * - dimensionSet[].dimensionId and dimensionSet[].id
 * - question.options[].dimensionScores keys (short id -> full id for dimensions; skills unchanged)
 *
 * Usage: node scripts/migrate-questions-store-dimension-ids.js [--dry-run] [storeDir]
 * Default storeDir: data/questions-store (relative to bft-api project root).
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
process.chdir(PROJECT_ROOT);

const assessmentModel = require('../src/data/assessmentModel');

const storeDirDefault = path.join(PROJECT_ROOT, 'data', 'questions-store');

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = false;
  let storeDir = storeDirDefault;
  for (const a of args) {
    if (a === '--dry-run') dryRun = true;
    else if (!a.startsWith('-')) storeDir = path.isAbsolute(a) ? a : path.join(PROJECT_ROOT, a);
  }
  return { dryRun, storeDir };
}

function toFullDimensionId(dimensionType, shortId) {
  if (!shortId || typeof shortId !== 'string') return shortId;
  if (shortId.startsWith('aptitude_') || shortId.startsWith('trait_') || shortId.startsWith('value_')) {
    return shortId;
  }
  if (dimensionType === 'aptitude') return `aptitude_${shortId}`;
  if (dimensionType === 'trait') return `trait_${shortId}`;
  if (dimensionType === 'value') return `value_${shortId}`;
  return shortId;
}

function resolveDimensionScoreKey(key, dimensionsById, skillIds) {
  if (!key || typeof key !== 'string') return key;
  if (dimensionsById.has(key)) return key;
  if (skillIds.has(key)) return key;
  const withAptitude = `aptitude_${key}`;
  if (dimensionsById.has(withAptitude)) return withAptitude;
  const withTrait = `trait_${key}`;
  if (dimensionsById.has(withTrait)) return withTrait;
  const withValue = `value_${key}`;
  if (dimensionsById.has(withValue)) return withValue;
  return key;
}

function migrateFile(filePath, model, dryRun) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!data.dimensionSet || !Array.isArray(data.dimensionSet) || !data.question) {
    return { ok: true, skipped: true };
  }

  const dimensionsById = model.dimensionsById;
  const skillIds = new Set(model.skills.map((s) => s.id));
  let changed = false;

  for (const d of data.dimensionSet) {
    const type = d.dimensionType;
    const shortId = d.dimensionId || d.id;
    const fullId = toFullDimensionId(type, shortId);
    if (fullId !== shortId || (d.id !== undefined && d.id !== fullId)) {
      d.dimensionId = fullId;
      d.id = fullId;
      changed = true;
    } else if (!d.id) {
      d.id = fullId;
      changed = true;
    }
  }

  if (data.question && Array.isArray(data.question.options)) {
    for (const opt of data.question.options) {
      if (!opt.dimensionScores || typeof opt.dimensionScores !== 'object') continue;
      const newScores = {};
      for (const [k, v] of Object.entries(opt.dimensionScores)) {
        const newKey = resolveDimensionScoreKey(k, dimensionsById, skillIds);
        newScores[newKey] = v;
        if (newKey !== k) changed = true;
      }
      opt.dimensionScores = newScores;
    }
  }

  if (changed && !dryRun) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
  }
  return { ok: true, changed };
}

function main() {
  const { dryRun, storeDir } = parseArgs();

  if (!fs.existsSync(storeDir)) {
    console.error('Store directory not found:', storeDir);
    process.exit(1);
  }

  const model = assessmentModel.load();
  let total = 0;
  let changed = 0;
  let skipped = 0;
  let errors = 0;

  const profileDirs = fs.readdirSync(storeDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const dir of profileDirs) {
    const dirPath = path.join(storeDir, dir.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const filePath = path.join(dirPath, f);
      total += 1;
      const result = migrateFile(filePath, model, dryRun);
      if (!result.ok) {
        errors += 1;
        console.error('Error', filePath, result.error);
      } else if (result.skipped) {
        skipped += 1;
      } else if (result.changed) {
        changed += 1;
        if (dryRun) console.log('[dry-run] would update', filePath);
      }
    }
  }

  console.log('Total files:', total, 'Updated:', changed, 'Skipped:', skipped, 'Errors:', errors);
  if (dryRun && changed > 0) {
    console.log('Run without --dry-run to apply changes.');
  }
  process.exit(errors > 0 ? 1 : 0);
}

main();
