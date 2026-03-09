/**
 * Aii Bayesian Latent Trait Scorer (v3 + 5 zones)
 *
 * Fits one latent strength (theta) per dimension using all triangle responses jointly.
 * Uses Dirichlet likelihood with zone-aware concentration plus explicit rejection signal.
 *
 * Model:
 *   theta[d] ~ Normal(0, 1.5)
 *   Per triangle: Dirichlet(phi * softmax(theta[dims])) + rejection term for low-weight vertices.
 *
 * Zones (5): corner, near_corner, edge, near_edge, centre.
 * Inference: Metropolis-Hastings MCMC.
 */

const math = require('mathjs').create(require('mathjs').all);
const logGamma = (x) => math.lgamma(x);

const PRIOR_MEAN = 0;
const PRIOR_SCALE = 1.5;
const REJECTION_THRESHOLD = 0.15;
const REJECTION_TEMPERATURE = 0.6;

const ZONE_PHI = {
  corner: 12,
  near_corner: 9,
  edge: 5,
  near_edge: 4,
  centre: 2,
};

const REJECTION_STRENGTH = {
  corner: 1.0,
  near_corner: 0.9,
  edge: 0.7,
  near_edge: 0.7,
  centre: 0.0,
};

/**
 * Detect zone from compositional weights [a, b, c] (will be normalised).
 * Returns one of: corner, near_corner, edge, near_edge, centre.
 */
function detectZone(w, cornerThreshold = 0.7, edgeMinThreshold = 0.2, nearCornerMin = 0.55) {
  const arr = Array.isArray(w) ? w.slice() : [w.a, w.b, w.c].filter((x) => typeof x === 'number');
  if (arr.length !== 3) return 'centre';
  const sum = arr.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 'centre';
  const n = arr.map((x) => x / sum);
  const sorted = n.slice().sort((a, b) => b - a);
  const maxW = sorted[0];
  const minW = sorted[2];
  const midW = sorted[1];

  if (maxW >= cornerThreshold) return 'corner';
  if (minW < edgeMinThreshold) {
    if (maxW >= nearCornerMin) return 'near_corner';
    if (midW >= 0.35 && midW <= 0.65 && Math.abs(maxW - midW) < 0.2) return 'edge';
    return 'near_edge';
  }
  return 'centre';
}

/**
 * Softmax over a slice of theta (indices).
 */
