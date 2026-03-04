/**
 * Select best question from store candidates by dimension overlap.
 * Pure function: filters out used, scores by match to desired dimensions, returns best or null.
 *
 * @param {Array<{ question: object, dimensionSet: Array<{ dimensionType: string, dimensionId: string }>, assessmentSummary: string | null, createdAt: string, contentHash: string }>} candidates - from listByProfile (same profile)
 * @param {Set<string>} usedSet - content hashes already used for this user (bftUserId)
 * @param {Array<{ dimensionType: string, dimensionId: string }>} desiredDimensionSet - dimensions we want to measure (e.g. from selectNextDimensionSet)
 * @returns {{ question: object, dimensionSet: Array<object>, assessmentSummary: string | null } | null}
 */
function selectBestFromStore(candidates, usedSet, desiredDimensionSet) {
  const desiredKeys = new Set(
    (desiredDimensionSet || []).map((d) => `${d.dimensionType}:${d.dimensionId}`)
  );

  const unused = (candidates || []).filter((item) => !usedSet.has(item.contentHash));
  if (unused.length === 0) return null;

  let best = null;
  let bestScore = -1;
  let bestCreatedAt = '';

  for (const item of unused) {
    const dimSet = item.dimensionSet || [];
    const score = dimSet.filter(
      (d) => desiredKeys.has(`${d.dimensionType}:${d.dimensionId}`)
    ).length;
    const createdAt = item.createdAt || '';
    if (score > bestScore || (score === bestScore && createdAt < bestCreatedAt)) {
      bestScore = score;
      bestCreatedAt = createdAt;
      best = item;
    }
  }

  if (!best) return null;
  return {
    question: best.question,
    dimensionSet: best.dimensionSet,
    assessmentSummary: best.assessmentSummary ?? null,
  };
}

module.exports = { selectBestFromStore };
