/**
 * Profile synthesis for the report: LLM-only and Hybrid (rules + optional LLM).
 * Produces "discovered aptitudes, traits, values" summaries and profession recommendations.
 * System prompts are loaded from config (conf/) via config/llm.js; no prompts in code.
 */

const path = require('path');
const fs = require('fs');
const ollamaClient = require('./ollamaClient');
const assessmentModel = require('../data/assessmentModel');
const llmConfig = require('../../config/llm');

const AI_RANKING_PATH = path.join(__dirname, '../data/ai_relevance_ranking.json');
let aiRankingCache = null;

/**
 * Load AI relevance ranking JSON. Cached for reuse.
 * Returns { rankings: [], trend_legend?: {}, description?: string, sources?: string[] } or null.
 */
function loadAiRelevanceRanking() {
  if (aiRankingCache) return aiRankingCache;
  try {
    const raw = fs.readFileSync(AI_RANKING_PATH, 'utf8');
    const data = JSON.parse(raw);
    aiRankingCache = {
      rankings: Array.isArray(data.rankings) ? data.rankings : [],
      trend_legend: data.trend_legend || null,
      description: data.description || null,
      sources: Array.isArray(data.sources) ? data.sources : null,
    };
    return aiRankingCache;
  } catch (err) {
    console.warn('[reportSynthesis] Could not load AI relevance ranking:', err.message);
    return null;
  }
}

/**
 * Get ranking entries whose trait_id is in the set of explored dimension ids.
 * profileByDimensions: { aptitudes: [{id,name}], traits, values, skills }.
 */
function getRankingEntriesForExploredDimensions(profileByDimensions, rankingData) {
  if (!profileByDimensions || !rankingData?.rankings?.length) return [];
  const ids = new Set();
  const keys = ['aptitudes', 'traits', 'values', 'skills'];
  for (const key of keys) {
    const list = profileByDimensions[key];
    if (Array.isArray(list)) for (const d of list) if (d && d.id) ids.add(d.id);
  }
  if (ids.size === 0) return [];
  return rankingData.rankings.filter((r) => r && ids.has(r.trait_id));
}

/**
 * Build user prompt for LLM-only profile synthesis from full insights.
 */
function buildProfileLLMUserPrompt(insights, dimensionNames) {
  const lines = [
    'Assessment model dimensions (use these names where relevant):',
    'Aptitudes: ' + (dimensionNames.aptitudes || []).join(', '),
    'Traits: ' + (dimensionNames.traits || []).join(', '),
    'Values: ' + (dimensionNames.values || []).join(', '),
    '',
    'What the person shared (question → answer, and our per-question summary):',
  ];
  (insights || []).forEach((i) => {
    lines.push('- Question: ' + (i.questionTitle || i.questionId || ''));
    lines.push('  Answer: ' + String(i.value ?? ''));
    if (i.summary) lines.push('  Summary: ' + i.summary);
  });
  lines.push('');
  lines.push('Write the strength profile summary (2–4 paragraphs) in terms of discovered aptitudes, traits, and values. Plain text only.');
  return lines.join('\n');
}

/**
 * Build user prompt for Hybrid: we give the list of explored dimensions and ask for short narrative.
 */
function buildProfileHybridUserPrompt(explored) {
  const lines = [
    'Explored dimensions (we have at least one answer touching each):',
    'Aptitudes: ' + (explored.aptitudes || []).map((d) => d.name).join('; '),
    'Traits: ' + (explored.traits || []).map((d) => d.name).join('; '),
    'Values: ' + (explored.values || []).map((d) => d.name).join('; '),
    '',
    'Write 1–3 sentences per category (Aptitudes, Traits, Values) summarizing what we learned. Plain text only.',
  ];
  return lines.join('\n');
}

/**
 * Hybrid: from coverage, build structured list of explored dimensions (id, name) per type.
 * Uses same coverage keys as assessmentService: aptitudes, traits, values, skills.
 */
