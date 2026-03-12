/**
 * Server config. All values must be set in .env; no code defaults.
 * See env.example. Invalid or missing required vars cause process exit.
 * .env is loaded from bft-api directory so config check runs correctly regardless of cwd.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function exit(message) {
  console.error('[config]', message);
  process.exit(1);
}

const portRaw = process.env.PORT;
if (portRaw === undefined || portRaw === '') {
  exit('PORT is required. Set it in .env (see env.example).');
}
const port = parseInt(portRaw, 10);
if (Number.isNaN(port) || port < 1 || port > 65535) {
  exit(`PORT must be a number 1-65535. Got: ${portRaw}`);
}

const nodeEnv = process.env.NODE_ENV;
if (nodeEnv === undefined || nodeEnv === '') {
  exit('NODE_ENV is required. Set it in .env (e.g. development or production).');
}
const allowedEnv = ['development', 'production', 'test'];
if (!allowedEnv.includes(nodeEnv)) {
  exit(`NODE_ENV must be one of: ${allowedEnv.join(', ')}. Got: ${nodeEnv}`);
}

const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin === undefined || corsOrigin === '') {
  exit('CORS_ORIGIN is required. Set it in .env (e.g. http://localhost:3000).');
}

const questionsStoreDirRaw = process.env.BFT_QUESTIONS_STORE_DIR;
if (questionsStoreDirRaw === undefined || questionsStoreDirRaw === '') {
  exit('BFT_QUESTIONS_STORE_DIR is required. Set it in .env (e.g. ./data/questions-store).');
}
const questionsStoreDir = questionsStoreDirRaw.trim();
if (questionsStoreDir === '') {
  exit('BFT_QUESTIONS_STORE_DIR must be non-empty. Set it in .env (e.g. ./data/questions-store).');
}

const feedbackFileRaw = process.env.BFT_FEEDBACK_FILE;
if (feedbackFileRaw === undefined || feedbackFileRaw === '') {
  exit('BFT_FEEDBACK_FILE is required. Set it in .env (see env.example).');
}
const feedbackFile = feedbackFileRaw.trim();
if (feedbackFile === '') {
  exit('BFT_FEEDBACK_FILE must be non-empty. Set it in .env (e.g. ./data/feedback.jsonl).');
}

const careerPathsStep1Raw = process.env.CAREERS_LLM_STEP1_PROMPT_FILE;
if (careerPathsStep1Raw === undefined || String(careerPathsStep1Raw).trim() === '') {
  exit('CAREERS_LLM_STEP1_PROMPT_FILE is required. Set it in .env (e.g. conf/career_paths_step1.txt). See env.example.');
}
const careerPathsStep1Path = path.isAbsolute(careerPathsStep1Raw) ? careerPathsStep1Raw : path.join(__dirname, '..', careerPathsStep1Raw.trim());
if (!fs.existsSync(careerPathsStep1Path) || !fs.statSync(careerPathsStep1Path).isFile()) {
  exit(`CAREERS_LLM_STEP1_PROMPT_FILE must point to an existing file. Got: ${careerPathsStep1Raw}. Resolved: ${careerPathsStep1Path}. Set it in .env (e.g. conf/career_paths_step1.txt).`);
}

const careerPathsStep2Raw = process.env.CAREERS_LLM_STEP2_PROMPT_FILE;
if (careerPathsStep2Raw === undefined || String(careerPathsStep2Raw).trim() === '') {
  exit('CAREERS_LLM_STEP2_PROMPT_FILE is required. Set it in .env (e.g. conf/career_paths_step2.txt). See env.example.');
}
const careerPathsStep2Path = path.isAbsolute(careerPathsStep2Raw) ? careerPathsStep2Raw : path.join(__dirname, '..', careerPathsStep2Raw.trim());
if (!fs.existsSync(careerPathsStep2Path) || !fs.statSync(careerPathsStep2Path).isFile()) {
  exit(`CAREERS_LLM_STEP2_PROMPT_FILE must point to an existing file. Got: ${careerPathsStep2Raw}. Resolved: ${careerPathsStep2Path}. Set it in .env (e.g. conf/career_paths_step2.txt).`);
}

const careerPathsAiContextRaw = process.env.CAREERS_LLM_AI_CONTEXT_FILE;
if (careerPathsAiContextRaw === undefined || String(careerPathsAiContextRaw).trim() === '') {
  exit('CAREERS_LLM_AI_CONTEXT_FILE is required. Set it in .env (e.g. conf/report_ai_context.txt). See env.example.');
}
const careerPathsAiContextPath = path.isAbsolute(careerPathsAiContextRaw) ? careerPathsAiContextRaw : path.join(__dirname, '..', careerPathsAiContextRaw.trim());
if (!fs.existsSync(careerPathsAiContextPath) || !fs.statSync(careerPathsAiContextPath).isFile()) {
  exit(`CAREERS_LLM_AI_CONTEXT_FILE must point to an existing file. Got: ${careerPathsAiContextRaw}. Resolved: ${careerPathsAiContextPath}. Set it in .env (e.g. conf/report_ai_context.txt).`);
}

const bandsRangesFileRaw = process.env.BFT_BANDS_RANGES_FILE;
if (bandsRangesFileRaw === undefined || String(bandsRangesFileRaw).trim() === '') {
  exit('BFT_BANDS_RANGES_FILE is required. Set it in .env (e.g. conf/bands_ranges.json). See env.example.');
}
const bandsRangesFilePath = path.isAbsolute(bandsRangesFileRaw) ? bandsRangesFileRaw : path.join(__dirname, '..', bandsRangesFileRaw.trim());
if (!fs.existsSync(bandsRangesFilePath) || !fs.statSync(bandsRangesFilePath).isFile()) {
  exit(`BFT_BANDS_RANGES_FILE must point to an existing file. Got: ${bandsRangesFileRaw}. Resolved: ${bandsRangesFilePath}. Set it in .env (e.g. conf/bands_ranges.json).`);
}
let bandsRangesCache = null;
function getBandsRanges() {
  if (bandsRangesCache) return bandsRangesCache;
  const raw = fs.readFileSync(bandsRangesFilePath, 'utf8');
  const data = JSON.parse(raw);
  const bands = Array.isArray(data.bands) ? data.bands : [];
  if (bands.length === 0) {
    exit('BFT_BANDS_RANGES_FILE must define a non-empty "bands" array. See conf/bands_ranges.json.');
  }
  bands.forEach((b, i) => {
    if (!b || typeof b.id !== 'string' || typeof b.label !== 'string' || typeof b.min !== 'number' || typeof b.max !== 'number' || typeof b.maxInclusive !== 'boolean') {
      exit(`BFT_BANDS_RANGES_FILE bands[${i}] must have id (string), label (string), min (number), max (number), maxInclusive (boolean).`);
    }
  });
  bandsRangesCache = bands;
  return bandsRangesCache;
}

module.exports = {
  port,
  nodeEnv,
  corsOrigin,
  questionsStoreDir,
  feedbackFile,
  getCareerPathsStep1PromptPath: () => careerPathsStep1Path,
  getCareerPathsStep2PromptPath: () => careerPathsStep2Path,
  getCareerPathsAiContextPath: () => careerPathsAiContextPath,
  getBandsRanges,
};
