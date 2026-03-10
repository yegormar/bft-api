/**
 * NOC occupation lookup and scoring by skill IDs. Data-driven only (no LLM).
 * Data: noc-2021-enriched.json with skillMappings, traitMappings, valueMappings per occupation.
 * Uses noc-2021-major-groups.json for category labels (NOC major groups).
 * Optional: scoreBySkillsAndDimensions uses OCCUPATION_SKILL_WEIGHT and OCCUPATION_DIMENSION_WEIGHT (skills vs trait/value fit).
 */

const path = require('path');
const fs = require('fs');
const skillRecommendation = require('./skillRecommendation');
const assessmentModel = require('../data/assessmentModel');

const NOC_PATH = path.join(__dirname, '../data/noc-2021-enriched.json');
const MAJOR_GROUPS_PATH = path.join(__dirname, '../data/noc-2021-major-groups.json');
let nocCache = null;
let majorGroupsCache = null;

const BAND_WEIGHT = { high: 1, medium: 0.6, low: 0.3 };

let occupationWeightsCache = null;

function getOccupationWeights() {
  if (occupationWeightsCache) return occupationWeightsCache;
  const skillRaw = (process.env.OCCUPATION_SKILL_WEIGHT || '').trim();
  const dimensionRaw = (process.env.OCCUPATION_DIMENSION_WEIGHT || '').trim();
  if (skillRaw === '' || dimensionRaw === '') {
    throw new Error(
      'OCCUPATION_SKILL_WEIGHT and OCCUPATION_DIMENSION_WEIGHT must be set in .env. See env.example.'
    );
  }
  const skillWeight = parseFloat(skillRaw, 10);
  const dimensionWeight = parseFloat(dimensionRaw, 10);
  if (Number.isNaN(skillWeight) || skillWeight < 0 || skillWeight > 1) {
    throw new Error(`OCCUPATION_SKILL_WEIGHT must be 0-1. Got: ${skillRaw}`);
  }
  if (Number.isNaN(dimensionWeight) || dimensionWeight < 0 || dimensionWeight > 1) {
    throw new Error(`OCCUPATION_DIMENSION_WEIGHT must be 0-1. Got: ${dimensionRaw}`);
  }
  const sum = skillWeight + dimensionWeight;
  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(
      `OCCUPATION_SKILL_WEIGHT and OCCUPATION_DIMENSION_WEIGHT must sum to 1. Got: ${skillWeight} + ${dimensionWeight}. See env.example.`
    );
  }
  occupationWeightsCache = { skillWeight, dimensionWeight };
  return occupationWeightsCache;
}

let skillIdToAiFutureScoreCache = null;

function getSkillIdToAiFutureScore() {
  if (skillIdToAiFutureScoreCache) return skillIdToAiFutureScoreCache;
  const model = assessmentModel.load();
  const map = new Map();
  for (const skill of model.skills) {
    try {
      map.set(skill.id, skillRecommendation.computeAiFutureScore(skill));
    } catch {
      map.set(skill.id, 0);
    }
  }
  skillIdToAiFutureScoreCache = map;
  return skillIdToAiFutureScoreCache;
}

function loadNoc() {
  if (nocCache) return nocCache;
  const raw = fs.readFileSync(NOC_PATH, 'utf8');
  const data = JSON.parse(raw);
  const occupations = Array.isArray(data.occupations) ? data.occupations : [];
  nocCache = { occupations };
  return nocCache;
}

function loadMajorGroups() {
  if (majorGroupsCache) return majorGroupsCache;
  try {
    const raw = fs.readFileSync(MAJOR_GROUPS_PATH, 'utf8');
    const data = JSON.parse(raw);
    majorGroupsCache = data.majorGroups && typeof data.majorGroups === 'object' ? data.majorGroups : {};
  } catch {
    majorGroupsCache = {};
  }
  return majorGroupsCache;
}

/**
 * Get NOC major group key and label from a 5-digit nocCode (e.g. "21100" -> "21", "Professional in natural and applied sciences").
 */
function getCategoryFromNocCode(nocCode) {
  if (!nocCode || typeof nocCode !== 'string') return { categoryKey: '', categoryLabel: 'Other' };
  const key = nocCode.trim().substring(0, 2);
  const labels = loadMajorGroups();
  return {
    categoryKey: key,
    categoryLabel: labels[key] || `Category ${key}`,
  };
}

