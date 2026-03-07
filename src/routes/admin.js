/**
 * Admin routes for scenario store (stats, list, delete).
 * Mounted at /api/admin only when BFT_ADMIN_ENABLED=1.
 */

const router = require('express').Router();
const adminController = require('../controllers/adminController');

router.get('/scenarios/stats', adminController.getStats);
router.get('/scenarios/profile-keys', adminController.getProfileKeys);
router.get('/scenarios', adminController.listScenarios);
router.delete('/scenarios/:profileKey/:contentHash', adminController.deleteScenario);

module.exports = router;
