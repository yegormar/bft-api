/**
 * Profile synthesis for the report: one LLM call from full session payload.
 * System prompt is loaded from config (conf/) via config/llm.js.
 * Optional AI-era context from conf/report_ai_context.txt is appended when present.
 */

const path = require('path');
const fs = require('fs');
const ollamaClient = require('./ollamaClient');
const assessmentModel = require('../data/assessmentModel');
const llmConfig = require('../../config/llm');

/** Load optional AI-era context for recommendations. Path from config (LLM_REPORT_AI_CONTEXT_FILE or conf/report_ai_context.txt). Returns trimmed string or empty string. */
function loadReportAiContext() {
  const contextPath = llmConfig.getReportAiContextPath && llmConfig.getReportAiContextPath();
  if (!contextPath) return '';
  try {
    if (fs.existsSync(contextPath)) {
      const raw = fs.readFileSync(contextPath, 'utf8');
      const trimmed = (raw || '').trim();
      return trimmed ? `\n\n---\n\n${trimmed}` : '';
    }
  } catch (err) {
    console.warn('[reportSynthesis] Could not load report AI context:', err.message);
  }
  return '';
}

/**
 * From coverage, build structured list of explored dimensions (id, name) per type.
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
 * Build a one-line headline from the payload: dominant profile, high-band dimensions, top skills.
 * Placed above the JSON so the model has a quick anchor for the report.
 */
function buildReportHeadline(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  const profile = payload.personality_cluster && payload.personality_cluster.pre_survey_profile;
  const dominant = profile && Array.isArray(profile.dominant) && profile.dominant[0];
  if (dominant && typeof dominant === 'string') {
    parts.push(`Profile: ${dominant}`);
  }
  const dimensions = payload.dimensions;
  if (dimensions && typeof dimensions === 'object') {
    const all = [
      ...(Array.isArray(dimensions.aptitudes) ? dimensions.aptitudes : []),
      ...(Array.isArray(dimensions.traits) ? dimensions.traits : []),
      ...(Array.isArray(dimensions.values) ? dimensions.values : []),
    ].filter((d) => d && d.band === 'high' && d.name);
    const names = all.slice(0, 5).map((d) => d.name);
    if (names.length > 0) {
      parts.push(`High on: ${names.join(', ')}`);
    }
  }
  const skills = payload.skills;
  if (Array.isArray(skills) && skills.length > 0) {
    const top = skills.slice(0, 3).map((s) => (s && s.name ? s.name : '')).filter(Boolean);
    if (top.length > 0) {
      parts.push(`Top skills: ${top.join(', ')}`);
    }
  }
  return parts.length > 0 ? parts.join('. ') : '';
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

  const aiContext = loadReportAiContext();
  const fullSystemContent = systemPrompt.trim() + aiContext;

  const headline = buildReportHeadline(payload);
  const userContent = headline ? `${headline}\n\n${JSON.stringify(payload, null, 2)}` : JSON.stringify(payload, null, 2);
  const messages = [
    { role: 'system', content: fullSystemContent },
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

module.exports = {
  getExploredDimensionsFromCoverage,
  generateProfileSummaryFromPayload,
};
