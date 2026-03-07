#!/usr/bin/env node
/**
 * Scenario prepopulation runner. Generates scenarios for synthetic pre-test profiles
 * until all dimensions are covered per profile, then rotates to the next profile.
 * Run from bft-api: node scripts/scenario-pregen.js [--once] [--profiles N]
 */

const path = require('path');

// Load config first so .env is loaded from bft-api (config uses path from its __dirname)
const config = require('../config');
require('../config/assessment');
require('../config/llm');

const assessmentService = require('../src/services/assessmentService');
const questionGenerator = require('../src/services/questionGeneration');
const questionStore = require('../src/services/questionStore');
const { getPreTestProfiles } = require('../src/lib/preTestProfiles');

const storeDir = config.questionsStoreDir;
if (!storeDir) {
  console.error('[scenario-pregen] BFT_QUESTIONS_STORE_DIR is not set.');
  process.exit(1);
}

const COVERAGE_KEY_BY_TYPE = { aptitude: 'aptitudes', trait: 'traits', value: 'values', skill: 'skills' };

function applyCoverage(coverage, dimensionSet) {
  for (const dim of dimensionSet) {
    const key = COVERAGE_KEY_BY_TYPE[dim.dimensionType];
    if (!key) continue;
    const id = dim.id ?? dim.dimensionId;
    if (!coverage[key]) coverage[key] = {};
    if (!coverage[key][id]) coverage[key][id] = { questionCount: 0, lastQuestionId: null };
    coverage[key][id].questionCount += 1;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let once = false;
  let profileCycles = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--once') once = true;
    if (args[i] === '--profiles' && args[i + 1] != null) {
      profileCycles = parseInt(args[i + 1], 10);
      if (Number.isNaN(profileCycles) || profileCycles < 1) profileCycles = 1;
      i += 1;
    }
  }
  return { once, profileCycles };
}

async function run() {
  const { once, profileCycles } = parseArgs();
  const interviewConfig = assessmentService.getInterviewConfig();
  const model = require('../src/data/assessmentModel').load();
  const profiles = getPreTestProfiles();

  console.log('[scenario-pregen] storeDir=%s profiles=%s once=%s profileCycles=%s', storeDir, profiles.length, once, profileCycles ?? 'infinite');
  let totalGenerated = 0;
  let profileIndex = 0;
  let cyclesDone = 0;

  const runOneProfile = async (profile) => {
    const profileKey = questionStore.getProfileKey(profile);
    const coverage = { aptitudes: {}, traits: {}, values: {}, skills: {} };
    const existing = questionStore.listByProfile(storeDir, profileKey);
    let askedQuestionTitles = existing.map((i) => i.question && i.question.title).filter(Boolean);
    let answers = existing.map((item, idx) => ({
      questionId: `scenario_${idx}`,
      value: (item.question && item.question.options && item.question.options[0] && item.question.options[0].value) || 'placeholder',
    }));
    for (const item of existing) {
      if (Array.isArray(item.dimensionSet)) applyCoverage(coverage, item.dimensionSet);
    }
    const existingHashes = new Set(existing.map((i) => i.contentHash || questionStore.computeContentHash(i.question)));
    let countThisProfile = 0;

    while (!assessmentService.isInterviewComplete(coverage, interviewConfig, model, 0)) {
      const dimensionSet = assessmentService.selectNextDimensionSet(coverage, model, { maxDimensions: 1 });
      if (dimensionSet.length === 0) break;

      const result = await questionGenerator.requestQuestion({
        sessionId: 'pregen',
        bftUserId: '',
        preSurveyProfile: profile,
        storeDir,
        desiredDimensionSet: dimensionSet,
        askedQuestionTitles,
        answers,
      });

      if (result && result.question && result.question.title) {
        const dimensionSetForState = result.dimensionSet || dimensionSet;
        const contentHash = questionStore.computeContentHash(result.question);
        const isDuplicate = existingHashes.has(contentHash);
        if (!isDuplicate) {
          questionStore.save(storeDir, profileKey, result.question, dimensionSetForState, result.assessmentSummary ?? null);
          existingHashes.add(contentHash);
          applyCoverage(coverage, dimensionSetForState);
          countThisProfile += 1;
          totalGenerated += 1;
          if (totalGenerated % 5 === 0 || countThisProfile <= 2) {
            const stats = questionStore.getStats(storeDir);
            console.log('[scenario-pregen] profileKey=%s countThisProfile=%s totalStore=%s', profileKey.slice(0, 8), countThisProfile, stats.totalScenarios);
          }
        } else {
          console.log('[scenario-pregen] skip duplicate profileKey=%s title="%s"', profileKey.slice(0, 8), (result.question.title || '').slice(0, 40));
        }
        askedQuestionTitles = [...askedQuestionTitles, result.question.title];
        const simValue = result.question.options && result.question.options[0] ? result.question.options[0].value : 'placeholder';
        answers = [...answers, { questionId: `scenario_${answers.length}`, value: simValue }];
      } else {
        const reason = result && result.reason ? result.reason : 'no question';
        console.warn('[scenario-pregen] skip profileKey=%s reason=%s', profileKey.slice(0, 8), reason);
      }
    }

    return countThisProfile;
  };

  const stats = questionStore.getStats(storeDir);
  console.log('[scenario-pregen] initial store total=%s', stats.totalScenarios);

  while (true) {
    if (profileCycles != null && cyclesDone >= profileCycles) break;
    const profile = profiles[profileIndex];
    const count = await runOneProfile(profile);
    const profileKey = questionStore.getProfileKey(profile);
    console.log('[scenario-pregen] profile complete profileIndex=%s profileKey=%s generated=%s', profileIndex, profileKey.slice(0, 8), count);

    const storeStats = questionStore.getStats(storeDir);
    console.log('[scenario-pregen] total scenarios in store=%s', storeStats.totalScenarios);

    profileIndex += 1;
    if (profileIndex >= profiles.length) {
      profileIndex = 0;
      cyclesDone += 1;
      if (once) break;
      console.log('[scenario-pregen] cycle %s complete, starting next cycle', cyclesDone);
    }
  }

  const finalStats = questionStore.getStats(storeDir);
  console.log('[scenario-pregen] done. totalScenarios=%s', finalStats.totalScenarios);
}

run().catch((err) => {
  console.error('[scenario-pregen]', err);
  process.exit(1);
});
