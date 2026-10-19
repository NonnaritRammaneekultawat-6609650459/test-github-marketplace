const {test} = require('node:test');
const assert = require('node:assert/strict');
const {emptySummary} = require('../lib/angularjs/adapter');
const {renderComments} = require('../lib/reporting/angularjs');
const {publishComments,markers} = require('../lib/reporting/pr-comments');
const {renderJavaScriptComments,jestResults} = require('../lib/reporting/javascript');

test('JavaScript shares three reports while retaining Jest, coverage and Sonar data', () => {
  const tests=jestResults({numTotalTests:3,numPassedTests:1,numFailedTests:1,numPendingTests:1,
    testResults:[{assertionResults:[{status:'passed',fullName:'adds'},{status:'failed',fullName:'rejects'},{status:'pending',fullName:'later'}]}]},'test log',1);
  const parts=renderJavaScriptComments({tests,modifiedFiles:['src/a.js'],testsGenerated:1,
    classifications:{'src/a.js':{importance:'high',targetCoverage:90,review:{status:'unavailable',findings:'API unavailable'}}},
    fileStatus:{'src/a.js':{actual:75,pass:false}},coverageMet:false,
    audit:{status:'complete',isSecure:true,moderate:2},sonar:{passed:true,metrics:{bugs:0}}},'model','abc');
  assert.deepEqual(parts.map(p=>p.key),['tests','security','ai']);
  assert.match(parts[0].body,/Jest/); assert.match(parts[0].body,/75%/);
  assert.match(parts[0].body,/⏭️.*later/); assert.match(parts[0].body,/\*\*3\*\*.*\*\*1\*\*.*\*\*1\*\*.*\*\*1\*\*/);
  assert.match(parts[1].body,/SonarCloud/); assert.match(parts[1].body,/PASS/);
  assert.match(parts[2].body,/รีวิวไม่สำเร็จ/); assert.match(parts[2].body,/API unavailable/);
  assert.ok(parts.every(p=>!p.body.includes('AngularJS 1.x')));
});

test('JavaScript skipped and absent Jest results never invent passing counts', () => {
  assert.equal(jestResults(null,'process failed',1).status,'unavailable');
  assert.equal(jestResults({numTotalTests:0},'',0).status,'unavailable');
  const parts=renderJavaScriptComments({skipped:true},'model','abc');
  assert.equal(parts.length,3); assert.match(parts[0].body,/SKIPPED/);
  assert.match(parts[1].body,/ตรวจไม่สำเร็จ/);
});

test('reports separate tests, security and AI with readable results and escaped logs', () => {
  const summary = emptySummary('abc');
  summary.testOrigin='generated';summary.generation={status:'generated'};
  summary.tests={status:'failed',total:2,passed:1,failed:1,skipped:0,log:'ok 1 - adds items\nnot ok 2 - bad | input\n<script>alert(1)</script>'};
  summary.audit={status:'complete',isSecure:false,high:1,details:['angular (high)']};
  summary.ai={status:'suspicious',findings:'Check persistence',remediation:'Use error handling'};
  const parts=renderComments(summary,'model');
  assert.deepEqual(parts.map(p=>p.key),['tests','security','ai']);
  assert.match(parts[0].body,/adds items/);
  assert.match(parts[0].body,/bad &#124; input/);
  assert.ok(!parts[0].body.includes('<script>'));
  assert.ok(!parts[0].body.includes('angular (high)'));
  assert.match(parts[1].body,/angular \(high\)/);
  assert.ok(!parts[1].body.includes('Check persistence'));
  assert.match(parts[2].body,/Check persistence/);
  assert.match(parts[2].body,/Use error handling/);
});

test('missing audit and tests display unavailable values rather than false passes', () => {
  const parts=renderComments(emptySummary('abc'),'model');
  assert.match(parts[0].body,/UNAVAILABLE/);
  assert.match(parts[1].body,/ตรวจไม่สำเร็จ/);
  assert.match(parts[1].body,/\*\*—\*\*/);
});

test('publishing migrates the old comment and updates three sections without duplicates', async () => {
  const entries=[
    {id:1,user:{login:'github-actions[bot]'},body:'<!-- aq-angularjs-review --> old'},
    {id:2,user:{login:'human'},body:markers.security}
  ];
  let nextId=3;
  const octokit={paginate:async()=>entries,rest:{issues:{listComments:'list',
    createComment:async({body})=>{
      const data={id:nextId++,user:{login:'github-actions[bot]'},body};data.html_url=`https://github.com/o/r/pull/1#issuecomment-${data.id}`;
      entries.push(data);return {data};
    },
    updateComment:async({comment_id,body})=>{
      const data=entries.find(c=>c.id===comment_id);data.body=body;data.html_url=`https://github.com/o/r/pull/1#issuecomment-${data.id}`;return {data};
    }
  }}};
  const parts=renderComments(emptySummary('abc'),'model');
  const first=await publishComments(octokit,{owner:'o',repo:'r'},1,parts);
  const second=await publishComments(octokit,{owner:'o',repo:'r'},1,parts);
  assert.equal(entries.length,4);
  assert.deepEqual(first.map(p=>p.id),second.map(p=>p.id));
  assert.equal(entries[1].body,markers.security);
  for(const part of first){
    const comment=entries.find(c=>c.id===part.id);
    assert.ok(comment.body.startsWith(markers[part.key]));
    for(const other of first) assert.ok(comment.body.includes(other.url));
  }
});
