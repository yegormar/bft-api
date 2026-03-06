#!/usr/bin/env node
/**
 * Build NOC (National Occupational Classification) occupations JSON from the
 * NOC 2021 Elements CSV. Reads the local CSV and writes one JSON file with
 * nocCode, name, exampleTitles, mainDuties, employmentRequirements, additionalInformation.
 *
 * Run from the bft-api project root:
 *   node src/scripts/fetch-noc-occupations.js <elements.csv> <output.json>
 * Or set NOC_ELEMENTS_CSV and NOC_JSON_OUTPUT in scripts/.env (see scripts/scripts.env.example).
 *
 * Config: NOC_ELEMENTS_CSV (or first CLI arg) and NOC_JSON_OUTPUT (or second CLI arg) required.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const scriptsEnvPath = path.join(__dirname, '.env');
const projectEnvPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(projectEnvPath)) {
  require('dotenv').config({ path: projectEnvPath });
}
if (fs.existsSync(scriptsEnvPath)) {
  require('dotenv').config({ path: scriptsEnvPath, override: true });
}

const { parse } = require('csv-parse/sync');

const NOC_VERSION = '2021.0';

const LEVEL = 'Level';
const CODE = 'Code - NOC 2021 V1.0';
const CLASS_TITLE = 'Class title';
const ELEMENT_TYPE = 'Element Type Label English';
const ELEMENT_DESC = 'Element Description English';

const ELEMENT_TYPES = {
  ILLUSTRATIVE: 'Illustrative example(s)',
  ALL_EXAMPLES: 'All examples',
  MAIN_DUTIES: 'Main duties',
  EMPLOYMENT_REQUIREMENTS: 'Employment requirements',
  ADDITIONAL_INFO: 'Additional information',
  EXCLUSIONS: 'Exclusion(s)',
};

function exit(message) {
  console.error('[fetch-noc-occupations]', message);
  process.exit(1);
}

function getConfig() {
  const csvPath = process.argv[2] || process.env.NOC_ELEMENTS_CSV;
  const outputPath = process.argv[3] || process.env.NOC_JSON_OUTPUT;
  if (!csvPath || String(csvPath).trim() === '') {
    exit('CSV path is required. Set NOC_ELEMENTS_CSV in scripts/.env (see scripts/scripts.env.example) or pass as first argument (e.g. node fetch-noc-occupations.js ./docs/noc_2021_version_1.0_-_elements.csv ./data/noc-2021.json).');
  }
  if (!outputPath || String(outputPath).trim() === '') {
    exit('Output path is required. Set NOC_JSON_OUTPUT in scripts/.env (see scripts/scripts.env.example) or pass as second argument.');
  }
  const csvResolved = path.isAbsolute(csvPath) ? csvPath : path.resolve(process.cwd(), csvPath.trim());
  const outputResolved = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath.trim());
  if (!fs.existsSync(csvResolved)) {
    exit(`CSV file not found: ${csvResolved}`);
  }
  const outDir = path.dirname(outputResolved);
  if (outDir !== '.' && !fs.existsSync(outDir)) {
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (err) {
      exit(`Cannot create output directory: ${outDir}. ${err.message}`);
    }
  }
  return { csvPath: csvResolved, outputPath: outputResolved };
}

function normalizeCode(val) {
  const s = String(val).trim();
  return s.length === 5 ? s : s.padStart(5, '0');
}

function trimDesc(val) {
  return val == null ? '' : String(val).trim();
}

function main() {
  const { csvPath, outputPath } = getConfig();

  console.log('[fetch-noc-occupations] CSV:', csvPath);
  console.log('[fetch-noc-occupations] Output:', outputPath);
  console.log('[fetch-noc-occupations] Parsing CSV...');

  let raw = fs.readFileSync(csvPath, 'utf8');
  raw = raw.replace(/^\uFEFF/, '');
  let rows;
  try {
    rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (err) {
    exit(`Failed to parse CSV: ${err.message}`);
  }

  const level5 = rows.filter((r) => String(r[LEVEL] || '').trim() === '5');
  console.log('[fetch-noc-occupations] Level 5 rows:', level5.length);

  const byCode = new Map();
  for (const row of level5) {
    const code = normalizeCode(row[CODE] || '');
    if (!/^\d{5}$/.test(code)) continue;
    if (!byCode.has(code)) {
      byCode.set(code, {
        name: trimDesc(row[CLASS_TITLE]) || null,
        exampleTitles: new Set(),
        mainDuties: [],
        employmentRequirements: [],
        additionalInfo: [],
        exclusions: [],
      });
    }
    const type = String(row[ELEMENT_TYPE] || '').trim();
    const desc = trimDesc(row[ELEMENT_DESC]);
    if (!desc) continue;
    const rec = byCode.get(code);
    if (type === ELEMENT_TYPES.ILLUSTRATIVE || type === ELEMENT_TYPES.ALL_EXAMPLES) {
      rec.exampleTitles.add(desc);
    } else if (type === ELEMENT_TYPES.MAIN_DUTIES) {
      rec.mainDuties.push(desc);
    } else if (type === ELEMENT_TYPES.EMPLOYMENT_REQUIREMENTS) {
      rec.employmentRequirements.push(desc);
    } else if (type === ELEMENT_TYPES.ADDITIONAL_INFO) {
      rec.additionalInfo.push(desc);
    } else if (type === ELEMENT_TYPES.EXCLUSIONS) {
      rec.exclusions.push(desc);
    }
  }

  const occupations = [];
  for (const [nocCode, rec] of byCode.entries()) {
    const additionalParts = [];
    if (rec.exclusions.length > 0) {
      additionalParts.push('Exclusions:\n' + rec.exclusions.join('\n'));
    }
    if (rec.additionalInfo.length > 0) {
      additionalParts.push(rec.additionalInfo.join('\n'));
    }
    occupations.push({
      nocCode,
      name: rec.name || null,
      exampleTitles: rec.exampleTitles.size > 0 ? Array.from(rec.exampleTitles).sort() : null,
      mainDuties: rec.mainDuties.length > 0 ? rec.mainDuties.join('\n') : null,
      employmentRequirements: rec.employmentRequirements.length > 0 ? rec.employmentRequirements.join('\n') : null,
      additionalInformation: additionalParts.length > 0 ? additionalParts.join('\n\n') : null,
    });
  }

  occupations.sort((a, b) => a.nocCode.localeCompare(b.nocCode));

  const payload = {
    version: NOC_VERSION,
    fetchedAt: new Date().toISOString(),
    occupations,
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log('[fetch-noc-occupations] Grouped %d unit groups. Wrote %d occupations to %s', byCode.size, occupations.length, outputPath);
}

main();
