#!/usr/bin/env node
/**
 * Diff two dimension_skill_mapping JSON files.
 *
 * Reads two files with the same structure as dimension_skill_mapping.json
 * (description, dimension_skill_weights) and reports where weights differ
 * by more than a given percentage (default 10% on the 0-1 scale).
 *
 * Usage:
 *   node src/scripts/diff-dimension-skill-mapping.js <file1> <file2> [--threshold N]
 *   node src/scripts/diff-dimension-skill-mapping.js --base file1.json --current file2.json [--threshold N]
 *
 * Options:
 *   --base path       First mapping file (default: first positional arg).
 *   --current path    Second mapping file (default: second positional arg).
 *   --threshold N     Report deviations above N% of the 0-1 scale (default: 10). E.g. 10 => 0.1 absolute difference.
 *
 * Exit code: 0 if no significant deviations, 1 if there are deviations or if dimensions/skills differ.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD_PERCENT = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf('--base');
  const currentIdx = args.indexOf('--current');
  const thresholdIdx = args.indexOf('--threshold');

  const base = baseIdx >= 0 && args[baseIdx + 1]
    ? path.resolve(process.cwd(), args[baseIdx + 1])
    : args[0];
  const current = currentIdx >= 0 && args[currentIdx + 1]
    ? path.resolve(process.cwd(), args[currentIdx + 1])
    : args[1];

  let thresholdPercent = DEFAULT_THRESHOLD_PERCENT;
  if (thresholdIdx >= 0 && args[thresholdIdx + 1] !== undefined) {
    const n = parseFloat(args[thresholdIdx + 1], 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 100) {
      thresholdPercent = n;
    }
  }

  return { base, current, thresholdPercent };
}

function loadMapping(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.error('[diff] File not found:', filePath);
    process.exit(2);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('[diff] Invalid JSON:', filePath, e.message);
    process.exit(2);
  }
  const weights = data.dimension_skill_weights;
  if (!weights || typeof weights !== 'object') {
    console.error('[diff] Missing or invalid dimension_skill_weights in', filePath);
    process.exit(2);
  }
  return weights;
}

function getWeight(weights, dimensionId, skillId) {
  const dim = weights[dimensionId];
  if (!dim || typeof dim !== 'object') return undefined;
  const w = dim[skillId];
  return typeof w === 'number' ? w : undefined;
}

function main() {
  const { base: basePath, current: currentPath, thresholdPercent } = parseArgs();

  if (!basePath || !currentPath) {
    console.error('[diff] Usage: node diff-dimension-skill-mapping.js <file1> <file2> [--threshold N]');
    console.error('[diff]   or:   node diff-dimension-skill-mapping.js --base <file1> --current <file2> [--threshold N]');
    process.exit(2);
  }

  const baseName = path.basename(basePath);
  const currentName = path.basename(currentPath);

  const baseWeights = loadMapping(basePath);
  const currentWeights = loadMapping(currentPath);

  const threshold = thresholdPercent / 100;

  const allDimensionIds = new Set([
    ...Object.keys(baseWeights),
    ...Object.keys(currentWeights),
  ]);
  const dimensionsOnlyInBase = [...allDimensionIds].filter((id) => !currentWeights[id]);
  const dimensionsOnlyInCurrent = [...allDimensionIds].filter((id) => !baseWeights[id]);

  const deviations = [];
  const dimensionsWithDeviations = new Set();

  for (const dimensionId of allDimensionIds) {
    if (dimensionsOnlyInBase.includes(dimensionId) || dimensionsOnlyInCurrent.includes(dimensionId)) {
      continue;
    }
    const baseDim = baseWeights[dimensionId];
    const currentDim = currentWeights[dimensionId];
    const allSkillIds = new Set([
      ...Object.keys(baseDim || {}),
      ...Object.keys(currentDim || {}),
    ]);

    for (const skillId of allSkillIds) {
      const wBase = getWeight(baseWeights, dimensionId, skillId);
      const wCurrent = getWeight(currentWeights, dimensionId, skillId);

      const b = wBase !== undefined ? wBase : 0;
      const c = wCurrent !== undefined ? wCurrent : 0;
      const diff = c - b;
      const absDiff = Math.abs(diff);

      if (absDiff > threshold) {
        deviations.push({
          dimensionId,
          skillId,
          base: b,
          current: c,
          diff,
          absDiff,
        });
        dimensionsWithDeviations.add(dimensionId);
      }
    }
  }

  // Report
  console.log('[diff] Base:', baseName);
  console.log('[diff] Current:', currentName);
  console.log('[diff] Threshold: deviations >', thresholdPercent + '% (absolute difference >', threshold.toFixed(2) + ')');
  console.log('');

  let exitCode = 0;

  if (dimensionsOnlyInBase.length > 0) {
    exitCode = 1;
    console.log('Dimensions only in base (' + baseName + '):');
    dimensionsOnlyInBase.forEach((id) => console.log('  -', id));
    console.log('');
  }

  if (dimensionsOnlyInCurrent.length > 0) {
    exitCode = 1;
    console.log('Dimensions only in current (' + currentName + '):');
    dimensionsOnlyInCurrent.forEach((id) => console.log('  -', id));
    console.log('');
  }

  if (deviations.length > 0) {
    exitCode = 1;
    console.log('Deviations (skill, dimension, base -> current, diff):');
    deviations.sort((a, b) => {
      const skillCmp = a.skillId.localeCompare(b.skillId);
      if (skillCmp !== 0) return skillCmp;
      return a.dimensionId.localeCompare(b.dimensionId);
    });
    for (const d of deviations) {
      const sign = d.diff >= 0 ? '+' : '';
      const pct = (Math.abs(d.diff) * 100).toFixed(0);
      console.log('  ', d.skillId, '|', d.dimensionId, '|', d.base.toFixed(2), '->', d.current.toFixed(2), '|', sign + d.diff.toFixed(2), '(' + pct + '%)');
    }
    console.log('');
    console.log('Total:', deviations.length, 'skill/dimension weight(s) deviate by more than', thresholdPercent + '% across', dimensionsWithDeviations.size, 'dimension(s).');
  } else if (dimensionsOnlyInBase.length === 0 && dimensionsOnlyInCurrent.length === 0) {
    console.log('No significant deviations (all weights within', thresholdPercent + '%).');
  }

  process.exit(exitCode);
}

main();
