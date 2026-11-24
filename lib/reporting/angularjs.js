const {safe, isPassing} = require('../angularjs/adapter');
const {sonarDetails} = require('./sonar');

const label = status => ({passed:'✅ Passed', failed:'❌ Failed', skipped:'⏭️ Skipped'}[status] || '⚠️ Unavailable');
const cell = value => safe(value ?? '—').replace(/\|/g, '&#124;').replace(/\r?\n/g, ' ');
const bullets = values => (values || []).map(value => '- ' + safe(value)).join('\n');
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows]
  .map(row => '| ' + row.map(cell).join(' | ') + ' |').join('\n');

function testReport(s, run, repo) {
  const t = s.tests;
  const status = t.total > 0 || t.status === 'skipped' ? t.status : 'unavailable';
  const coverage = t.total > 0 ? s.coverage : null;
  const saved = s.savedTests;
  const links = saved && /^[0-9a-f]{40}$/i.test(saved.sha) && repo
    ? saved.files.map(file => '[' + cell(file) + '](' + repo + '/blob/' + saved.sha + '/' + file.split('/').map(encodeURIComponent).join('/') + ')').join(' · ') +
      ' · [View commit](' + repo + '/commit/' + saved.sha + ')'
    : run ? '[Open run and test artifacts](' + run + ')' : 'See the test artifacts for this run.';
  const cases = t.cases || [...(t.log || '').matchAll(/^\s*(not ok|ok)\s+\d+\s+-\s+(.+)$/gm)].map(m => ({
    name:m[2], status:/# (SKIP|TODO)/i.test(m[2]) ? 'skipped' : m[1] === 'ok' ? 'passed' : 'failed'
  }));
  const reportStatus = s.runner === 'Jest' && status === 'passed' && coverage?.status === 'failed' ? 'failed' : status;
  const sections = ['## 🧪 Test Results & Coverage · ' + label(reportStatus),
    '> **Test files** · ' + links,
    '**Analyzed commit** · '+cell(s.head),
    '**Overall PR result** · ' + label(s.success ? 'passed' : 'failed'),
    '**Runner** · ' + cell(s.runner || 'Node + jsdom') + ' · ' +
      ['passed','failed','skipped'].map(key => (t[key] ?? '—') + ' ' + key).join(' · ')];
  if (cases.length) sections.push(table(['Test case','Expected','Actual','Result','Failure details'], cases.slice(0,30).map(c => [c.name,c.expected,c.actual,label(c.status),c.detail])));
  if (s.runner === 'Jest' && coverage) {
    const pct = value => Number.isFinite(value) ? value + '%' : '—';
    sections.push(table(['Coverage','Measured','Minimum','Result'],
      [['Statements',pct(coverage.metrics?.statements?.pct),pct(coverage.required),label(coverage.overallStatus)]]));
    const rows = [];
    const failures = [];
    for (const [file, metric] of Object.entries(coverage.files).slice(0,30)) {
      const actual = metric.statements?.pct;
      const required = coverage.fileThresholds[file] ?? coverage.required;
      const measured = Number.isFinite(actual) && Number.isFinite(required);
      const passed = measured && actual >= required;
      const importance = ({critical:'Critical',high:'High',medium:'Medium',low:'Low'})[metric.importance] || 'Unavailable';
      rows.push([file,importance,pct(actual),pct(required),metric.source,label(measured ? passed ? 'passed':'failed' : 'unavailable')]);
      if (measured && !passed) failures.push(file + ' is ' + Number((required-actual).toFixed(2)) + ' percentage points below its required coverage.');
    }
    if (rows.length) sections.push('### Coverage by file\n\n' + table(['File','AI Importance','Measured','Required','Threshold Source','Result'],rows));
    if (failures.length) sections.push('**Blocking coverage conditions**\n\n' + bullets(failures));
  } else sections.push(table(['Coverage','Measured','Minimum','Result'], [
    ['Statements',coverage?.metrics?.statements?.pct == null ? '—' : coverage.metrics.statements.pct + '%',
      coverage?.required == null ? '—' : coverage.required + '%',label(coverage?.status)],
    ...Object.entries(coverage?.files || {}).slice(0,30).map(([file,m]) => [file,m.statements?.pct == null ? '—' : m.statements.pct+'%',
      coverage.fileThresholds?.[file] ?? coverage.required,m.statements?.pct == null ? label('unavailable') : label(m.statements.pct >= (coverage.fileThresholds?.[file] ?? coverage.required) ? 'passed':'failed')])
  ]));
  if (s.errors?.length) sections.push('**Diagnostics**\n\n' + bullets(s.errors));
  if (t.log) sections.push('<details><summary>Test log</summary>\n\n<pre>' + safe(t.log.slice(-8000)) + '</pre>\n</details>');
  return sections.join('\n\n');
}