/**
 * Score occupations by a set of skill IDs. For each occupation, sum compatibilityRating
 * over skillMappings whose id is in skillIds. Returns list with matchScore, categoryKey,
 * categoryLabel, sorted by matchScore descending then by category.
 *
 * @param {string[]} skillIds - Skill IDs the user has selected (e.g. from time-investment buckets).
 * @param {object} [options] - Optional. grouped: true to return { groups } instead of flat list.
 * @returns {Array<{ nocCode, name, matchScore, categoryKey, categoryLabel }>|{ groups: Array<{ categoryKey, categoryLabel, occupations }> }}
 */
function scoreBySkillIds(skillIds, options = {}) {
  if (!Array.isArray(skillIds) || skillIds.length === 0) {
    return options.grouped ? { groups: [] } : [];
  }
  const idSet = new Set(skillIds.filter((id) => id && String(id).trim()));

  const { occupations } = loadNoc();
  const results = [];

  for (const occ of occupations) {
    if (!occ || !occ.nocCode) continue;
    const mappings = occ.skillMappings || [];
    let score = 0;
    for (const m of mappings) {
      if (m && m.id && idSet.has(m.id) && typeof m.compatibilityRating === 'number') {
        score += m.compatibilityRating;
      }
    }
    if (score > 0) {
      const { categoryKey, categoryLabel } = getCategoryFromNocCode(occ.nocCode);
      results.push({
        nocCode: occ.nocCode,
        name: occ.name || occ.nocCode,
        matchScore: score,
        categoryKey,
        categoryLabel,
      });
    }
  }

  results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

  if (options.grouped) {
    const byCategory = new Map();
    for (const occ of results) {
      const k = occ.categoryKey || 'other';
      if (!byCategory.has(k)) {
        byCategory.set(k, { categoryKey: occ.categoryKey, categoryLabel: occ.categoryLabel, occupations: [] });
      }
      byCategory.get(k).occupations.push(occ);
    }
    const groups = Array.from(byCategory.values());
    groups.sort((a, b) => {
      const maxA = Math.max(...a.occupations.map((o) => o.matchScore || 0));
      const maxB = Math.max(...b.occupations.map((o) => o.matchScore || 0));
      if (maxB !== maxA) return maxB - maxA;
      return (a.categoryLabel || '').localeCompare(b.categoryLabel || '');
    });
    return { groups };
  }

  return results;
}

/**
 * Score occupations by skills (with bucket and applicability) and dimension (trait/value) fit.
 * Uses OCCUPATION_SKILL_WEIGHT and OCCUPATION_DIMENSION_WEIGHT. Adds aiRelevanceFromSkills per occupation.
 *
 * @param {object} payload - { skills: [{ id, bucket, applicability }], dimensionScores: { traits: [{ id, mean, band }], values: [...] } }
 * @param {object} [options] - grouped: true for { groups }
 * @returns {Array|{ groups }} Same shape as scoreBySkillIds plus aiRelevanceFromSkills on each occupation.
 */
