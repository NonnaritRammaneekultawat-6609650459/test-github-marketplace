const markers = {tests:'<!-- automated-quality-gate -->',security:'<!-- automated-quality-gate-security -->',ai:'<!-- automated-quality-gate-ai -->'};

async function publishComments(octokit, repo, number, parts) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments,{...repo,issue_number:number,per_page:100});
  const published = [];
  for (const part of parts) {
    const marker = markers[part.key];
    if (!marker) throw new Error('Unknown report section');
    const existing = comments.find(c => c.user?.login === 'github-actions[bot]' &&
      (c.body?.includes(marker) || (part.key === 'tests' && c.body?.includes('<!-- aq-angularjs-review -->'))));
    const body = `${marker}\n${part.body}`;
    const {data} = existing
      ? await octokit.rest.issues.updateComment({...repo,comment_id:existing.id,body})
      : await octokit.rest.issues.createComment({...repo,issue_number:number,body});
    published.push({key:part.key,id:data.id,url:data.html_url,body});
  }
  if (published.length > 1) {
    const titles = {tests:'🧪 Test Results',security:'🛡️ Security Audit',ai:'🤖 AI Code Review'};
    const navigation = published.map(p => `[${titles[p.key]}](${p.url})`).join(' · ');
    for (const part of published) {
      await octokit.rest.issues.updateComment({...repo,comment_id:part.id,body:`${part.body}\n\n---\n\n${navigation}`});
    }
  }
  return published;
}

module.exports = {publishComments,markers};
