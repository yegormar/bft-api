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

  const requiredDataFiles = [
    'src/data/aptitudes.json',
    'src/data/traits.json',
    'src/data/values.json',
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
  const scenarioStep2 = process.env.BFT_SCENARIO_STEP2_INSTRUCTIONS_FILE;
  if (!scenarioStep1 || scenarioStep1.trim() === '') {
    exit('BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE is required. Set it in .env (e.g. conf/scenario_step1.txt).');
  }
  if (!scenarioStep2 || scenarioStep2.trim() === '') {
    exit('BFT_SCENARIO_STEP2_INSTRUCTIONS_FILE is required. Set it in .env (e.g. conf/scenario_step2.txt).');
  }
  let step1Path = resolvePath(scenarioStep1);
  if (!step1Path || !fs.existsSync(step1Path)) {
    step1Path = path.join(PROJECT_ROOT, 'conf', 'legacy', path.basename(scenarioStep1));
  }
  let step2Path = resolvePath(scenarioStep2);
  if (!step2Path || !fs.existsSync(step2Path)) {
    step2Path = path.join(PROJECT_ROOT, 'conf', 'legacy', path.basename(scenarioStep2));
  }
  requireFile(step1Path, 'Scenario step 1 instructions');
  requireFile(step2Path, 'Scenario step 2 instructions');
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
