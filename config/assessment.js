/**
 * Assessment and pregen config. All values read from env; validated when module loads.
 * No defaults in application code. Set required vars in .env (see env_dev / env.example).
 * Optional: MAX_INTERVIEW_QUESTIONS (unset = no cap), BFT_DEV_MAX_QUESTIONS (when set, caps questions in any env).
 */

const config = require('./index');

function exit(message) {
  console.error('[config/assessment]', message);
  process.exit(1);
}

function getPregenConfig() {
  const capRaw = process.env.BFT_PREGEN_QUEUE_CAP;
  if (capRaw === undefined || capRaw === '') {
    exit('BFT_PREGEN_QUEUE_CAP is required. Set it in .env (see env_dev). Example: 5');
  }
  const refillRaw = process.env.BFT_PREGEN_REFILL_THRESHOLD;
  if (refillRaw === undefined || refillRaw === '') {
    exit('BFT_PREGEN_REFILL_THRESHOLD is required. Set it in .env (see env_dev). Example: 1');
  }
  const queueCap = parseInt(capRaw, 10);
  const refill = parseInt(refillRaw, 10);
  if (Number.isNaN(queueCap) || queueCap < 0) {
    exit(`BFT_PREGEN_QUEUE_CAP must be a non-negative number. Got: ${capRaw}`);
  }
  if (Number.isNaN(refill) || refill < 0) {
    exit(`BFT_PREGEN_REFILL_THRESHOLD must be a non-negative number. Got: ${refillRaw}`);
  }
  const refillThreshold = Math.min(refill, Math.max(0, queueCap - 1));
  return { queueCap, refillThreshold };
}

function getInterviewConfig() {
  const minRaw = process.env.MIN_SIGNAL_PER_DIMENSION;
  if (minRaw === undefined || minRaw === '') {
    exit('MIN_SIGNAL_PER_DIMENSION is required. Set it in .env (see env_dev). Example: 1');
  }
  const minSignal = parseInt(minRaw, 10);
  if (Number.isNaN(minSignal) || minSignal < 1) {
    exit(`MIN_SIGNAL_PER_DIMENSION must be a positive integer. Got: ${minRaw}`);
  }

  let maxQuestions;
  const devMaxRaw = process.env.BFT_DEV_MAX_QUESTIONS;
  if (devMaxRaw !== undefined && devMaxRaw !== '') {
    const devMax = parseInt(devMaxRaw, 10);
    if (Number.isNaN(devMax) || devMax < 1) {
      exit(`BFT_DEV_MAX_QUESTIONS must be a positive integer when set. Got: ${devMaxRaw}`);
    }
    maxQuestions = devMax;
  }
  if (maxQuestions == null) {
    const maxRaw = process.env.MAX_INTERVIEW_QUESTIONS;
    if (maxRaw !== undefined && maxRaw !== '') {
      const max = parseInt(maxRaw, 10);
      if (Number.isNaN(max) || max < 0) {
        exit(`MAX_INTERVIEW_QUESTIONS must be a non-negative integer when set. Got: ${maxRaw}`);
      }
      maxQuestions = max;
    }
  }
  return { minSignalPerDimension: minSignal, maxQuestions };
}

function validateOnLoad() {
  getPregenConfig();
  getInterviewConfig();
}

validateOnLoad();

module.exports = {
  getPregenConfig,
  getInterviewConfig,
};
