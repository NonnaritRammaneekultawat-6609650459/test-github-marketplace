const fs = require('node:fs');

// Read the task produced by THIS scan, not the last successful project analysis.
async function readSonarResults({token, projectKey, scanStatus, head, prNumber,
  taskFile = '.aq-sonar/report-task.txt', fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 15}) {
  const result = {passed: null, status: 'unavailable', metrics: {}, issues: []};
  if (scanStatus !== 'success') return {...result, error: 'SonarCloud scan did not complete successfully. See the sonar job.'};
  if (!token) return {...result, error: 'SonarCloud token is not configured.'};
  try {
    if (!/^[A-Za-z0-9_.:-]+$/.test(projectKey || '')) throw new Error();
    if (fs.statSync(taskFile).size > 10000) throw new Error();
    const metadata = fs.readFileSync(taskFile, 'utf8');
    const taskId = metadata.match(/^ceTaskId=([A-Za-z0-9_-]+)\s*$/m)?.[1];
    const recordedKey = metadata.match(/^projectKey=(.+)$/m)?.[1]?.trim();
    if (!taskId || recordedKey !== projectKey) throw new Error();
    const get = async (route, params) => {
      // Never follow an artifact-supplied URL or redirect with the token.
      const url = new URL('https://sonarcloud.io/api/' + route);
      url.search = new URLSearchParams(params).toString();
      const response = await fetchImpl(url, {headers: {Authorization: `Bearer ${token}`}, redirect: 'error', signal: AbortSignal.timeout(10000)});
      if (!response.ok) throw new Error();
      return response.json();
    };
    let task;
    for (let i = 0; i < attempts; i++) {
      task = (await get('ce/task', {id: taskId})).task;
      if (!task || task.id !== taskId || task.componentKey !== projectKey) throw new Error();
      if (['FAILED', 'CANCELED'].includes(task.status)) return {...result, error: 'SonarCloud analysis failed or was canceled. See the sonar job and SonarCloud background task.'};
      if (task.status === 'SUCCESS') break;
      if (!['PENDING', 'IN_PROGRESS'].includes(task.status)) throw new Error();
      if (i < attempts - 1) await sleep(5000);
    }
    if (task.status !== 'SUCCESS' || !task.analysisId) return {...result, error: 'SonarCloud analysis is still pending; no confirmed Quality Gate result.'};
    // CE additional fields bind the analysis to the source revision when supplied.
    if (task.scmRevision && task.scmRevision !== head) throw new Error();
    const gate = (await get('qualitygates/project_status', {analysisId: task.analysisId})).projectStatus;
    if (!['OK', 'ERROR'].includes(gate?.status)) throw new Error();
    result.passed = gate.status === 'OK';
    result.status = result.passed ? 'passed' : 'failed';
    result.analysisId = task.analysisId;
    const params = {component: projectKey, ...(prNumber ? {pullRequest: String(prNumber)} : {}), metricKeys: 'bugs,vulnerabilities,code_smells,security_hotspots,coverage,new_coverage'};
    try {
      const data = await get('measures/component', params);
      for (const measure of data.component?.measures || []) {
        if (params.metricKeys.split(',').includes(measure.metric)) result.metrics[measure.metric] = measure.value ?? measure.period?.value ?? '—';
      }
    } catch { result.metricsUnavailable = true; }
    return result;
  } catch {
    return {...result, passed: null, status: 'unavailable', error: 'Cannot verify this SonarCloud analysis. Check scan metadata, token permissions and project settings.'};
  }
}

module.exports = {readSonarResults};