function scoreBySkillsAndDimensions(payload, options = {}) {
  const skills = Array.isArray(payload?.skills) ? payload.skills : [];
  const dimensionScores = payload?.dimensionScores || {};
  const traits = (dimensionScores.traits || []).filter((d) => d && d.id);
  const values = (dimensionScores.values || []).filter((d) => d && d.id);

  const skillMap = new Map();
  let maxApplicability = 0;
  for (const s of skills) {
    if (!s || !s.id) continue;
    const bucket = BAND_WEIGHT[s.bucket] != null ? BAND_WEIGHT[s.bucket] : 0.6;
    const applicability = typeof s.applicability === 'number' ? s.applicability : 0;
    skillMap.set(s.id, { bucket, applicability });
    if (applicability > maxApplicability) maxApplicability = applicability;
  }
  const applicabilityNorm = maxApplicability > 0 ? maxApplicability : 1;

  const dimensionScoreById = new Map();
  for (const d of [...traits, ...values]) {
    const mean = typeof d.mean === 'number' ? d.mean : 0;
    const band = BAND_WEIGHT[d.band] != null ? BAND_WEIGHT[d.band] : 0.6;
    dimensionScoreById.set(d.id, mean * band);
  }

  if (skillMap.size === 0 && dimensionScoreById.size === 0) {
    return options.grouped ? { groups: [] } : [];
  }

  const { skillWeight, dimensionWeight } = getOccupationWeights();
  const aiScores = getSkillIdToAiFutureScore();
  const { occupations } = loadNoc();
  const results = [];
  let maxSkillRaw = 0;
  let maxDimensionRaw = 0;

  for (const occ of occupations) {
    if (!occ || !occ.nocCode) continue;

    let skillRaw = 0;
    for (const m of occ.skillMappings || []) {
      if (!m || !m.id || !m.compatibilityRating) continue;
      const sel = skillMap.get(m.id);
      if (!sel) continue;
      const applNorm = sel.applicability / applicabilityNorm;
      skillRaw += m.compatibilityRating * sel.bucket * applNorm;
    }

    let dimensionRaw = 0;
    for (const m of occ.traitMappings || []) {
      if (!m || !m.id) continue;
      const userScore = dimensionScoreById.get(m.id);
      if (userScore == null) continue;
      dimensionRaw += (m.compatibilityRating || 0) * userScore;
    }
    for (const m of occ.valueMappings || []) {
      if (!m || !m.id) continue;
      const userScore = dimensionScoreById.get(m.id);
      if (userScore == null) continue;
      dimensionRaw += (m.compatibilityRating || 0) * userScore;
    }

    if (skillRaw <= 0 && dimensionRaw <= 0) continue;

    if (skillRaw > maxSkillRaw) maxSkillRaw = skillRaw;
    if (dimensionRaw > maxDimensionRaw) maxDimensionRaw = dimensionRaw;

    let aiRelevanceFromSkills = null;
    const occSkillMappings = occ.skillMappings || [];
    if (occSkillMappings.length > 0) {
      let sum = 0;
      let count = 0;
      for (const m of occSkillMappings) {
        if (!m || !m.id) continue;
        const v = aiScores.get(m.id);
        if (typeof v === 'number') {
          sum += v;
          count += 1;
        }
      }
      aiRelevanceFromSkills = count > 0 ? sum / count : null;
    }

    const { categoryKey, categoryLabel } = getCategoryFromNocCode(occ.nocCode);
    results.push({
      nocCode: occ.nocCode,
      name: occ.name || occ.nocCode,
      skillRaw,
      dimensionRaw,
      aiRelevanceFromSkills,
      categoryKey,
      categoryLabel,
    });
  }

  const normSkill = maxSkillRaw > 0 ? maxSkillRaw : 1;
  const normDimension = maxDimensionRaw > 0 ? maxDimensionRaw : 1;
  for (const r of results) {
    const normS = r.skillRaw / normSkill;
    const normD = r.dimensionRaw / normDimension;
    r.matchScore = skillWeight * normS + dimensionWeight * normD;
    delete r.skillRaw;
    delete r.dimensionRaw;
  }

  results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

  if (options.grouped) {
    const byCategory = new Map();
    for (const occ of results) {
      const k = occ.categoryKey || 'other';
      if (!byCategory.has(k)) {
        byCategory.set(k, { categoryKey: occ.categoryKey, categoryLabel: occ.categoryLabel, occupations: [] });
      }
      byCategory.get(k).occupations.push(occ);
    }
    const groups = Array.from(byCategory.values());
    groups.sort((a, b) => {
      const maxA = Math.max(...a.occupations.map((o) => o.matchScore || 0));
      const maxB = Math.max(...b.occupations.map((o) => o.matchScore || 0));
      if (maxB !== maxA) return maxB - maxA;
      return (a.categoryLabel || '').localeCompare(b.categoryLabel || '');
    });
    return { groups };
  }

  return results;
}

/**
 * Get full occupation by NOC code. Adds aiRelevanceFromSkills (0-1) from skills' AI future scores.
 *
 * @param {string} nocCode
 * @returns {object|null} Full occupation object or null.
 */
function getByNocCode(nocCode) {
  if (!nocCode || !String(nocCode).trim()) return null;
  const key = String(nocCode).trim();
  const { occupations } = loadNoc();
  const occ = occupations.find((o) => o && o.nocCode === key) || null;
  if (!occ) return null;
  const aiScores = getSkillIdToAiFutureScore();
  const mappings = occ.skillMappings || [];
  if (mappings.length > 0) {
    let sum = 0;
    let count = 0;
    for (const m of mappings) {
      if (!m || !m.id) continue;
      const v = aiScores.get(m.id);
      if (typeof v === 'number') {
        sum += v;
        count += 1;
      }
    }
    occ.aiRelevanceFromSkills = count > 0 ? sum / count : null;
  } else {
    occ.aiRelevanceFromSkills = null;
  }
  return occ;
}

module.exports = {
  loadNoc,
  loadMajorGroups,
  getCategoryFromNocCode,
  getOccupationWeights,
  scoreBySkillIds,
  scoreBySkillsAndDimensions,
  getByNocCode,
};
