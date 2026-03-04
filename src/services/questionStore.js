/**
 * File-based persistent question store keyed by profile, and per-user "used" tracking.
 * When BFT_QUESTIONS_STORE_DIR is unset, save/list are no-ops and used tracking is in-memory only.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** In-memory used sets when store is disabled (userId -> Set of contentHash). */
const usedByUserInMemory = new Map();

/**
 * Canonical object for profile (sorted keys at each level) for stable hashing.
 * @param {object | null} preSurveyProfile
 * @returns {object}
 */
function canonicalProfile(preSurveyProfile) {
  if (preSurveyProfile == null || typeof preSurveyProfile !== 'object') {
    return {};
  }
  if (Array.isArray(preSurveyProfile)) {
    return preSurveyProfile.map(canonicalProfile);
  }
  const keys = Object.keys(preSurveyProfile).sort();
  const obj = {};
  for (const k of keys) {
    const v = preSurveyProfile[k];
    if (v !== undefined) {
      obj[k] = v !== null && typeof v === 'object' ? canonicalProfile(v) : v;
    }
  }
  return obj;
}

/**
 * Profile key for directory naming (safe, stable).
 * @param {object | null} preSurveyProfile
 * @returns {string}
 */
function getProfileKey(preSurveyProfile) {
  const canonical = JSON.stringify(canonicalProfile(preSurveyProfile));
  const hash = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return hash.slice(0, 16);
}

/**
 * Content hash for a question (title + option texts, stable order) for dedup and "used" tracking.
 * @param {{ title?: string, options?: Array<{ text?: string }> }} question
 * @returns {string}
 */
function computeContentHash(question) {
  const title = (question && question.title) || '';
  const options = (question && question.options) || [];
  const optionTexts = options.map((o) => (o && o.text) || '').sort();
  const payload = title + '\n' + optionTexts.join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Save a generated question to the store. No-op if storeDir is null.
 * @param {string | null} storeDir
 * @param {string} profileKey
 * @param {object} question - { title, description?, type, options }
 * @param {Array<object>} dimensionSet
 * @param {string | null} assessmentSummary
 */
function save(storeDir, profileKey, question, dimensionSet, assessmentSummary) {
  if (!storeDir) return;
  try {
    const contentHash = computeContentHash(question);
    const createdAt = new Date().toISOString();
    const safeCreated = createdAt.replace(/:/g, '-');
    const dir = path.join(storeDir, profileKey);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${safeCreated}_${contentHash.slice(0, 16)}.json`;
    const filePath = path.join(dir, filename);
    const data = {
      question,
      dimensionSet,
      assessmentSummary: assessmentSummary ?? null,
      profileKey,
      createdAt,
      contentHash,
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 0), 'utf8');
    const titleShort = (question.title && question.title.slice(0, 50)) || '';
    console.log('[bft] store saved profileKey=%s contentHash=%s title="%s"', profileKey, contentHash.slice(0, 12), titleShort);
  } catch (err) {
    console.warn('[bft] store save failed profileKey=%s err=%s', profileKey, err.message);
  }
}

/**
 * List stored questions for a profile, sorted by createdAt ascending (oldest first).
 * Returns [] if storeDir is null or on error.
 * @param {string | null} storeDir
 * @param {string} profileKey
 * @returns {Array<{ question: object, dimensionSet: Array<object>, assessmentSummary: string | null, createdAt: string, contentHash: string }>}
 */
function listByProfile(storeDir, profileKey) {
  if (!storeDir) return [];
  try {
    const dir = path.join(storeDir, profileKey);
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const items = [];
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const data = JSON.parse(raw);
        if (data.question && Array.isArray(data.dimensionSet) && data.createdAt) {
          items.push({
            question: data.question,
            dimensionSet: data.dimensionSet,
            assessmentSummary: data.assessmentSummary ?? null,
            createdAt: data.createdAt,
            contentHash: data.contentHash || computeContentHash(data.question),
          });
        }
      } catch {
        // skip invalid file
      }
    }
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return items;
  } catch (err) {
    console.warn('[questionStore] listByProfile failed:', err.message);
    return [];
  }
}

/**
 * Get set of content hashes already used by this user. Persisted under storeDir/used when storeDir is set.
 * @param {string | null} storeDir
 * @param {string} userId - bftUserId (ULID)
 * @returns {Set<string>}
 */
function getUsedSet(storeDir, userId) {
  if (storeDir) {
    try {
      const usedDir = path.join(storeDir, 'used');
      const filePath = path.join(usedDir, `${userId}.json`);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
      }
    } catch (err) {
      console.warn('[questionStore] getUsedSet failed:', err.message);
    }
    return new Set();
  }
  if (!usedByUserInMemory.has(userId)) {
    usedByUserInMemory.set(userId, new Set());
  }
  return usedByUserInMemory.get(userId);
}

/**
 * Mark a question as used by this user. Persists when storeDir is set.
 * @param {string | null} storeDir
 * @param {string} userId
 * @param {string} contentHash
 */
function markUsed(storeDir, userId, contentHash) {
  const used = getUsedSet(storeDir, userId);
  used.add(contentHash);
  if (storeDir) {
    try {
      const usedDir = path.join(storeDir, 'used');
      fs.mkdirSync(usedDir, { recursive: true });
      const filePath = path.join(usedDir, `${userId}.json`);
      const arr = Array.from(used);
      fs.writeFileSync(filePath, JSON.stringify(arr), 'utf8');
    } catch (err) {
      console.warn('[questionStore] markUsed persist failed:', err.message);
    }
  }
}

module.exports = {
  getProfileKey,
  computeContentHash,
  save,
  listByProfile,
  getUsedSet,
  markUsed,
};
