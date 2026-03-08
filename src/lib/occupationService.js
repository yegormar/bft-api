/**
 * NOC occupation lookup and scoring by skill IDs. Data-driven only (no LLM).
 * Data: noc-2021-enriched.json with skillMappings per occupation.
 * Uses noc-2021-major-groups.json for category labels (NOC major groups).
 */

const path = require('path');
const fs = require('fs');

const NOC_PATH = path.join(__dirname, '../data/noc-2021-enriched.json');
const MAJOR_GROUPS_PATH = path.join(__dirname, '../data/noc-2021-major-groups.json');
let nocCache = null;
let majorGroupsCache = null;

function loadNoc() {
  if (nocCache) return nocCache;
  const raw = fs.readFileSync(NOC_PATH, 'utf8');
  const data = JSON.parse(raw);
  const occupations = Array.isArray(data.occupations) ? data.occupations : [];
  nocCache = { occupations };
  return nocCache;
}

function loadMajorGroups() {
  if (majorGroupsCache) return majorGroupsCache;
  try {
    const raw = fs.readFileSync(MAJOR_GROUPS_PATH, 'utf8');
    const data = JSON.parse(raw);
    majorGroupsCache = data.majorGroups && typeof data.majorGroups === 'object' ? data.majorGroups : {};
  } catch {
    majorGroupsCache = {};
  }
  return majorGroupsCache;
}

/**
 * Get NOC major group key and label from a 5-digit nocCode (e.g. "21100" -> "21", "Professional in natural and applied sciences").
 */
function getCategoryFromNocCode(nocCode) {
  if (!nocCode || typeof nocCode !== 'string') return { categoryKey: '', categoryLabel: 'Other' };
  const key = nocCode.trim().substring(0, 2);
  const labels = loadMajorGroups();
  return {
    categoryKey: key,
    categoryLabel: labels[key] || `Category ${key}`,
  };
}

/**
 * Score occupations by a set of skill IDs. For each occupation, sum compatibilityRating
 * over skillMappings whose id is in skillIds. Returns list with matchScore, categoryKey,
 * categoryLabel, sorted by matchScore descending then by category.
 *
 * @param {string[]} skillIds - Skill IDs the user has selected (e.g. from time-investment buckets).
 * @param {object} [options] - Optional. grouped: true to return { groups } instead of flat list.
 * @returns {Array<{ nocCode, name, matchScore, categoryKey, categoryLabel }>|{ groups: Array<{ categoryKey, categoryLabel, occupations }> }}
 */
function scoreBySkillIds(skillIds, options = {}) {
  if (!Array.isArray(skillIds) || skillIds.length === 0) {
    return options.grouped ? { groups: [] } : [];
  }
  const idSet = new Set(skillIds.filter((id) => id && String(id).trim()));

  const { occupations } = loadNoc();
  const results = [];

  for (const occ of occupations) {
    if (!occ || !occ.nocCode) continue;
    const mappings = occ.skillMappings || [];
    let score = 0;
    for (const m of mappings) {
      if (m && m.id && idSet.has(m.id) && typeof m.compatibilityRating === 'number') {
        score += m.compatibilityRating;
      }
    }
    if (score > 0) {
      const { categoryKey, categoryLabel } = getCategoryFromNocCode(occ.nocCode);
      results.push({
        nocCode: occ.nocCode,
        name: occ.name || occ.nocCode,
        matchScore: score,
        categoryKey,
        categoryLabel,
      });
    }
  }

  results.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

  if (options.grouped) {
    const byCategory = new Map();
    for (const occ of results) {
      const k = occ.categoryKey || 'other';
      if (!byCategory.has(k)) {
        byCategory.set(k, { categoryKey: occ.categoryKey, categoryLabel: occ.categoryLabel, occupations: [] });
      }
      byCategory.get(k).occupations.push(occ);
    }
    const groups = Array.from(byCategory.values());
    groups.sort((a, b) => {
      const maxA = Math.max(...a.occupations.map((o) => o.matchScore || 0));
      const maxB = Math.max(...b.occupations.map((o) => o.matchScore || 0));
      if (maxB !== maxA) return maxB - maxA;
      return (a.categoryLabel || '').localeCompare(b.categoryLabel || '');
    });
    return { groups };
  }

  return results;
}

/**
 * Get full occupation by NOC code.
 *
 * @param {string} nocCode
 * @returns {object|null} Full occupation object or null.
 */
function getByNocCode(nocCode) {
  if (!nocCode || !String(nocCode).trim()) return null;
  const key = String(nocCode).trim();
  const { occupations } = loadNoc();
  return occupations.find((o) => o && o.nocCode === key) || null;
}

module.exports = {
  loadNoc,
  loadMajorGroups,
  getCategoryFromNocCode,
  scoreBySkillIds,
  getByNocCode,
};
