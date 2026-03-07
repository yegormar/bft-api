/**
 * Admin controller for scenario store: stats, list, delete.
 * Only mounted when BFT_ADMIN_ENABLED=1.
 */

const config = require('../../config');
const questionStore = require('../services/questionStore');

const storeDir = config.questionsStoreDir;

function getStats(req, res, next) {
  try {
    if (!storeDir) {
      res.status(503).json({ error: 'Questions store not configured' });
      return;
    }
    const stats = questionStore.getStats(storeDir);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}

function listScenarios(req, res, next) {
  try {
    if (!storeDir) {
      res.status(503).json({ error: 'Questions store not configured' });
      return;
    }
    const options = {};
    if (req.query.profileKey) options.profileKey = req.query.profileKey;
    if (req.query.dimensionType) options.dimensionType = req.query.dimensionType;
    if (req.query.dimensionId) options.dimensionId = req.query.dimensionId;
    if (req.query.createdAfter) options.createdAfter = req.query.createdAfter;
    if (req.query.createdBefore) options.createdBefore = req.query.createdBefore;
    if (req.query.limit !== undefined) {
      const n = parseInt(req.query.limit, 10);
      if (!Number.isNaN(n) && n > 0) options.limit = n;
    }
    const items = questionStore.listAll(storeDir, options);
    res.json({ scenarios: items, count: items.length });
  } catch (err) {
    next(err);
  }
}

function deleteScenario(req, res, next) {
  try {
    if (!storeDir) {
      res.status(503).json({ error: 'Questions store not configured' });
      return;
    }
    const { profileKey, contentHash } = req.params;
    if (!profileKey || !contentHash) {
      res.status(400).json({ error: 'profileKey and contentHash required' });
      return;
    }
    const result = questionStore.delete(storeDir, profileKey, contentHash);
    if (result.deleted) {
      res.status(200).json({ deleted: true });
    } else {
      res.status(404).json({ deleted: false, message: result.message || 'not found' });
    }
  } catch (err) {
    next(err);
  }
}

function getProfileKeys(req, res, next) {
  try {
    if (!storeDir) {
      res.status(503).json({ error: 'Questions store not configured' });
      return;
    }
    const keys = questionStore.listProfileKeys(storeDir);
    res.json({ profileKeys: keys });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getStats,
  listScenarios,
  deleteScenario,
  getProfileKeys,
};
