/**
 * Report section keys – single source of truth for Built for Tomorrow report output.
 * Aligns with PROJECT_DESCRIPTION.md (Strength Profile, Career Clusters, etc.).
 */
const REPORT_SECTIONS = [
  'strengthProfileSummary',
  'coreAdvantageAreas',
  'careerClusterAlignment',
  'aiResilienceAnalysis',
  'suggestedCollegeDirections',
  'skillDevelopmentRoadmap',
  'scenarioPlanning',
  'backupPathStrategy',
];

function getReportTemplate() {
  return Object.fromEntries(REPORT_SECTIONS.map((key) => [key, null]));
}

module.exports = { getReportTemplate };
