const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {sonarStatus} = require('../reporting/sonar');

// PR code must never inherit the AI key or a GitHub write token.
function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name) &&
    !/^INPUT_/i.test(name) && !/^ACTIONS_/i.test(name) && !/^NODE_(TEST_CONTEXT|OPTIONS)$/i.test(name) &&
    !/^GITHUB_(ENV|OUTPUT|PATH|STEP_SUMMARY)$/i.test(name)));
}

function detectProject() {
  try {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    return !!(pkg.dependencies?.angular || pkg.devDependencies?.angular);
  } catch { return false; }
}

function emptySummary(head) {
  return {version: 1, framework: 'angularjs', head,
    install: {status: 'unavailable'}, syntax: {status: 'unavailable'}, tests: {status: 'unavailable'},
    audit: {status: 'error', isSecure: null}, ai: {status: 'skipped', findings: 'AI review has not run.'},
    files: [], omitted: [], errors: []};
}

function executeNpm(args) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000,
    maxBuffer: 2 * 1024 * 1024, env: childEnvironment()
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  console.log(output);
  const summary = {status: result.error ? 'error' : result.status === 0 ? 'passed' : 'failed',
    exitCode: result.status, log: output.slice(-8000)};
  for (const [field, pattern] of Object.entries({total: /^# tests (\d+)$/m, passed: /^# pass (\d+)$/m, failed: /^# fail (\d+)$/m, skipped: /^# skipped (\d+)$/m})) {
    const match = output.match(pattern);
    if (match) summary[field] = Number(match[1]);
  }
  return summary;
}

function runChecks({head, installStatus, audit}) {
  const summary = emptySummary(head);
  summary.install = {status: installStatus === 'success' ? 'passed' : 'failed'};
  if (installStatus !== 'success') {
    summary.syntax.status = summary.tests.status = 'skipped';
    summary.errors.push('Dependency installation failed; execution checks were skipped.');
    return summary;
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); }
  catch { summary.errors.push('Cannot read package.json.'); return summary; }
  summary.syntax = pkg.scripts?.check ? executeNpm(['run', 'check']) : {status: 'skipped'};
  summary.tests = pkg.scripts?.test ? executeNpm(['test', '--', '--test-reporter=tap']) : {status: 'skipped'};
  // A zero-test invocation must not count as verified application tests.
  if (summary.tests.status === 'passed' && summary.tests.total === 0) summary.tests.status = 'unavailable';
  try { summary.audit = audit(); }
  catch { summary.errors.push('npm audit did not complete.'); }
  return summary;
}

function loadState(file, head) {
  const fallback = emptySummary(head);
  try {
    if (fs.statSync(file).size > 100000) throw new Error('Oversized state');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || state.framework !== 'angularjs' || state.head !== head) throw new Error('Wrong head/version');
    const validStatuses = ['passed', 'failed', 'skipped', 'error', 'unavailable'];
    fallback.testOrigin = state.testOrigin === 'generated' ? 'generated' : 'existing';
    if (state.generation) fallback.generation = {status:state.generation.status === 'generated' ? 'generated' : 'unavailable'};
    if (state.coverage && ['passed','failed','unavailable'].includes(state.coverage.status)) {
      const c = state.coverage;
      const valid = ['statements','branches','functions','lines'].every(k=>Number.isFinite(c.metrics?.[k]?.pct) && c.metrics[k].pct >= 0 && c.metrics[k].pct <= 100);
      fallback.coverage = valid && Number.isInteger(c.required) && c.required >= 1 && c.required <= 100
        ? {...c,status:c.metrics.statements.pct >= c.required && c.status === 'passed' ? 'passed':'failed'} : {status:'unavailable'};
    }
    for (const key of ['install', 'syntax', 'tests']) {
      if (!validStatuses.includes(state[key]?.status)) throw new Error('Invalid check');
      fallback[key] = {status: state[key].status};
      if (typeof state[key].log === 'string') fallback[key].log = state[key].log.slice(-8000);
      for (const count of ['total', 'passed', 'failed', 'skipped']) {
        if (Number.isSafeInteger(state[key][count]) && state[key][count] >= 0) fallback[key][count] = state[key][count];
      }
    }
    if (!['complete', 'error'].includes(state.audit?.status)) throw new Error('Invalid audit');
    fallback.audit.status = state.audit.status;
    for (const key of ['critical', 'high', 'moderate', 'low']) {
      fallback.audit[key] = Number.isSafeInteger(state.audit[key]) && state.audit[key] >= 0 ? state.audit[key] : 0;
    }
    fallback.audit.isSecure = state.audit.status === 'complete'
      ? fallback.audit.critical === 0 && fallback.audit.high === 0 : null;
    fallback.audit.details = Array.isArray(state.audit.details) ? state.audit.details.filter(x => typeof x === 'string').slice(0, 20) : [];
    fallback.errors = Array.isArray(state.errors) ? state.errors.filter(x => typeof x === 'string').map(x => x.slice(0, 300)).slice(0, 10) : [];
    return fallback;
  } catch {
    const missing = emptySummary(head);
    missing.errors.push('Check artifact is missing, invalid, or belongs to another commit. Results are unavailable.');
    return missing;
  }
}

