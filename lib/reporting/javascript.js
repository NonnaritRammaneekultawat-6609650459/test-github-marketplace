const {renderComments} = require('./angularjs');
const {sonarDetails} = require('./sonar');
const {emptySummary, safe, label} = require('../angularjs/adapter');
const cell = value => safe(value).replace(/\|/g, '&#124;').replace(/\n/g, ' ');

function jestResults(result, log, exitCode) {
  const tests = {status: exitCode === 0 ? 'passed' : 'failed', log};
  if (!result) { tests.status = 'unavailable'; return tests; }
  Object.assign(tests, {total:result.numTotalTests, passed:result.numPassedTests,
    failed:result.numFailedTests, skipped:(result.numPendingTests || 0) + (result.numTodoTests || 0)});
  if (!tests.total) tests.status = 'unavailable';
  tests.log = (result.testResults || []).flatMap(s => s.assertionResults || []).map((t,i) =>
    `${t.status === 'passed' ? 'ok' : 'not ok'} ${i+1} - ${t.fullName || t.title}${['pending','todo'].includes(t.status) ? ' # SKIP' : ''}`
  ).join('\n') + '\n\n' + log;
  return tests;
}

function renderJavaScriptComments(source, model, head) {
  const summary = emptySummary(source.head || head || 'unknown');
  summary.runner = 'Jest'; summary.frameworkLabel = 'JavaScript';
  summary.files = source.modifiedFiles || [];
  summary.tests = source.skipped ? {status:'skipped'} : source.tests || {
    status:source.jestPassed ? 'passed' : 'unavailable', log:'ไม่มีข้อมูลรายกรณีจากการรันเวอร์ชันเดิม'};
  summary.install = source.install || {status:'unavailable'};
  summary.syntax = {status:'skipped'};
  summary.testOrigin = source.testOrigin || 'generated';
  summary.persistence = source.persistence;
  summary.generation = {status:source.testsGenerated > 0 ? 'generated' : 'unavailable'};
  summary.testNote = source.skipped ? 'ไม่มีไฟล์ JavaScript ใน src/ ที่เปลี่ยนแปลง จึงข้ามการตรวจ' :
    `Action สร้างไฟล์เทสต์ Jest ${Number(source.testsGenerated) || 0} ไฟล์ · ดูรายละเอียดใน workflow`;
  summary.audit = source.audit || summary.audit;
  const measured = source.tests?.total > 0 && (Number.isFinite(source.coverage?.statements?.pct) || Number.isFinite(source.coverage?.statements) || Object.values(source.fileStatus || {}).some(s=>Number.isFinite(s.actual)));
  summary.coverageLabel = source.skipped ? label('skipped') : !measured ? '⚠️ ยังวัดไม่ได้' : label(source.coverageMet ? 'passed' : 'failed');
  summary.coverageDetails = '\n### Coverage และความสำคัญของไฟล์\n\n| ไฟล์ | ความสำคัญ | เป้าหมาย | ผลจริง | สถานะ |\n|---|---|---|---|---|\n' +
    summary.files.map(f => { const c=source.classifications?.[f]; const s=measured ? source.fileStatus?.[f] : undefined;
      return `| ${cell(f)} | ${cell(c?.importance || '—')} | ${c?.targetCoverage ?? c?.min_coverage_threshold ?? '—'}% | ${s?.actual ?? '—'}% | ${label(s ? s.pass ? 'passed' : 'failed' : 'unavailable')} |`;
    }).join('\n');
  summary.sonarDetails = sonarDetails(source.sonar, safe, label);
  const reviews = summary.files.map(f=>({file:f,...source.classifications?.[f]?.review}));
  summary.ai.status = source.skipped || source.reviewSkipped ? 'skipped' : ['buggy','suspicious','unavailable'].find(status => reviews.some(r => (r.status || 'unavailable') === status)) || (reviews.length ? 'clean' : 'unavailable');
  summary.ai.findings = 'ผลรีวิวแยกตามไฟล์แสดงด้านล่าง';
  if (source.aiErrors?.length) {
    summary.ai.status = 'unavailable';
    summary.ai.findings = [...new Set(source.aiErrors)].join('\n');
    summary.errors.push(...new Set(source.aiErrors));
  }
  summary.aiDetails = reviews.map(r => `### 📄 ${cell(r.file)}\n\n**สถานะ:** ${cell(r.status || 'unavailable')}\n\n${safe(r.findings || 'ไม่มีผลรีวิว')}\n\n${r.remediation ? '💡 ' + safe(r.remediation) : ''}`).join('\n\n') +
    (source.analysis ? '\n\n### วิเคราะห์เทสต์ที่ไม่ผ่าน\n\n' + safe(source.analysis) : '') +
    (source.sonarAnalysis ? '\n\n### คำแนะนำจากผล SonarCloud\n\n' + safe(source.sonarAnalysis) : '');
  return renderComments(summary, model);
}

module.exports = {renderJavaScriptComments, jestResults};
