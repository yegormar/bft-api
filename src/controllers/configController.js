/**
 * GET /api/config
 * Returns app config the frontend needs. No defaults; all values from env.
 */
function getConfig(req, res) {
  res.json({});
}

module.exports = {
  getConfig,
};
