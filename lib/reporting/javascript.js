const {renderComments} = require('./angularjs');
const {emptySummary, safe} = require('../angularjs/adapter');

function jestResults(result, log, exitCode, entries = []) {
  if (!result) return {status:'unavailable', log};
  const evidence = new Map();
  for (const row of entries) {
    if (!row || !['file','test','expected','actual'].every(k => typeof row[k] === 'string')) continue;
    const key = JSON.stringify([row.file,row.test]);
    if (!evidence.has(key)) evidence.set(key,[]);
    const records = evidence.get(key);
    if (records.length < 8) records.push(row);
  }
  const cases = (result.testResults || []).flatMap(s => (s.assertionResults || []).map(t => {
    const rows = evidence.get(JSON.stringify([s.name,t.fullName || t.title])) || [];
    const values = key => rows.map((r,i) => (rows.length > 1 ? (i+1)+') ' : '') + r[key]).join(' · ');
    return {
    name:t.fullName || t.title,
    status:['passed','failed'].includes(t.status) ? t.status : 'skipped',
    expected:values('expected') || t.failureMessages?.[0]?.match(/^\s*Expected:\s*(.+)$/m)?.[1],
    actual:values('actual') || t.failureMessages?.[0]?.match(/^\s*Received:\s*(.+)$/m)?.[1],
    detail:t.failureMessages?.[0]?.replace(/\x1b\[[0-9;]*m/g,'').split(/\n\s+at /)[0].slice(0,700)
    };
  })).slice(0,100);
  return {status:result.numTotalTests ? exitCode === 0 ? 'passed':'failed':'unavailable',
    total:result.numTotalTests,passed:result.numPassedTests,failed:result.numFailedTests,
    skipped:(result.numPendingTests || 0)+(result.numTodoTests || 0),cases,log:log.slice(-8000)};
}

function renderFinding(review) {
  const cell = value => safe(value).replace(/\|/g,'&#124;').replace(/[\r\n]+/g,' ');
  const rows = ['| Section | Details |','| --- | --- |','| **File** | '+cell(review.file)+' |',
    '| **Finding** | '+cell(review.findings || 'No review details available.')+' |'];
  if (review.remediation) rows.push('| **Suggested fix** | '+cell(review.remediation)+' |');
  if (typeof review.exampleFix === 'string' && review.exampleFix.trim()) {
    const code = review.exampleFix.trim().slice(0,2400);
    const fence = '~'.repeat(Math.max(3,...Array.from(code.matchAll(/~+/g), m => m[0].length+1)));
    rows.push('', '**Example fix**', '', fence+'javascript', code, fence);
  }
  return rows.join('\n');
}

function renderJavaScriptComments(source, model, head) {
  const summary = emptySummary(source.head || head);
  Object.assign(summary,{runner:'Jest',success:source.success === true, files:source.modifiedFiles || [],
    tests:source.skipped ? {status:'skipped'} : source.tests || summary.tests,
    complexity:source.complexity, sonar:source.sonar, savedTests:source.savedTests,
    audit:source.audit || summary.audit, errors:[...new Set(source.aiErrors || [])]});
  const measurements = source.coverage || {};
  const actual = measurements.statements?.pct ?? measurements.statements;
  summary.coverage = {status:Number.isFinite(actual) || Object.values(source.fileStatus || {}).some(f=>Number.isFinite(f.actual))
    ? source.coverageMet ? 'passed':'failed':'unavailable',
    required:measurements.required,metrics:{statements:{pct:actual}}, files:{},fileThresholds:{}};
  for (const [file,m] of Object.entries(source.fileStatus || {})) {
    summary.coverage.files[file]={statements:{pct:m.actual},importance:m.importance,source:m.source};
    summary.coverage.fileThresholds[file]=m.required ?? source.classifications?.[file]?.targetCoverage;
  }
  summary.coverage.overallStatus = Number.isFinite(actual) && Number.isFinite(measurements.required)
    ? actual >= measurements.required ? 'passed':'failed' : summary.coverage.status;
  const reviews=summary.files.map(file=>({file,...source.classifications?.[file]?.review}));
  const aiErrors=summary.errors.filter(e=>!e.startsWith('Checks incomplete:'));
  const status = ['buggy','suspicious','unavailable'].find(key=>reviews.some(r=>(r.status || 'unavailable') === key));
  summary.ai={status:aiErrors.length ? 'unavailable' : source.skipped || source.reviewSkipped ? 'skipped' : status || (reviews.length?'clean':'unavailable'),
    findings:aiErrors.join('\n')};
  summary.reviewDetails=reviews.map(renderFinding).join('\n\n');
  return renderComments(summary,model);
}
module.exports={renderJavaScriptComments,jestResults};