function complexityReport(metric) {
  const files = Object.entries(metric?.files || {});
  const rows = files.flatMap(([file,m]) => (m.functions || []).map(f => [file+' · '+f.name+' (L'+f.line+')',f.complexity,f.required,label(f.pass?'passed':'failed')]));
  return ['## 🧭 Cyclomatic Complexity · ' + label(files.length ? metric.status : metric?.status === 'skipped' ? 'skipped':'unavailable'),
    rows.length + ' functions checked · Highest score **' + (rows.length ? Math.max(...rows.map(r=>r[1])) : '—') + '** · Project limit **' + (metric?.required ?? '—') + '**',
    table(['File / Function','Complexity','Limit','Result'],rows.slice(0,100)),
    '**Approximate risk ranges**',table(['🟢 Low','🟡 Moderate','🟠 High','🔴 Very high'],[['1–10','11–20','21–50','Over 50']]),
    '[Carnegie Mellon University, Software Engineering Institute (1997), p. 147](https://www.sei.cmu.edu/documents/1625/1997_002_001_16523.pdf)'].join('\n\n');
}

function renderComments(summary, model) {
  const repo = process.env.GITHUB_REPOSITORY && (process.env.GITHUB_SERVER_URL || 'https://github.com') + '/' + process.env.GITHUB_REPOSITORY;
  const run = repo && process.env.GITHUB_RUN_ID && repo + '/actions/runs/' + process.env.GITHUB_RUN_ID;
  const s = {...summary, success:summary.success ?? isPassing(summary)};
  const audit = s.audit;
  const complete = audit.status === 'complete';
  const severity = ['critical','high','moderate','low'];
  const security = ['## 🛡️ Dependency Audit · ' + label(complete ? audit.isSecure ? 'passed':'failed':'unavailable'),
    table(['Critical','High','Moderate','Low'],[severity.map(k => complete ? audit[k] ?? 0 : '—')]),
    '**Pass condition** · No high or critical vulnerabilities without an approved exception.',
    bullets(audit.details), audit.error && safe(audit.error),bullets(audit.warnings),
    '**Approved exceptions** · ' + (bullets(audit.ignored) || (complete ? 'None':'Unavailable'))];
  const ai = s.ai;
  const title = {clean:'✅ Passed',suspicious:'⚠️ Review suggested',buggy:'🔎 Findings reported',skipped:'⏭️ Skipped'}[ai.status] || label('unavailable');
  const review = ['## 🤖 AI Code Review · ' + title, '**Model** · ' + cell(model),
    safe(ai.findings),safe(ai.remediation),s.reviewDetails,s.reviewDetails ? null : bullets(s.files)];
  return [{key:'tests',body:testReport(s,run,repo)}, {key:'complexity',body:complexityReport(s.complexity)},
    {key:'sonar',body:sonarDetails(s.sonar,safe) + (run ? '\n\n[Open workflow logs]('+run+')':'')},
    {key:'security',body:security.filter(Boolean).join('\n\n')},{key:'ai',body:review.filter(Boolean).join('\n\n')}];
}

module.exports = {renderComments};
