/**
 * Loads assessment model JSON files from src/data (fixed path relative to this module).
 * Dimension data: dimension_aptitudes.json, dimension_traits.json, dimension_values.json
 * (each element has a single id that is the unique dimension id, e.g. aptitude_*, trait_*, value_*).
 * Skills use skills.json (id only). Exposes lists and by-id lookups.
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
  const aptitudesData = loadJson('dimension_aptitudes.json');
  const traitsData = loadJson('dimension_traits.json');
  const valuesData = loadJson('dimension_values.json');
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

  const allDimensionItems = [
    ...aptitudes.map((a) => ({ ...a, _type: 'aptitude' })),
    ...traits.map((t) => ({ ...t, _type: 'trait' })),
    ...values.map((v) => ({ ...v, _type: 'value' })),
    ...skills.map((s) => ({ ...s, _type: 'skill' })),
  ];
  const dimensionsById = new Map();
  allDimensionItems.forEach((item) => dimensionsById.set(item.id, item));

  cached = {
    aptitudes,
    traits,
    values,
    skills,
    aptitudesById: byId(aptitudes),
    traitsById: byId(traits),
    valuesById: byId(values),
    skillsById: byId(skills),
    dimensionsById,
  };
  return cached;
}

/**
 * All dimensions as a flat list with type: { dimensionType, dimensionId, ...fields }.
 * dimensionId is the same as id (single id per dimension).
 */
function getAllDimensions() {
  const m = load();
  const list = [];
  const withType = (item, type) => ({ dimensionType: type, dimensionId: item.id, ...item });
  m.aptitudes.forEach((a) => list.push(withType(a, 'aptitude')));
  m.traits.forEach((t) => list.push(withType(t, 'trait')));
  m.values.forEach((v) => list.push(withType(v, 'value')));
  m.skills.forEach((s) => list.push(withType(s, 'skill')));
  return list;
}

function getDimension(dimensionType, id) {
  const m = load();
  return m.dimensionsById.get(id) ?? null;
}

module.exports = {
  load,
  getAllDimensions,
  getDimension,
};
