/**
 * Startup checks: required files/directories and LLM connectivity.
 * Run before the server listens. Exits the process with a clear message on failure.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function exit(message) {
  console.error('[startup]', message);
  process.exit(1);
}

function resolvePath(relativeOrAbsolute) {
  if (!relativeOrAbsolute || typeof relativeOrAbsolute !== 'string') return null;
  const trimmed = relativeOrAbsolute.trim();
  if (trimmed === '') return null;
  return path.isAbsolute(trimmed) ? trimmed : path.join(PROJECT_ROOT, trimmed);
}

/**
 * Ensure a directory exists and is writable. Create it if missing.
 * @param {string} dirPath - Absolute path to the directory
 * @param {string} label - Description for error messages
 */
function ensureDirWritable(dirPath, label) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    exit(`${label} could not be created: ${dirPath}. ${err.message}`);
  }
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
  } catch (err) {
    exit(`${label} is not writable: ${dirPath}. ${err.message}`);
  }
}

/**
 * Check that a file exists and is readable.
 * @param {string} filePath - Absolute path
 * @param {string} label - Description for error messages
 */
function requireFile(filePath, label) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      exit(`${label} is not a file: ${filePath}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      exit(`${label} not found: ${filePath}. Set paths in .env (see env.example).`);
    }
    exit(`${label} not readable: ${filePath}. ${err.message}`);
  }
}

/**
 * Run file and directory checks. Exits on failure.
 * @param {object} config - Server config (port, questionsStoreDir, ...)
 */
function runFileAndDirChecks(config) {
  const questionsStoreDir = resolvePath(config.questionsStoreDir);
  if (!questionsStoreDir) {
    exit('BFT_QUESTIONS_STORE_DIR is required. Set it in .env (e.g. ./data/questions-store).');
  }
  ensureDirWritable(questionsStoreDir, 'Questions store directory');

  const feedbackFile = resolvePath(config.feedbackFile);
  if (!feedbackFile) {
    exit('BFT_FEEDBACK_FILE is required. Set it in .env (e.g. ./data/feedback.jsonl).');
  }
  const feedbackDir = path.dirname(feedbackFile);
  ensureDirWritable(feedbackDir, 'Feedback file directory');
  if (fs.existsSync(feedbackFile)) {
    try {
      fs.accessSync(feedbackFile, fs.constants.W_OK);
    } catch (err) {
      exit(`Feedback file is not writable: ${feedbackFile}. ${err.message}`);
    }
  }

  const requiredDataFiles = [
    'src/data/dimension_aptitudes.json',
    'src/data/dimension_traits.json',
    'src/data/dimension_values.json',
    'src/data/skills.json',
    'src/data/personality_clusters.json',
    'src/data/scenarioBatches.json',
    'src/data/ai_relevance_ranking.json',
  ];
  for (const rel of requiredDataFiles) {
    const filePath = path.join(PROJECT_ROOT, rel);
    requireFile(filePath, rel);
  }

  const scenarioStep1 = process.env.BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE;
  const scenarioStep3 = process.env.BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE;
  if (!scenarioStep1 || scenarioStep1.trim() === '') {
    exit('BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE is required. Set it in .env (e.g. conf/scenario_step1.txt).');
  }
  if (!scenarioStep3 || scenarioStep3.trim() === '') {
    exit('BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE is required. Set it in .env (e.g. conf/scenario_step3.txt).');
  }
  const step1Path = resolvePath(scenarioStep1);
  const step3Path = resolvePath(scenarioStep3);
  if (!step1Path) {
    exit('BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE must be a valid path. Set it in .env (e.g. conf/scenario_step1.txt).');
  }
  if (!step3Path) {
    exit('BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE must be a valid path. Set it in .env (e.g. conf/scenario_step3.txt).');
  }
  requireFile(step1Path, 'Scenario step 1 instructions');
  requireFile(step3Path, 'Scenario step 3 instructions');

  const skillWeightRaw = (process.env.OCCUPATION_SKILL_WEIGHT || '').trim();
  const dimensionWeightRaw = (process.env.OCCUPATION_DIMENSION_WEIGHT || '').trim();
  if (skillWeightRaw === '') {
    exit('OCCUPATION_SKILL_WEIGHT is required. Set it in .env (e.g. 0.6). See env.example.');
  }
  if (dimensionWeightRaw === '') {
    exit('OCCUPATION_DIMENSION_WEIGHT is required. Set it in .env (e.g. 0.4). See env.example.');
  }
  const skillWeight = parseFloat(skillWeightRaw, 10);
  const dimensionWeight = parseFloat(dimensionWeightRaw, 10);
  if (Number.isNaN(skillWeight) || skillWeight < 0 || skillWeight > 1) {
    exit(`OCCUPATION_SKILL_WEIGHT must be a number between 0 and 1. Got: ${skillWeightRaw}`);
  }
  if (Number.isNaN(dimensionWeight) || dimensionWeight < 0 || dimensionWeight > 1) {
    exit(`OCCUPATION_DIMENSION_WEIGHT must be a number between 0 and 1. Got: ${dimensionWeightRaw}`);
  }
  const sum = skillWeight + dimensionWeight;
  if (Math.abs(sum - 1) > 1e-6) {
    exit(`OCCUPATION_SKILL_WEIGHT and OCCUPATION_DIMENSION_WEIGHT must sum to 1. Got: ${skillWeight} + ${dimensionWeight} = ${sum}. Set both in .env (e.g. 0.6 and 0.4). See env.example.`);
  }
}

/** Default timeout (ms) for startup LLM check when BFT_STARTUP_LLM_CHECK_TIMEOUT_MS is unset. Documented in env.example. */
const DEFAULT_STARTUP_LLM_CHECK_TIMEOUT_MS = 60000;

function getStartupLlmCheckTimeoutMs() {
  const raw = (process.env.BFT_STARTUP_LLM_CHECK_TIMEOUT_MS || '').trim();
  if (raw === '') return DEFAULT_STARTUP_LLM_CHECK_TIMEOUT_MS;
  const ms = parseInt(raw, 10);
  if (Number.isNaN(ms) || ms < 1000) return DEFAULT_STARTUP_LLM_CHECK_TIMEOUT_MS;
  return ms;
}

/**
 * Run LLM connectivity check: ensures the configured model is reachable and responds.
 * Exits on failure when LLM is enabled; no-op when LLM is disabled.
 * Uses a timeout so startup does not hang if the model or network is slow.
 */
async function runLlmConnectivityCheck() {
  const llmConfig = require('../../config/llm');
  const { runLlmCheckup } = require('./llmCheckup');
  if (!llmConfig.enabled) {
    console.log('[startup] LLM check skipped (not enabled).');
    return;
  }
  const timeoutMs = getStartupLlmCheckTimeoutMs();
  console.log('[startup] Checking LLM connectivity (model: %s, timeout: %dms)...', llmConfig.model, timeoutMs);
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`No response within ${timeoutMs / 1000}s`)),
      timeoutMs
    );
  });
  try {
    await Promise.race([runLlmCheckup(), timeoutPromise]);
    console.log('[startup] LLM check passed.');
  } catch (err) {
    exit(
      `LLM checkup failed (model: ${llmConfig.model}). ${err.message}. ` +
        'Check LLM_BASE_URL, LLM_MODEL, and that the model is available. ' +
        'For slow or cold-start models, set BFT_STARTUP_LLM_CHECK_TIMEOUT_MS in .env (see env.example).'
    );
  }
}

/**
 * Run all startup checks. Exits the process on failure.
 * @param {object} config - Server config
 */
async function runStartupChecks(config) {
  runFileAndDirChecks(config);
  await runLlmConnectivityCheck();
}

module.exports = {
  runStartupChecks,
  runFileAndDirChecks,
  runLlmConnectivityCheck,
};