function getExploredDimensionsFromCoverage(coverage, model) {
  const model_ = model || assessmentModel.load();
  const out = { aptitudes: [], traits: [], values: [], skills: [] };

  if (!coverage || typeof coverage !== 'object') return out;

  const types = [
    { key: 'aptitudes', list: model_.aptitudes },
    { key: 'traits', list: model_.traits },
    { key: 'values', list: model_.values },
    { key: 'skills', list: model_.skills },
  ];

  for (const { key, list } of types) {
    const cov = coverage[key] || {};
    for (const d of list) {
      const c = cov[d.id];
      if (c && typeof c.questionCount === 'number' && c.questionCount > 0) {
        out[key].push({ id: d.id, name: d.name });
      }
    }
  }

  return out;
}

/**
 * Single profile summary from session payload JSON. Input is the full session payload
 * (questions_and_answers, dimensions, skills, personality_cluster). One LLM call; one summary string.
 * Returns string or null if LLM disabled/fails.
 */
async function generateProfileSummaryFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!ollamaClient.config.enabled) return null;
  const systemPrompt = llmConfig.getReportProfileSystemPrompt && llmConfig.getReportProfileSystemPrompt();
  if (!systemPrompt || !systemPrompt.trim()) return null;

  const userContent = JSON.stringify(payload, null, 2);
  const messages = [
    { role: 'system', content: systemPrompt.trim() },
    { role: 'user', content: userContent },
  ];

  try {
    const res = await ollamaClient.chat(messages);
    const text = (res.content || '').trim();
    return text || null;
  } catch (err) {
    console.warn('[reportSynthesis] LLM profile summary from payload error:', err.message);
    return null;
  }
}

/**
 * Hybrid synthesis: coverage → explored dimensions (structured) + optional LLM narrative.
 * Returns { profileByDimensions: { aptitudes, traits, values, skills }, strengthProfileSummaryHybrid: string|null }.
 */
async function generateProfileSummaryHybrid(coverage, model) {
  const explored = getExploredDimensionsFromCoverage(coverage, model);

  let strengthProfileSummaryHybrid = null;
  const hybridSystemPrompt = llmConfig.getReportHybridSystemPrompt && llmConfig.getReportHybridSystemPrompt();
  if (
    ollamaClient.config.enabled &&
    hybridSystemPrompt &&
    hybridSystemPrompt.trim() &&
    (explored.aptitudes.length || explored.traits.length || explored.values.length)
  ) {
    try {
      const userContent = buildProfileHybridUserPrompt(explored);
      const messages = [
        { role: 'system', content: hybridSystemPrompt.trim() },
        { role: 'user', content: userContent },
      ];
      const res = await ollamaClient.chat(messages);
      strengthProfileSummaryHybrid = (res.content || '').trim() || null;
    } catch (err) {
      console.warn('[reportSynthesis] Hybrid LLM summary error:', err.message);
    }
  }

  return {
    profileByDimensions: explored,
    strengthProfileSummaryHybrid,
  };
}

/**
 * Build user prompt for profession recommendations: profile summary + explored dimensions + AI ranking entries.
 */
function buildRecommendationsUserPrompt(profileSummary, profileByDimensions, aiRankingEntries) {
  const lines = [
    'Profile summary (what we learned about this person):',
    profileSummary && profileSummary.trim() ? profileSummary.trim() : '(No narrative summary yet.)',
    '',
    'Explored dimensions (we have at least one answer touching each):',
  ];
  const keys = ['aptitudes', 'traits', 'values', 'skills'];
  for (const key of keys) {
    const list = (profileByDimensions && profileByDimensions[key]) || [];
    if (list.length) {
      lines.push(key + ': ' + list.map((d) => d.name).join('; '));
    }
  }
  lines.push('');
  lines.push('AI-era relevance and recommendation notes for these dimensions (use for career directions and for directions to avoid):');
  for (const r of aiRankingEntries || []) {
    if (!r || !r.trait_id) continue;
    lines.push('- ' + r.trait_id + ': trend=' + (r.trend || '') + '; rationale: ' + (r.rationale || ''));
    if (r.recommendation_note) lines.push('  recommendation_note: ' + r.recommendation_note);
  }
  lines.push('');
  lines.push('Output a single JSON object with keys "recommended" and "directionsToAvoid". No markdown, no code fences.');
  return lines.join('\n');
}