const relevant = name => /^(src\/.*\.(js|html)|index\.html|package\.json|test\/.*\.(js|cjs)|docs\/AI-REVIEW\.md|(?:project-)?spec\.md)$/.test(name);
function addSource(context, name, text) {
  const numbered = text.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
  if (text.length > 40000 || context.text.length + numbered.length > 80000 || context.files.length >= 20) {
    context.omitted.push(name);
    return;
  }
  context.files.push(name);
  context.text += `\n--- ${name} ---\n${numbered}\n`;
}

function localContext() {
  const context = {text: '', files: [], omitted: []};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.isSymbolicLink()) continue;
      const name = path.join(dir, entry.name).replaceAll('\\', '/').replace(/^\.\//, '');
      if (entry.isDirectory() && ['src', 'test', 'docs'].includes(name.split('/')[0])) walk(name);
      else if (entry.isFile() && relevant(name)) addSource(context, name, fs.readFileSync(name, 'utf8'));
    }
  }
  walk('.');
  return context;
}

async function remoteContext(octokit, repo, pr) {
  const context = {text: '', files: [], omitted: []};
  const {data: tree} = await octokit.rest.git.getTree({...repo, tree_sha: pr.head.sha, recursive: 'true'});
  const changed = await octokit.paginate(octokit.rest.pulls.listFiles, {...repo, pull_number: pr.number, per_page: 100});
  const changedPaths = new Set(changed.map(f => f.filename));
  const paths = tree.tree.filter(f => f.type === 'blob' && f.mode !== '120000' && relevant(f.path))
    .sort((a, b) => Number(changedPaths.has(b.path)) - Number(changedPaths.has(a.path)));
  if (tree.truncated) context.omitted.push('(repository tree truncated)');
  for (const file of paths) {
    if (context.files.length >= 20 || file.size > 40000) { context.omitted.push(file.path); continue; }
    try {
      const {data} = await octokit.rest.repos.getContent({...repo, path: file.path, ref: pr.head.sha});
      if (data.encoding !== 'base64' || typeof data.content !== 'string') {context.omitted.push(file.path); continue;}
      addSource(context, file.path, Buffer.from(data.content, 'base64').toString('utf8'));
    } catch { context.omitted.push(file.path); }
  }
  context.text += '\nPR changes (may be truncated):\n' + changed.filter(f => relevant(f.filename)).slice(0, 20)
    .map(f => `${f.status}: ${f.filename}\n${(f.patch || '(diff unavailable)').slice(0, 3000)}`).join('\n').slice(0, 20000);
  return context;
}

