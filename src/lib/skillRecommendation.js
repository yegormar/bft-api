/**
 * Skill applicability from traits/values dimension scores.
 * Uses related_skill_clusters in dimension_traits.json and dimension_values.json plus AI relevance ranking.
 * AI future relevance uses ai_skills_ranking_model.json (see bft-doc/AI_SKILLS_DECISION_MATRIX.md).
 */

const path = require('path');
const fs = require('fs');
const assessmentModel = require('../data/assessmentModel');

const AI_FUTURE_MODEL_PATH = path.join(__dirname, '../data/ai_skills_ranking_model.json');
let aiFutureModelCache = null;

function loadAiFutureModel() {
  if (aiFutureModelCache) return aiFutureModelCache;
  const raw = fs.readFileSync(AI_FUTURE_MODEL_PATH, 'utf8');
  const data = JSON.parse(raw);
  const scaleMax = typeof data.scale_max === 'number' && data.scale_max > 0 ? data.scale_max : 5;
  const dimensions = Array.isArray(data.dimensions) ? data.dimensions : [];
  if (dimensions.length === 0) {
    throw new Error('ai_skills_ranking_model.json must define dimensions. Check bft-api/src/data/ai_skills_ranking_model.json.');
  }
  aiFutureModelCache = { scaleMax, dimensions };
  return aiFutureModelCache;
}

/**
 * Compute AI future relevance 0-1 from structural_scores using ai_skills_ranking_model.json.
 * Each dimension contributes a 0-1 value (raw/scale_max, or inverted when invert: true).
 * Combination is average. Every skill in skills.json must have full structural_scores (all six dimensions numeric).
 * No fallback: missing or incomplete data is a bug and we fail fast.
 *
 * @param {object} skill - { id?, name?, structural_scores }
 * @returns {number} 0-1
 */
function computeAiFutureScore(skill) {
  const model = loadAiFutureModel();
  const ss = skill.structural_scores;
  if (!ss || typeof ss !== 'object') {
    throw new Error(
      `Skill "${skill.id || skill.name}" has no structural_scores. ` +
      'Every skill in skills.json must have structural_scores with all six dimensions (see ai_skills_ranking_model.json).'
    );
  }
  let sum = 0;
  let count = 0;
  for (const dim of model.dimensions) {
    const raw = ss[dim.key];
    if (typeof raw !== 'number') {
      throw new Error(
        `Skill "${skill.id || skill.name}" has missing or non-numeric structural_scores.${dim.key}. ` +
        'Every skill must have all six dimensions as numbers 0-5 (see bft-doc/AI_SKILLS_DECISION_MATRIX.md).'
      );
    }
    const v = Math.max(0, Math.min(model.scaleMax, raw)) / model.scaleMax;
    sum += dim.invert ? 1 - v : v;
    count += 1;
  }
  const combined = count > 0 ? sum / count : 0;
  return Math.max(0, Math.min(1, combined));
}

const AI_RANKING_PATH = path.join(__dirname, '../data/ai_relevance_ranking.json');
let aiRankingCache = null;

const BAND_WEIGHT = { high: 1, medium: 0.6, low: 0.3 };

function loadAiRelevanceRanking() {
  if (aiRankingCache) return aiRankingCache;
  try {
    const raw = fs.readFileSync(AI_RANKING_PATH, 'utf8');
    const data = JSON.parse(raw);
    aiRankingCache = {
      rankings: Array.isArray(data.rankings) ? data.rankings : [],
    };
    return aiRankingCache;
  } catch (err) {
    console.warn('[skillRecommendation] Could not load AI relevance ranking:', err.message);
    aiRankingCache = { rankings: [] };
    return aiRankingCache;
  }
}

function getRelevanceScoreForDimension(rankingData, dimensionId) {
  if (!rankingData?.rankings?.length) return 1;
  const entry = rankingData.rankings.find((r) => r && r.trait_id === dimensionId);
  return entry && typeof entry.relevance_score === 'number' ? entry.relevance_score : 1;
}

/**
 * Compute applicability score per skill from dimension scores (traits/values/aptitudes).
 * Uses average contribution per skill (sum of contributions / number of contributing dimensions)
 * so that skills linked from many dimensions do not dominate. Returns array of
 * { id, name, description, ai_trend, structural_scores, applicability } ordered by
 * applicability descending. Skills with no link get applicability 0.
 *
 * @param {object} dimensionScores - { traits: [{ id, name, mean, band, count }], values: [...], aptitudes: [...] }
 * @returns {Array<object>}
 */
function getSkillsWithApplicability(dimensionScores) {
  const model = assessmentModel.load();
  const rankingData = loadAiRelevanceRanking();
  const sumBySkill = new Map();
  const countBySkill = new Map();

  for (const skill of model.skills) {
    sumBySkill.set(skill.id, 0);
    countBySkill.set(skill.id, 0);
  }

  const traits = (dimensionScores && dimensionScores.traits) || [];
  const values = (dimensionScores && dimensionScores.values) || [];
  const aptitudes = (dimensionScores && dimensionScores.aptitudes) || [];

  for (const list of [traits, values, aptitudes]) {
    for (const d of list) {
      if (!d || !d.id) continue;
      const def = model.dimensionsById.get(d.id);
      const clusters = (def && def.related_skill_clusters) || [];
      if (clusters.length === 0) continue;

      const mean = typeof d.mean === 'number' ? d.mean : 0;
      const band = (d.band && BAND_WEIGHT[d.band]) != null ? BAND_WEIGHT[d.band] : 0.6;
      const relevance = getRelevanceScoreForDimension(rankingData, d.id);
      const contribution = mean * band * relevance;

      for (const skillId of clusters) {
        if (!sumBySkill.has(skillId)) continue;
        sumBySkill.set(skillId, (sumBySkill.get(skillId) || 0) + contribution);
        countBySkill.set(skillId, (countBySkill.get(skillId) || 0) + 1);
      }
    }
  }

  const result = model.skills.map((s) => {
    const sum = sumBySkill.get(s.id) ?? 0;
    const count = countBySkill.get(s.id) ?? 0;
    const applicability = count > 0 ? sum / count : 0;
    return {
      id: s.id,
      name: s.name,
      short_label: s.short_label || null,
      description: s.description || '',
      ai_trend: s.ai_trend || null,
      ai_category: s.ai_category || null,
      ai_future_rationale: s.ai_future_rationale || null,
      how_measured_or_observed: s.how_measured_or_observed || null,
      question_hints: Array.isArray(s.question_hints) ? s.question_hints : null,
      structural_scores: s.structural_scores || null,
      applicability,
      ai_future_score: computeAiFutureScore(s),
    };
  });

  result.sort((a, b) => (b.applicability || 0) - (a.applicability || 0));
  return result;
}

/**
 * Dimension metadata for UI hints (core_question, why_it_matters, scoring_scale).
 * Used by the report so the skills details view can show a hint per structural score.
 *
 * @returns {Array<{ key: string, label: string, core_question: string, why_it_matters: string, scoring_scale: { "0": string, "5": string } }>}
 */
function getStructuralDimensionMeta() {
  const model = loadAiFutureModel();
  return model.dimensions.map((d) => ({
    key: d.key,
    label: d.label,
    core_question: d.core_question || '',
    why_it_matters: d.why_it_matters || '',
    scoring_scale: d.scoring_scale && typeof d.scoring_scale === 'object' ? d.scoring_scale : { '0': '', '5': '' },
  }));
}

module.exports = {
  getSkillsWithApplicability,
  getStructuralDimensionMeta,
};
