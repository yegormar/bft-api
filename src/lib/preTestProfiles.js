/**
 * Synthetic pre-survey profiles for scenario prepopulation (admin tool).
 * Compatible with buildTailoringBlock in ollamaInterview and getProfileKey in questionStore.
 * Returns a deterministic sequence of profiles for round-robin use.
 */

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PERSONALITY_CLUSTERS_PATH = path.join(PROJECT_ROOT, 'src', 'data', 'personality_clusters.json');

let clustersCache = null;

function getClusterNames() {
  if (clustersCache) return clustersCache;
  try {
    const raw = fs.readFileSync(PERSONALITY_CLUSTERS_PATH, 'utf8');
    const data = JSON.parse(raw);
    clustersCache = (data.clusters || []).map((c) => c.name);
    return clustersCache;
  } catch {
    return ['neutral', 'gaming', 'technical', 'creative', 'social', 'strategic', 'adventurous', 'structured'];
  }
}

/** Age groups that map to complexityInstruction in clusterProfile (Q2). */
const AGE_GROUPS = [
  'High school',
  'College or university',
  'Working or done with school',
];

/** Gender options (Q1). Optional for tailoring. */
const GENDERS = ['She / Her', 'He / Him', 'They / Them', null];

/** Default tone (matches clusterProfile). */
const DEFAULT_TONE = 'Friendly but straightforward; no jokes needed.';

/** Complexity by age group (matches COMPLEXITY_INSTRUCTIONS in clusterProfile). */
const COMPLEXITY_BY_AGE = {
  'Middle school': 'Use simpler sentences and concrete, relatable examples.',
  'Middle school (or younger)': 'Use simpler sentences and concrete, relatable examples.',
  'High school': 'Use simpler sentences and concrete, relatable examples.',
  'College or university': 'You may use more abstract or professional situations if they fit.',
  'Working or done with school': 'You may use more abstract or professional situations if they fit.',
};

/**
 * Build a fixed set of synthetic preSurveyProfile objects.
 * Diverse combinations of dominant, secondary, secondaryTone, and demographics.
 * @returns {Array<object>} Array of preSurveyProfile objects (dominant, secondary, secondaryTone, demographics, toneInstruction, complexityInstruction).
 */
function getPreTestProfiles() {
  const names = getClusterNames();
  const nonNeutral = names.filter((n) => n !== 'neutral');
  const profiles = [];

  // Single dominant: neutral only
  profiles.push({
    dominant: ['neutral'],
    secondary: [],
    secondaryTone: 'neutral',
    demographics: { ageGroup: 'High school', gender: null },
    toneInstruction: DEFAULT_TONE,
    complexityInstruction: COMPLEXITY_BY_AGE['High school'] ?? null,
  });

  // Single dominant: each non-neutral cluster, one age group
  for (const d of nonNeutral.slice(0, 6)) {
    profiles.push({
      dominant: [d],
      secondary: [],
      secondaryTone: 'neutral',
      demographics: { ageGroup: 'College or university', gender: null },
      toneInstruction: DEFAULT_TONE,
      complexityInstruction: COMPLEXITY_BY_AGE['College or university'] ?? null,
    });
  }

  // Dominant + secondary pairs (subset for variety)
  const pairs = [
    ['neutral', 'creative'],
    ['gaming', 'strategic'],
    ['technical', 'structured'],
    ['creative', 'social'],
    ['adventurous', 'creative'],
    ['structured', 'neutral'],
  ];
  for (const [d, s] of pairs) {
    if (!names.includes(d) || !names.includes(s)) continue;
    profiles.push({
      dominant: [d],
      secondary: [s],
      secondaryTone: 'neutral',
      demographics: { ageGroup: 'Working or done with school', gender: null },
      toneInstruction: DEFAULT_TONE,
      complexityInstruction: COMPLEXITY_BY_AGE['Working or done with school'] ?? null,
    });
  }

  // Vary secondaryTone and demographics
  for (const age of AGE_GROUPS) {
    profiles.push({
      dominant: ['neutral'],
      secondary: ['creative'],
      secondaryTone: 'adventurous',
      demographics: { ageGroup: age, gender: GENDERS[0] },
      toneInstruction: DEFAULT_TONE,
      complexityInstruction: COMPLEXITY_BY_AGE[age] ?? null,
    });
  }
  for (const age of AGE_GROUPS) {
    profiles.push({
      dominant: ['strategic'],
      secondary: ['technical'],
      secondaryTone: 'structured',
      demographics: { ageGroup: age, gender: null },
      toneInstruction: DEFAULT_TONE,
      complexityInstruction: COMPLEXITY_BY_AGE[age] ?? null,
    });
  }

  return profiles;
}

module.exports = {
  getPreTestProfiles,
  getClusterNames,
};