const safe = value => String(value ?? '').slice(0, 12000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '@\u200b').replace(/`/g, '&#96;');
const label = status => ({passed:'✅ PASS', failed:'❌ FAIL', skipped:'⏭️ SKIPPED', error:'⚠️ ERROR', unavailable:'⚠️ UNAVAILABLE'}[status] || '⚠️ UNAVAILABLE');
function isPassing(summary) {
  return summary.install.status === 'passed' && summary.tests.status === 'passed' &&
    summary.syntax.status === 'passed' && summary.audit.isSecure === true &&
    summary.ai.status === 'clean' && (!summary.sonar || summary.sonar.skipped || summary.sonar.passed === true) && (!summary.coverage || summary.coverage.status === 'passed') && !summary.errors.length;
}

function formatReport(summary, model) {
  const tests = summary.tests;
  const counts = Number.isInteger(tests.total) ? `${tests.total} tests; ${tests.passed || 0} passed; ${tests.failed || 0} failed; ${tests.skipped || 0} skipped` : 'No test counts available';
  const audit = summary.audit;
  const auditStatus = audit.status === 'complete' ? (audit.isSecure ? 'passed' : 'failed') : 'error';
  const hasFailure = [summary.install, summary.syntax, tests, summary.coverage || {}].some(x => x.status === 'failed') || auditStatus === 'failed' || summary.ai.status === 'buggy' || sonarStatus(summary.sonar) === 'failed';
  const generated = summary.testOrigin === 'generated';
  const result = hasFailure ? '❌ FAIL / findings require attention' : isPassing(summary) ? '✅ Checks passed' : '⚠️ INCOMPLETE — some checks unavailable or skipped';
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  return `# 🚀 AI-Powered Quality Gate Report

**Engine:** [test-github-marketplace](https://github.com/NonnaritRammaneekultawat-6609650459/test-github-marketplace) · AngularJS adapter
**Commit:** ${safe(summary.head)}
**Overall result:** ${result}

| Check | Result |
|---|---|
| Dependency installation | ${label(summary.install.status)} |
| JavaScript syntax | ${label(summary.syntax.status)} |
| ${generated ? 'AI-generated tests — action-owned Node + jsdom runtime' : 'Existing tests — Node Test Runner + jsdom'} | ${label(tests.status)} |
${generated ? '| AI test generation | ' + (summary.generation?.status === 'generated' ? '✅ Generated' : '⚠️ UNAVAILABLE') + ' |' : ''}
| npm audit — High/Critical | ${label(auditStatus)} |
| Coverage | ${summary.coverage ? label(summary.coverage.status) + ' · Statements: ' + (summary.coverage.metrics?.statements?.pct ?? '—') + '% / ' + (summary.coverage.required ?? '—') + '%' : '⏭️ Not measured in this legacy run'} |
| SonarCloud | ${label(sonarStatus(summary.sonar))} |

### Test results
${counts}
<details><summary>Test output from the Quality Gate engine</summary>

<pre>${safe(tests.log || 'No test output available.')}</pre>
</details>

### Security & audit
${audit.status === 'complete' ? `Critical: ${audit.critical || 0}, High: ${audit.high || 0}, Moderate: ${audit.moderate || 0}, Low: ${audit.low || 0}\n${safe((audit.details || []).join(', '))}` : 'Audit could not complete. This is not a secure/pass result.'}

### AI code review — ${safe(model)}
**Status:** ${safe(summary.ai.status)}
${safe(summary.ai.findings)}
${summary.ai.remediation ? '\nSuggested remediation:\n' + safe(summary.ai.remediation) : ''}

### Scope and limitations
Source context: ${summary.files.map(safe).join(', ') || 'Unavailable / not requested'}
${summary.omitted.length ? '\nOmitted: ' + summary.omitted.map(safe).join(', ') : ''}
${summary.errors.map(x => '- ' + safe(x)).join('\n')}
${generated ? 'The action generated and executed the test suite. The application needs no test files, npm test script or jsdom dependency. Download aq-generated-tests from the workflow artifacts to inspect the generated source.' : 'This run uses the application existing tests.'}
Coverage uses instrumented application source. Optional SonarCloud analysis imports the LCOV report. Generated tests never execute in a job holding AI secrets or write permissions.
${runUrl ? '\n[View workflow logs](' + runUrl + ')' : ''}

*Generated by the original Automated Quality Gate action (generate-tests.js).*`;
}

module.exports = {childEnvironment, detectProject, emptySummary, runChecks, loadState, localContext, remoteContext, formatReport, isPassing, safe, label};
