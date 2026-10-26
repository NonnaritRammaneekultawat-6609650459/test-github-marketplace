const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {readSonarResults} = require('../lib/sonar');
const {emptySummary, isPassing, formatReport} = require('../lib/angularjs/adapter');
const {renderComments} = require('../lib/reporting/angularjs');
const {renderJavaScriptComments} = require('../lib/reporting/javascript');

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-sonar-'));
  const taskFile = path.join(dir, 'report-task.txt');
  fs.writeFileSync(taskFile, 'projectKey=team:app\nceTaskId=current-task\nceTaskUrl=https://untrusted.invalid/steal\n');
  const calls = [];
  const options = {token: 'fake-secret', projectKey: 'team:app', scanStatus: 'success', head: 'abc', prNumber: 11,
    taskFile, sleep: async () => {}, fetchImpl: async (url, init) => {
      assert.equal(url.origin, 'https://sonarcloud.io');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer fake-secret');
      calls.push(url);
      const data = url.pathname.endsWith('/ce/task') ? {task: {id: 'current-task', componentKey: 'team:app', status: 'SUCCESS', analysisId: 'current-analysis', scmRevision: 'abc'}} :
        url.pathname.endsWith('/project_status') ? {projectStatus: {status: 'OK'}} :
          {component: {measures: [{metric: 'bugs', value: '0'}, {metric: 'coverage', value: '81.5'}, {metric: 'new_coverage', period: {value: '90'}}]}};
      return {ok: true, json: async () => data};
    }};
  try { await fn(options, calls); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

test('Sonar reads the current task and queries its analysis ID, with PR-scoped metrics', async () => fixture(async (options, calls) => {
  const result = await readSonarResults(options);
  assert.equal(result.passed, true);
  assert.equal(result.metrics.coverage, '81.5');
  assert.equal(result.metrics.new_coverage, '90');
  assert.equal(calls[1].searchParams.get('analysisId'), 'current-analysis');
  assert.equal(calls[1].searchParams.has('projectKey'), false);
  assert.equal(calls[2].searchParams.get('pullRequest'), '11');
}));

test('failed or missing scan cannot reuse an older passing analysis', async () => fixture(async (options, calls) => {
  for (const scanStatus of ['failure', 'skipped', 'cancelled', '']) {
    const result = await readSonarResults({...options, scanStatus});
    assert.equal(result.passed, null);
  }
  fs.unlinkSync(options.taskFile);
  assert.equal((await readSonarResults(options)).passed, null);
  assert.equal(calls.length, 0);
}));

test('Sonar distinguishes a failed gate from failed, pending and unauthorized analysis', async () => fixture(async options => {
  const original = options.fetchImpl;
  const gateFailure = await readSonarResults({...options, fetchImpl: async (url, init) => url.pathname.endsWith('/project_status')
    ? {ok: true, json: async () => ({projectStatus: {status: 'ERROR'}})} : original(url, init)});
  assert.equal(gateFailure.passed, false);
  assert.equal(gateFailure.status, 'failed');
  for (const status of ['FAILED', 'CANCELED', 'PENDING', 'IN_PROGRESS']) {
    const result = await readSonarResults({...options, attempts: 2, fetchImpl: async () => ({ok: true, json: async () => ({task: {id: 'current-task', componentKey: 'team:app', status}})})});
    assert.equal(result.passed, null);
    assert.equal(result.status, 'unavailable');
  }
  const unauthorized = await readSonarResults({...options, fetchImpl: async () => ({ok: false, status: 403})});
  assert.equal(unauthorized.passed, null);
  assert.ok(!JSON.stringify(unauthorized).includes(options.token));
}));

test('Sonar rejects mismatched metadata, task, project and revision', async () => fixture(async options => {
  const original = options.fetchImpl;
  for (const override of [{id:'another-task'}, {componentKey:'another-project'}, {scmRevision:'stale-head'}]) {
    const result = await readSonarResults({...options, fetchImpl: async (url, init) => {
      const response = await original(url, init);
      const data = await response.json();
      return {ok:true, json:async () => ({...data, task:{...data.task, ...override}})};
    }});
    assert.equal(result.passed, null);
  }
  fs.writeFileSync(options.taskFile, 'projectKey=wrong\nceTaskId=current-task\n');
  assert.equal((await readSonarResults(options)).passed, null);
}));

test('AngularJS retains test evidence when Sonar fails; both frameworks share clear Sonar reports', () => {
  const summary = emptySummary('abc');
  summary.install.status = summary.syntax.status = summary.tests.status = 'passed';
  summary.tests.total = 1;
  summary.audit = {status: 'complete', isSecure: true};
  summary.ai.status = 'clean';
  assert.equal(isPassing(summary), true);
  for (const sonar of [{passed: true, metrics:{bugs:0}}, {passed:false, metrics:{}}, {passed:null, error:'Scan unavailable'}]) {
    summary.sonar = sonar;
    assert.equal(isPassing(summary), sonar.passed === true);
    assert.equal(summary.tests.status, 'passed');
    const angular = renderComments(summary, 'model')[1].body;
    const js = renderJavaScriptComments({...summary, modifiedFiles:[], classifications:{}}, 'model', 'abc')[1].body;
    const expected = sonar.passed == null ? 'UNAVAILABLE' : sonar.passed ? 'PASS' : 'FAIL';
    assert.ok(angular.split('### 📡 SonarCloud')[1].includes(expected));
    assert.equal(angular.split('### 📡 SonarCloud')[1], js.split('### 📡 SonarCloud')[1]);
    assert.ok(formatReport(summary, 'model').includes(`| SonarCloud | ${sonar.passed == null ? '⚠️ UNAVAILABLE' : sonar.passed ? '✅ PASS' : '❌ FAIL'} |`));
  }
});

for (const projectType of ['javascript', 'angularjs']) test(`real ${projectType} report entry retains passing tests but fails an unavailable Sonar scan`, async () => fixture(async options => {
  const {spawnSync} = require('node:child_process');
  const {childEnvironment} = require('../lib/angularjs/adapter');
  const dir = path.dirname(options.taskFile);
  const generatedDir = path.join(dir, '.aq-generated');
  fs.mkdirSync(generatedDir);
  const state = emptySummary('abc');
  state.framework = projectType;
  state.install.status = state.syntax.status = 'passed';
  state.tests = {status:'passed', total:1, passed:1};
  state.audit = {status:'complete', isSecure:true};
  state.success = state.coverageMet = true;
  state.modifiedFiles = [];
  if (projectType === 'angularjs') {
    require('../lib/angularjs/generation').saveGeneration(generatedDir, 'abc', "require('node:test'); require('./harness.cjs');", {ai:{status:'clean', findings:'clean'}, files:[]});
  } else {
    fs.writeFileSync(path.join(generatedDir, 'javascript.json'), JSON.stringify({version:1, framework:projectType, head:'abc', status:'existing', files:{}, classifications:{}, modifiedFiles:[], aiErrors:[]}));
  }
  fs.writeFileSync(path.join(dir, '.gate-state.json'), JSON.stringify(state));
  const summaryFile = path.join(dir, 'summary.md');
  fs.writeFileSync(summaryFile, '');
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../generate-tests.js')], {cwd:dir, encoding:'utf8', timeout:20000,
    env:{...childEnvironment(), INPUT_PROJECT_TYPE:projectType, INPUT_PHASE:'report', INPUT_SONAR_PROJECT_KEY:'team:app', INPUT_SONAR_SCAN_STATUS:'failure',
      INPUT_SONAR_TOKEN:'fake-sonar-key', GITHUB_REPOSITORY:'user/app', GITHUB_SHA:'abc', GITHUB_STEP_SUMMARY:summaryFile}});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = fs.readFileSync(summaryFile, 'utf8');
  assert.match(report, /SonarCloud/);
  assert.match(report, /scan did not complete successfully/);
  assert.match(report, /\*\*✅ PASS\*\*/);
  assert.ok(!report.includes('fake-sonar-key'));
}));
