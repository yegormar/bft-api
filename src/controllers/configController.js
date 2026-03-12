const config = require('../../config');
const assessmentConfig = require('../../config/assessment');

/**
 * GET /api/config
 * Returns app config the frontend needs. No defaults; all values from env.
 * assessmentMode: 'triangles' | 'scenarios' so the UI can show the triangle explainer when needed.
 * bandsRanges: from BFT_BANDS_RANGES_FILE; band ranges for 1-5 scale (skills, dimensions, match label and tile color).
 */
function getConfig(req, res) {
  res.json({
    assessmentMode: assessmentConfig.getAssessmentMode(),
    bandsRanges: config.getBandsRanges(),
  });
}

module.exports = {
  getConfig,
};
