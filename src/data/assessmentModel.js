/**
 * Loads assessment model JSON files from src/data (fixed path relative to this module).
 * Exposes lists and by-id lookups for aptitudes, traits, values, skills.
 * No defaults in code: paths are fixed to this directory.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname);

function loadJson(filename) {
  const filePath = path.join(DATA_DIR, filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

let cached = null;

function load() {
  if (cached) return cached;
  const aptitudesData = loadJson('aptitudes.json');
  const traitsData = loadJson('traits.json');
  const valuesData = loadJson('values.json');
  const skillsData = loadJson('skills.json');

  const aptitudes = aptitudesData.aptitudes || [];
  const traits = traitsData.traits || [];
  const values = valuesData.values || [];
  const skills = skillsData.skills || [];

  const byId = (arr) => {
    const map = new Map();
    arr.forEach((item) => map.set(item.id, item));
    return map;
  };

  cached = {
    aptitudes,
    traits,
    values,
    skills,
    aptitudesById: byId(aptitudes),
    traitsById: byId(traits),
    valuesById: byId(values),
    skillsById: byId(skills),
  };
  return cached;
}

/**
 * All dimensions as a flat list with type: { dimensionType, dimensionId, ...fields }.
 */
function getAllDimensions() {
  const m = load();
  const list = [];
  m.aptitudes.forEach((a) => list.push({ dimensionType: 'aptitude', dimensionId: a.id, ...a }));
  m.traits.forEach((t) => list.push({ dimensionType: 'trait', dimensionId: t.id, ...t }));
  m.values.forEach((v) => list.push({ dimensionType: 'value', dimensionId: v.id, ...v }));
  m.skills.forEach((s) => list.push({ dimensionType: 'skill', dimensionId: s.id, ...s }));
  return list;
}

function getDimension(dimensionType, dimensionId) {
  const m = load();
  switch (dimensionType) {
    case 'aptitude':
      return m.aptitudesById.get(dimensionId) ?? null;
    case 'trait':
      return m.traitsById.get(dimensionId) ?? null;
    case 'value':
      return m.valuesById.get(dimensionId) ?? null;
    case 'skill':
      return m.skillsById.get(dimensionId) ?? null;
    default:
      return null;
  }
}

module.exports = {
  load,
  getAllDimensions,
  getDimension,
};