function softmax(theta, indices) {
  const vals = indices.map((i) => theta[i]);
  const max = Math.max(...vals);
  const exp = vals.map((v) => Math.exp(v - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((e) => e / sum);
}

/**
 * Dirichlet log-pdf: log Dir(x | alpha). x and alpha are arrays of same length.
 */
function dirichletLogPdf(x, alpha) {
  const xNorm = x.slice();
  const s = xNorm.reduce((a, b) => a + b, 0);
  if (s <= 0) return -Infinity;
  for (let i = 0; i < xNorm.length; i++) xNorm[i] = Math.max(1e-9, Math.min(1, xNorm[i] / s));
  let logB = 0;
  const sumAlpha = alpha.reduce((a, b) => a + b, 0);
  try {
    logB = logGamma(sumAlpha) - alpha.reduce((acc, a) => acc + logGamma(a), 0);
  } catch (e) {
    return -Infinity;
  }
  const term = alpha.reduce((acc, a, i) => acc + (a - 1) * Math.log(xNorm[i]), 0);
  return logB + term;
}

/**
 * Log-sigmoid: log(1 / (1 + exp(-x))) = -log1p(exp(-x)).
 */
function logSigmoid(x) {
  if (x >= 0) return -Math.log1p(Math.exp(-x));
  return x - Math.log1p(Math.exp(x));
}

/**
 * Rejection log-likelihood: for each vertex with weight < threshold, add
 * strength * log_sigmoid((theta_dominant - theta_rejected) / temperature).
 */
function rejectionLogLik(theta, dimIndices, weights, zone) {
  const strength = REJECTION_STRENGTH[zone];
  if (strength === 0) return 0;
  let dominantIdx = 0;
  let maxW = weights[0];
  for (let i = 1; i < weights.length; i++) {
    if (weights[i] > maxW) {
      maxW = weights[i];
      dominantIdx = i;
    }
  }
  const thetaDominant = theta[dimIndices[dominantIdx]];
  let lp = 0;
  for (let i = 0; i < weights.length; i++) {
    if (i === dominantIdx) continue;
    if (weights[i] < REJECTION_THRESHOLD) {
      const thetaRej = theta[dimIndices[i]];
      const margin = (thetaDominant - thetaRej) / REJECTION_TEMPERATURE;
      lp += strength * logSigmoid(margin);
    }
  }
  return lp;
}

/**
 * Log posterior for full theta given list of triangles.
 * Each triangle: { dims: number[] (indices), weights: number[], zone: string }.
 */
function logPosterior(theta, triangles) {
  let lp = 0;
  for (let d = 0; d < theta.length; d++) {
    lp += normalLogPdf(theta[d], PRIOR_MEAN, PRIOR_SCALE);
  }
  for (const tri of triangles) {
    const dims = tri.dims;
    const weights = tri.weights;
    const zone = tri.zone || 'centre';
    const mu = softmax(theta, dims);
    const phi = ZONE_PHI[zone] ?? ZONE_PHI.centre;
    const alpha = mu.map((m) => phi * m);
    lp += dirichletLogPdf(weights, alpha);
    lp += rejectionLogLik(theta, dims, weights, zone);
  }
  return lp;
}

function normalLogPdf(x, mean, scale) {
  const z = (x - mean) / scale;
  return -0.5 * (Math.log(2 * Math.PI) + 2 * Math.log(scale) + z * z);
}

/**
 * Adaptive Metropolis-Hastings. Returns { samples: number[][], acceptanceRate: number }.
 */
function runMcmc(triangles, nDims, nSamples = 8000, nWarmup = 2000, seed = 42) {
  const rng = seededRng(seed);
  let theta = Array(nDims).fill(0);
  let lp = logPosterior(theta, triangles);
  let step = 0.3;
  const samples = [];
  let accepted = 0;
  const total = nSamples + nWarmup;

  for (let i = 0; i < total; i++) {
    const proposal = theta.map((t) => t + rng.normal(0, step));
    const lpProp = logPosterior(proposal, triangles);
    if (Math.log(rng.uniform()) < lpProp - lp) {
      theta = proposal;
      lp = lpProp;
      accepted += 1;
    }
    if (i < nWarmup && (i + 1) % 200 === 0) {
      const rate = accepted / (i + 1);
      step *= rate > 0.45 ? 1.2 : rate < 0.25 ? 0.8 : 1.0;
    }
    if (i >= nWarmup) samples.push(theta.slice());
  }
  return { samples, acceptanceRate: accepted / total };
}

function seededRng(seed) {
  let s = seed;
  return {
    uniform() {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    },
    normal(mu, sigma) {
      const u1 = this.uniform();
      const u2 = this.uniform();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return mu + sigma * z;
    },
  };
}

/**
 * Map posterior mean theta to [1, 5] preserving rank order.
 */
function thetaToScore15(samples) {
  const means = samples[0].map((_, d) => samples.reduce((s, row) => s + row[d], 0) / samples.length);
  const stds = samples[0].map((_, d) => {
    const m = means[d];
    const v = samples.reduce((s, row) => s + (row[d] - m) ** 2, 0) / samples.length;
    return Math.sqrt(v);
  });
  const lo = Math.min(...means);
  const hi = Math.max(...means);
  if (hi - lo < 1e-6) return { scores: means.map(() => 3), stds };
  const scores = means.map((m) => 1 + (4 * (m - lo)) / (hi - lo));
  return { scores, stds };
}

/**
 * Build dimension index map from list of dimension IDs (stable order).
 * Returns { dimIndex: { [id]: index }, dimIds: string[] }.
 */
function buildDimIndex(dimensionIds) {
  const ids = [...new Set(dimensionIds)].filter(Boolean).sort();
  const dimIndex = {};
  ids.forEach((id, i) => {
    dimIndex[id] = i;
  });
  return { dimIndex, dimIds: ids };
}

/**
 * Score triangle responses using Bayesian latent-trait model.
 *
 * @param {Array<{ dims: string[], weights: number[] }>} rawResponses - Each item: dims = [dimIdA, dimIdB, dimIdC], weights = [a, b, c] (normalised in [0,1], sum 1).
 * @param {Object} [options] - { dimIndex: { [dimId]: number }, nSamples, nWarmup, seed }
 * @returns {Object} - { profile: Array<{ dimension_id, score_1_to_5, theta_mean, theta_std, n_triangles }>, dimIds, mcmc_diagnostics }
 */
function scoreTriangleResponses(rawResponses, options = {}) {
  if (!Array.isArray(rawResponses) || rawResponses.length === 0) {
    return { profile: [], dimIds: [], mcmc_diagnostics: { note: 'No triangle responses' } };
  }

  const allDimIds = [];
  rawResponses.forEach((r) => {
    if (Array.isArray(r.dims)) r.dims.forEach((id) => allDimIds.push(id));
  });
  const { dimIndex, dimIds } = options.dimIndex
    ? { dimIndex: options.dimIndex, dimIds: Object.keys(options.dimIndex).sort() }
    : buildDimIndex(allDimIds);

  const nDims = dimIds.length;
  if (nDims === 0) return { profile: [], dimIds: [], mcmc_diagnostics: { note: 'No dimensions' } };

  const triangles = rawResponses.map((r) => {
    const dims = (r.dims || []).map((id) => dimIndex[id]);
    if (dims.some((i) => i === undefined)) return null;
    let w = (r.weights || []).slice();
    if (w.length !== 3) w = [r.a, r.b, r.c].filter((x) => typeof x === 'number');
    if (w.length !== 3) return null;
    const sum = w.reduce((a, b) => a + b, 0);
    const weights = sum > 0 ? w.map((x) => x / sum) : [1 / 3, 1 / 3, 1 / 3];
    const zone = r.zone || detectZone(weights);
    return { dims, weights, zone };
  }).filter(Boolean);

  if (triangles.length === 0) return { profile: [], dimIds, mcmc_diagnostics: { note: 'No valid triangles' } };

  const nSamples = options.nSamples ?? 8000;
  const nWarmup = options.nWarmup ?? 2000;
  const seed = options.seed ?? 42;
  const { samples, acceptanceRate } = runMcmc(triangles, nDims, nSamples, nWarmup, seed);
  const { scores, stds } = thetaToScore15(samples);
  const thetaMeans = samples[0].map((_, d) => samples.reduce((s, row) => s + row[d], 0) / samples.length);

  const appearances = {};
  triangles.forEach((tri) => {
    tri.dims.forEach((idx) => {
      const id = dimIds[idx];
      appearances[id] = (appearances[id] || 0) + 1;
    });
  });

  const profile = dimIds.map((dimensionId, idx) => ({
    dimension_id: dimensionId,
    score_1_to_5: Math.round(scores[idx] * 100) / 100,
    theta_mean: Math.round(thetaMeans[idx] * 1000) / 1000,
    theta_std: Math.round(stds[idx] * 1000) / 1000,
    n_triangles: appearances[dimensionId] || 0,
  }));

  return {
    profile,
    dimIds,
    mcmc_diagnostics: {
      acceptance_rate: Math.round(acceptanceRate * 1000) / 1000,
      n_samples: samples.length,
      n_triangles: triangles.length,
      note: 'Target acceptance 0.25–0.45 for well-tuned MH',
    },
  };
}

module.exports = {
  detectZone,
  scoreTriangleResponses,
  buildDimIndex,
  ZONE_PHI,
  REJECTION_STRENGTH,
};
