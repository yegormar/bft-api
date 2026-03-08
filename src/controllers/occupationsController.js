const occupationService = require('../lib/occupationService');

/**
 * GET /api/occupations?skillIds=id1,id2,... or ?skillIds=id1&skillIds=id2
 * Optional: groupBy=category returns { groups: [ { categoryKey, categoryLabel, occupations } ] }.
 * Otherwise returns flat list of { nocCode, name, matchScore, categoryKey, categoryLabel }.
 */
function listBySkills(req, res, next) {
  try {
    let skillIds = req.query.skillIds;
    const grouped = req.query.groupBy === 'category';
    if (skillIds == null) {
      res.json(grouped ? { groups: [] } : []);
      return;
    }
    if (!Array.isArray(skillIds)) {
      skillIds = String(skillIds).split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      skillIds = skillIds.map((s) => String(s).trim()).filter(Boolean);
    }
    const result = occupationService.scoreBySkillIds(skillIds, { grouped });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/occupations/:nocCode
 * Returns full occupation object or 404.
 */
function getByNocCode(req, res, next) {
  try {
    const { nocCode } = req.params;
    const occupation = occupationService.getByNocCode(nocCode);
    if (!occupation) {
      res.status(404).json({ error: 'Occupation not found' });
      return;
    }
    res.json(occupation);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listBySkills,
  getByNocCode,
};
