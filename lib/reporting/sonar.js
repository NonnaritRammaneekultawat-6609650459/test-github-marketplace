function sonarStatus(sonar) {
  if (!sonar || sonar.skipped) return 'skipped';
  return sonar.passed == null ? 'unavailable' : sonar.passed ? 'passed' : 'failed';
}

function sonarDetails(sonar,safe) {
  const status=sonarStatus(sonar);
  const titles={skipped:'⏭️ Skipped',unavailable:'⚠️ Unavailable',passed:'✅ Passed',failed:'❌ Failed'};
  const sections=['## 📡 SonarCloud · '+titles[status]];
  if (status==='skipped') sections.push(sonar?.error || 'SonarCloud is disabled for this workflow.');
  else if (status==='unavailable') {
    sections.push(safe(sonar.error || 'No verified Quality Gate result is available.'));
    if (sonar.reason==='automatic_analysis_enabled') sections.push('Open the project in SonarQube Cloud → Administration → Analysis Method. Turn off **Automatic Analysis**, then select **Re-run failed jobs** in GitHub Actions.');
  } else {
    const cell=v=>safe(v ?? '—').replace(/\|/g,'&#124;').replace(/\n/g,' ');
    const rows=(sonar.conditions || []).map(c=>[c.metricKey,c.actualValue,
      ({GT:'≤',LT:'≥',EQ:'≠',NE:'='}[c.comparator] || '')+' '+(c.errorThreshold ?? '—'),
      ({OK:'Passed',ERROR:'Failed',NO_VALUE:'Unavailable'}[c.status] || 'Unavailable')]);
    if (rows.length) sections.push('| Condition | Measured | Required | Result |\n|---|---:|---:|---|\n'+rows.map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n'));
    const metrics={bugs:'Bugs',vulnerabilities:'Vulnerabilities',code_smells:'Code smells',security_hotspots:'Security hotspots',coverage:'Coverage (%)',new_coverage:'New coverage (%)'};
    sections.push('| Metric | Result |\n|---|---:|\n'+Object.entries(metrics).map(([key,name])=>'| '+name+' | '+cell(sonar.metrics?.[key])+' |').join('\n'));
  }
  return sections.join('\n\n');
}
module.exports={sonarStatus,sonarDetails};
