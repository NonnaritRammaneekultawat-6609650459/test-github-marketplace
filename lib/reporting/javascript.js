const {renderComments} = require('./angularjs');
const {emptySummary, safe} = require('../angularjs/adapter');

function jestResults(result, log, exitCode) {
  if (!result) return {status:'unavailable', log};
  const cases = (result.testResults || []).flatMap(s => s.assertionResults || []).slice(0,100).map(t => ({
    name:t.fullName || t.title,
    status:['passed','failed'].includes(t.status) ? t.status : 'skipped',
    expected:t.failureMessages?.[0]?.match(/^\s*Expected:\s*(.+)$/m)?.[1],
    actual:t.failureMessages?.[0]?.match(/^\s*Received:\s*(.+)$/m)?.[1],
    detail:t.failureMessages?.[0]?.replace(/\x1b\[[0-9;]*m/g,'').split(/\n\s+at /)[0].slice(0,700)
  }));
  return {status:result.numTotalTests ? exitCode === 0 ? 'passed':'failed':'unavailable',
    total:result.numTotalTests,passed:result.numPassedTests,failed:result.numFailedTests,
    skipped:(result.numPendingTests || 0)+(result.numTodoTests || 0),cases,log:log.slice(-8000)};
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
    summary.coverage.files[file]={statements:{pct:m.actual}};
    summary.coverage.fileThresholds[file]=m.required ?? source.classifications?.[file]?.targetCoverage;
  }
  const reviews=summary.files.map(file=>({file,...source.classifications?.[file]?.review}));
  const aiErrors=summary.errors.filter(e=>!e.startsWith('Checks incomplete:'));
  const status = ['buggy','suspicious','unavailable'].find(key=>reviews.some(r=>(r.status || 'unavailable') === key));
  summary.ai={status:aiErrors.length ? 'unavailable' : source.skipped || source.reviewSkipped ? 'skipped' : status || (reviews.length?'clean':'unavailable'),
    findings:aiErrors.join('\n')};
  summary.reviewDetails=reviews.map(r=>'### '+safe(r.file)+'\n\n'+safe(r.findings || 'No review details available.')+
    (r.remediation?'\n\n**Suggested fix** · '+safe(r.remediation):'')).join('\n\n');
  return renderComments(summary,model);
}
module.exports={renderJavaScriptComments,jestResults};
