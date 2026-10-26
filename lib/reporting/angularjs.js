const {safe, label} = require('../angularjs/adapter');
const cell = value => safe(value).replace(/\|/g, '&#124;').replace(/\n/g, ' ');

function renderComments(summary, model) {
  const run = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  const meta = `**Commit:** \`${safe(summary.head).slice(0, 40)}\` · **Engine:** [test-github-marketplace](https://github.com/NonnaritRammaneekultawat-6609650459/test-github-marketplace)${run ? ` · [ดู workflow และดาวน์โหลดไฟล์](${run})` : ''}`;
  const tests = summary.tests;
  const count = key => Number.isInteger(tests[key]) ? tests[key] : '—';
  const cases = [...(tests.log || '').matchAll(/^(not ok|ok)\s+\d+\s+-\s+(.+)$/gm)].slice(0, 30);
  const caseTable = cases.length ? '\n### กรณีทดสอบ\n\n| ผล | รายการ |\n|:--:|---|\n' +
    cases.map(m => `| ${/# (SKIP|TODO)/i.test(m[2]) ? '⏭️' : m[1] === 'ok' ? '✅' : '❌'} | ${cell(m[2])} |`).join('\n') : '';
  const generated = summary.testOrigin === 'generated';
  const testBody = `## 🧪 Automated Quality Gate · Test Results

> **${label(tests.status)}** — ผลการรันทดสอบจริง

${meta}

| ทั้งหมด | ผ่าน | ไม่ผ่าน | ข้าม |
|:--:|:--:|:--:|:--:|
| **${count('total')}** | **${count('passed')}** | **${count('failed')}** | **${count('skipped')}** |

### ขั้นตอนตรวจสอบ

| ขั้นตอน | ผล |
|---|---|
| ติดตั้ง dependency ของแอป | ${label(summary.install.status)} |
| ตรวจไวยากรณ์ JavaScript | ${label(summary.syntax.status)} |
| สร้างเทสต์ด้วย AI | ${generated ? summary.generation?.status === 'generated' ? '✅ สร้างสำเร็จ' : '⚠️ ไม่พร้อมใช้งาน' : '⏭️ ใช้เทสต์เดิมของโปรเจกต์'} |
| รันเทสต์ด้วย ${cell(summary.runner || 'Node + jsdom')} | ${label(tests.status)} |
| Coverage | ${summary.coverageLabel || '⏭️ ยังไม่ได้วัด'} |
${caseTable}
${summary.coverageDetails || ''}

<details>
<summary>📄 เปิดดู Test log</summary>

<pre>${safe(tests.log || 'ไม่มีผลลัพธ์จากการรันเทสต์')}</pre>
</details>

${summary.errors.length ? '### ข้อผิดพลาดระหว่างทำงาน\n\n' + summary.errors.map(e => '- ' + safe(e)).join('\n') : ''}

${summary.testNote || (generated ? '📦 ไฟล์เทสต์ที่ Action สร้างอยู่ใน artifact **aq-generated-tests** และผลการรันอยู่ใน **quality-gate-results** — โปรเจกต์แอปไม่ต้องมีชุดเทสต์เอง' : 'ใช้ชุดทดสอบที่มีอยู่ในโปรเจกต์')}

*Security Audit และ AI Code Review แยกแสดงในคอมเมนต์ของบอตด้านล่าง*`;

  const audit = summary.audit;
  const complete = audit.status === 'complete';
  const status = complete ? audit.isSecure ? '✅ ไม่พบ High / Critical' : '❌ พบความเสี่ยงที่ต้องตรวจสอบ' : '⚠️ ตรวจไม่สำเร็จ';
  const securityBody = `## 🛡️ Automated Quality Gate · Security Audit

> **${status}**

${meta}

ผลจาก **npm audit** ของ dependency ในโปรเจกต์

| 🔴 Critical | 🟠 High | 🟡 Moderate | 🔵 Low |
|:--:|:--:|:--:|:--:|
| **${complete ? audit.critical || 0 : '—'}** | **${complete ? audit.high || 0 : '—'}** | **${complete ? audit.moderate || 0 : '—'}** | **${complete ? audit.low || 0 : '—'}** |

### แพ็กเกจที่พบข้อสังเกต

${complete ? (audit.details || []).length ? audit.details.map(x => '- ' + safe(x)).join('\n') : 'ไม่พบรายการจาก npm audit' : 'ไม่มีผล audit ที่ยืนยันได้ จึงไม่ถือว่าผ่านการตรวจ'}

---

**เกณฑ์ตรวจ:** High หรือ Critical ทำให้ผล audit ไม่ผ่าน

${summary.sonarDetails || 'ส่วน SonarCloud ยังไม่ได้เรียกใช้ในโหมดนี้'}`;

  const aiStatus = {clean:'✅ ไม่พบข้อบกพร่องจากการรีวิว',suspicious:'🟡 มีข้อสังเกต',buggy:'🔴 พบประเด็นที่ควรแก้ไข',unavailable:'⚠️ รีวิวไม่สำเร็จ',skipped:'⏭️ ข้ามการรีวิว'}[summary.ai.status] || '⚠️ ไม่มีผลรีวิว';
  const aiBody = `## 🤖 Automated Quality Gate · AI Code Review

> **${aiStatus}**

${meta}

**Model:** \`${safe(model)}\` · **Framework:** ${cell(summary.frameworkLabel || 'AngularJS 1.x')}

### 🔍 ข้อค้นพบ

${safe(summary.ai.findings || 'ไม่มีข้อความรีวิว')}

${summary.ai.remediation ? '### 💡 แนวทางแก้ไข\n\n' + safe(summary.ai.remediation) : ''}
${summary.aiDetails || ''}

<details>
<summary>📂 ไฟล์ที่ใช้ประกอบการรีวิว (${summary.files.length})</summary>

${summary.files.map(f => '- ' + safe(f)).join('\n') || 'ไม่มีข้อมูลไฟล์'}
${summary.omitted.length ? '\nไฟล์ที่ข้าม:\n' + summary.omitted.map(f => '- ' + safe(f)).join('\n') : ''}
</details>

---

*ผลส่วนนี้เป็นการวิเคราะห์ของ AI ตามโมเดลที่ระบุ ส่วนผลการรันเทสต์และ dependency audit อยู่ในคอมเมนต์แยก*`;
  return [{key:'tests',body:testBody},{key:'security',body:securityBody},{key:'ai',body:aiBody}];
}

module.exports = {renderComments};
