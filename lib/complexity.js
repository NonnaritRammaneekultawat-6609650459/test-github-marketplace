'use strict';

// Lightweight source metric: one path plus each decision operator/keyword.
// Strings and comments are blanked first so examples in text do not count.
function cyclomaticComplexity(source) {
  const code = String(source)
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*?\1/g, m => ' '.repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/.*$/gm, m => ' '.repeat(m.length));
  const decisions = code.match(/\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?!\.)/g) || [];
  return 1 + decisions.length;
}

function measureFiles(files, readFile, config = {}) {
  const limit = config.complexity?.global ?? 10;
  const perFile = config.complexity?.files || {};
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !perFile || typeof perFile !== 'object' || Array.isArray(perFile) || Object.values(perFile).some(n => !Number.isInteger(n) || n < 1 || n > 1000)) {
    throw new Error('Invalid complexity configuration');
  }
  const results = {};
  let passed = true;
  for (const file of files) {
    const actual = cyclomaticComplexity(readFile(file));
    const required = perFile[file] ?? limit;
    const pass = actual <= required;
    results[file] = {actual, required, pass};
    if (!pass) passed = false;
  }
  return {status: passed ? 'passed' : 'failed', required: limit, files: results};
}

module.exports = {cyclomaticComplexity, measureFiles};
