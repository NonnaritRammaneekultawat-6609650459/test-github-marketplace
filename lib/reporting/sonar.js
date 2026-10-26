function sonarStatus(sonar) {
  if (!sonar || sonar.skipped) return 'skipped';
  return sonar.passed == null ? 'unavailable' : sonar.passed ? 'passed' : 'failed';
}

function sonarDetails(sonar, safe, label) {
  const status = sonarStatus(sonar);
  const cell = value => safe(value ?? '—').replace(/\|/g, '&#124;').replace(/\n/g, ' ');
  return `### 📡 SonarCloud\n\n${label(status)}\n\n` +
    (status === 'skipped' ? 'ไม่ได้เปิดใช้ SonarCloud ในการตรวจรอบนี้' :
      status === 'unavailable' ? 'สแกนไม่สำเร็จหรือยังยืนยันผลไม่ได้ จึงไม่ถือว่าผ่าน' :
        `Bugs: ${cell(sonar.metrics?.bugs)} · Vulnerabilities: ${cell(sonar.metrics?.vulnerabilities)} · Code smells: ${cell(sonar.metrics?.code_smells)}\n\nCoverage ทั้งโปรเจกต์: ${cell(sonar.metrics?.coverage)}% · โค้ดใหม่ใน PR: ${cell(sonar.metrics?.new_coverage)}%`) +
    (sonar?.error ? '\n\n' + cell(sonar.error) : '');
}

module.exports = {sonarStatus, sonarDetails};
