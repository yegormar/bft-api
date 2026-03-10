/**
 * LLM-generated career paths: Study -> Initial job -> Ultimate job.
 * Two-step flow: step 1 creative (plain text), step 2 format (JSON). No fallbacks.
 */

const fs = require('fs');
const reportService = require('../services/reportService');
const ollamaClient = require('./ollamaClient');
const config = require('../../config');

function loadPrompt(pathKey, envVarName) {
  const p = pathKey();
  const raw = fs.readFileSync(p, 'utf8');
  const trimmed = (raw || '').trim();
  if (trimmed === '') {
    throw new Error(`${envVarName} is empty. Set a non-empty prompt file in .env.`);
  }
  return trimmed;
}

/** Load AI-era context for career step 1. Required; path from CAREERS_LLM_AI_CONTEXT_FILE. */
function loadCareerAiContext() {
  const contextPath = config.getCareerPathsAiContextPath();
  const raw = fs.readFileSync(contextPath, 'utf8');
  const trimmed = (raw || '').trim();
  if (trimmed === '') {
    throw new Error('CAREERS_LLM_AI_CONTEXT_FILE is empty. Set a non-empty file in .env (e.g. conf/report_ai_context.txt).');
  }
  return `\n\n---\n\n${trimmed}`;
}

function loadStep1Prompt() {
  const base = loadPrompt(config.getCareerPathsStep1PromptPath, 'CAREERS_LLM_STEP1_PROMPT_FILE');
  const aiContext = loadCareerAiContext();
  return base + aiContext;
}

function loadStep2Prompt() {
  return loadPrompt(config.getCareerPathsStep2PromptPath, 'CAREERS_LLM_STEP2_PROMPT_FILE');
}

const VALID_BUCKETS = new Set(['high', 'medium', 'low']);

const DIMENSION_SLIM_KEYS = ['id', 'name', 'description', 'mean', 'band', 'band_interpretation'];

/**
 * Build a slim payload for the career LLM: dimensions without related_skill_clusters/score_scale,
 * skills without applicability/description, personality with only dominant/secondary/avoid/demographics.
 */
function buildSlimCareerPayload(fullPayload, selected_skills_with_investment) {
  const dimensions = { aptitudes: [], traits: [], values: [] };
  for (const type of ['aptitudes', 'traits', 'values']) {
    const list = fullPayload.dimensions && fullPayload.dimensions[type];
    if (!Array.isArray(list)) continue;
    dimensions[type] = list.map((d) => {
      const out = {};
      for (const k of DIMENSION_SLIM_KEYS) {
        if (d && Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined) {
          out[k] = d[k];
        }
      }
      return out;
    });
  }

  const skills = (fullPayload.skills || []).map((s) => {
    const out = { id: s.id, name: s.name || s.id };
    if (s && typeof s.ai_trend === 'string' && s.ai_trend.trim() !== '') {
      out.ai_trend = s.ai_trend.trim();
    }
    return out;
  });

  let personality_cluster = null;
  const pre = fullPayload.personality_cluster && fullPayload.personality_cluster.pre_survey_profile;
  if (pre && typeof pre === 'object') {
    personality_cluster = {
      pre_survey_profile: {
        ...(Array.isArray(pre.dominant) && pre.dominant.length > 0 && { dominant: pre.dominant }),
        ...(Array.isArray(pre.secondary) && pre.secondary.length > 0 && { secondary: pre.secondary }),
        ...(Array.isArray(pre.avoidClusters) && pre.avoidClusters.length > 0 && { avoidClusters: pre.avoidClusters }),
        ...(pre.demographics && typeof pre.demographics === 'object' && Object.keys(pre.demographics).length > 0 && { demographics: pre.demographics }),
      },
    };
    if (Object.keys(personality_cluster.pre_survey_profile).length === 0) {
      personality_cluster = null;
    }
  }

  return {
    session_id: fullPayload.session_id,
    dimensions,
    skills,
    ...(personality_cluster && { personality_cluster }),
    selected_skills_with_investment,
  };
}

/**
 * Generate 3-4 AI-safe career paths from session payload and skills with time-investment buckets.
 * @param {string} sessionId
 * @param {Array<{ id: string, bucket: string }>} skillsWithBuckets - Skills the user selected and their bucket (high/medium/low). High = will invest a lot; low = minimal.
 * @returns {Promise<{ paths: Array<{ study: string, initialJob: string, ultimateJob: string, rationale?: string }> }>}
 * @throws {Error} When session not found, LLM disabled, or LLM returns invalid JSON.
 */
async function generateCareerPaths(sessionId, skillsWithBuckets) {
  const payload = reportService.getSessionPayloadForLlm(sessionId, { includeQuestionsAndAnswers: false });
  if (!payload || typeof payload !== 'object') {
    throw new Error('Session not found or payload unavailable.');
  }

  const skillsList = Array.isArray(skillsWithBuckets) ? skillsWithBuckets : [];
  for (const s of skillsList) {
    if (!s || typeof s.id !== 'string' || s.id.trim() === '') continue;
    if (!VALID_BUCKETS.has(s.bucket)) {
      throw new Error(`Each skill must have bucket one of high, medium, low. Got: ${JSON.stringify(s.bucket)} for skill ${s.id}.`);
    }
  }
  const payloadSkillsById = new Map((payload.skills || []).map((s) => [s.id, s]));
  const selected_skills_with_investment = skillsList
    .filter((s) => s && s.id && typeof s.id === 'string' && s.id.trim() !== '')
    .map((s) => {
      const full = payloadSkillsById.get(s.id);
      return {
        id: String(s.id).trim(),
        name: (full && full.name) ? full.name : String(s.id).trim(),
        time_investment: s.bucket,
      };
    });

  const careerPayload = buildSlimCareerPayload(payload, selected_skills_with_investment);

  if (!ollamaClient.config || !ollamaClient.config.enabled) {
    throw new Error('LLM is not configured or disabled. Career paths require LLM.');
  }

  const step1System = loadStep1Prompt();
  const step1User = JSON.stringify(careerPayload, null, 2);
  const step1Res = await ollamaClient.chat([
    { role: 'system', content: step1System },
    { role: 'user', content: step1User },
  ]);
  const plainText = (step1Res.content || '').trim();
  if (!plainText) {
    throw new Error('Career paths step 1 returned empty content.');
  }

  const step2System = loadStep2Prompt();
  const step2Res = await ollamaClient.chat([
    { role: 'system', content: step2System },
    { role: 'user', content: plainText },
  ]);
  const jsonText = (step2Res.content || '').trim();
  if (!jsonText) {
    throw new Error('Career paths step 2 returned empty content.');
  }

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    const stripped = jsonText.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
    try {
      data = JSON.parse(stripped);
    } catch (e2) {
      throw new Error(`Career paths step 2 response is not valid JSON. ${e.message}`);
    }
  }

  const paths = Array.isArray(data.paths) ? data.paths : [];
  const valid = paths.filter((p) => p && typeof p.study === 'string' && typeof p.initialJob === 'string' && typeof p.ultimateJob === 'string');
  if (valid.length === 0) {
    throw new Error('Career paths LLM response had no valid paths (each path must have study, initialJob, ultimateJob).');
  }

  return {
    paths: valid.map((p) => ({
      study: String(p.study).trim(),
      initialJob: String(p.initialJob).trim(),
      ultimateJob: String(p.ultimateJob).trim(),
      ...(typeof p.rationale === 'string' && p.rationale.trim() !== '' ? { rationale: p.rationale.trim() } : {}),
    })),
  };
}

module.exports = {
  generateCareerPaths,
};
