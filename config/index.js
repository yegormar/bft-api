/**
 * Server config. All values must be set in .env; no code defaults.
 * See env.example. Invalid or missing required vars cause process exit.
 */

require('dotenv').config();

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

module.exports = {
  port,
  nodeEnv,
  corsOrigin,
  questionsStoreDir,
};