/**
 * Validate and normalize parsed recommendations from LLM.
 * Expected: { recommended: [{ direction, fit, rationale }], directionsToAvoid: [{ direction, rationale }] }.
 */
function normalizeRecommendationsResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const recommended = Array.isArray(parsed.recommended) ? parsed.recommended : [];
  const directionsToAvoid = Array.isArray(parsed.directionsToAvoid) ? parsed.directionsToAvoid : [];
  const out = {
    recommended: recommended
      .filter((r) => r && (r.direction || r.rationale))
      .map((r) => ({
        direction: String(r.direction || '').trim() || '(direction)',
        fit: /^(high|medium|low)$/i.test(String(r.fit || '').trim()) ? String(r.fit).trim().toLowerCase() : 'medium',
        rationale: String(r.rationale || '').trim() || '',
      }))
      .slice(0, 5),
    directionsToAvoid: directionsToAvoid
      .filter((a) => a && (a.direction || a.rationale))
      .map((a) => ({
        direction: String(a.direction || '').trim() || '(direction to avoid)',
        rationale: String(a.rationale || '').trim() || '',
      }))
      .slice(0, 3),
  };
  if (out.recommended.length === 0 && out.directionsToAvoid.length === 0) return null;
  return out;
}

/**
 * Generate profession/career recommendations and 2–3 directions to avoid.
 * Uses profile summary, explored dimensions, and AI relevance ranking.
 * Returns { recommended: [{ direction, fit, rationale }], directionsToAvoid: [{ direction, rationale }] } or null.
 */
async function generateProfessionRecommendations(profileSummary, profileByDimensions, preSurveyProfile = null) {
  if (!ollamaClient.config.enabled) return null;
  const systemPrompt = llmConfig.getReportRecommendationsSystemPrompt && llmConfig.getReportRecommendationsSystemPrompt();
  if (!systemPrompt || !systemPrompt.trim()) return null;

  const rankingData = loadAiRelevanceRanking();
  if (!rankingData || !rankingData.rankings.length) return null;

  const aiRankingEntries = getRankingEntriesForExploredDimensions(profileByDimensions, rankingData);
  const hasExplored = profileByDimensions && (
    (profileByDimensions.aptitudes && profileByDimensions.aptitudes.length) ||
    (profileByDimensions.traits && profileByDimensions.traits.length) ||
    (profileByDimensions.values && profileByDimensions.values.length) ||
    (profileByDimensions.skills && profileByDimensions.skills.length)
  );
  if (!hasExplored) return null;

  const userContent = buildRecommendationsUserPrompt(profileSummary, profileByDimensions, aiRankingEntries);
  const messages = [
    { role: 'system', content: systemPrompt.trim() },
    { role: 'user', content: userContent },
  ];

  try {
    const res = await ollamaClient.chat(messages);
    const text = (res.content || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const raw = jsonMatch ? jsonMatch[0] : text;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[reportSynthesis] Recommendations response was not valid JSON');
      return null;
    }
    return normalizeRecommendationsResponse(parsed);
  } catch (err) {
    console.warn('[reportSynthesis] Profession recommendations error:', err.message);
    return null;
  }
}

module.exports = {
  getExploredDimensionsFromCoverage,
  generateProfileSummaryFromPayload,
  generateProfileSummaryHybrid,
  loadAiRelevanceRanking,
  getRankingEntriesForExploredDimensions,
  generateProfessionRecommendations,
};
