const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adapter = require('../angularjs-support');

test('failed existing tests remain failed while audit still runs and report keeps evidence', () => {
  const previous = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-angular-test-'));
  try {
    process.chdir(dir);
    fs.writeFileSync('package.json', JSON.stringify({dependencies:{angular:'1.8.3'},scripts:{check:'node --check app.js', test:'node --test'}}));
    fs.writeFileSync('app.js', 'const valid = true;');
    fs.writeFileSync('example.test.cjs', "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('regression',()=>assert.equal(1,2));");
    let audited = false;
    const summary = adapter.runChecks({head:'abc', installStatus:'success', audit:()=>{
      audited=true; return {status:'complete',isSecure:true,high:0,critical:0};
    }});
    assert.equal(adapter.detectProject(), true);
    assert.equal(summary.syntax.status, 'passed');
    assert.equal(summary.tests.status, 'failed');
    assert.equal(summary.tests.total, 1);
    assert.equal(summary.tests.failed, 1);
    assert.equal(audited, true);
    assert.match(adapter.formatReport(summary,'test-model'), /regression/);
    assert.match(adapter.formatReport(summary,'test-model'), /Overall result:\*\* ❌ FAIL/);
    assert.equal(adapter.isPassing(summary), false);
    fs.writeFileSync('.gate-state.json',JSON.stringify(summary));
    assert.equal(adapter.loadState('.gate-state.json','abc').tests.failed,1);
    assert.equal(adapter.loadState('.gate-state.json','other-head').tests.status,'unavailable');
  } finally { process.chdir(previous); fs.rmSync(dir,{recursive:true,force:true}); }
});

test('installation failure skips execution and missing artifacts never imply pass', () => {
  const summary = adapter.runChecks({head:'abc',installStatus:'failure',audit:()=>{throw new Error('must not run');}});
  assert.equal(summary.tests.status,'skipped');
  assert.equal(summary.install.status,'failed');
  const missing = adapter.loadState(path.join(os.tmpdir(),'aq-not-existing-123.json'),'abc');
  assert.equal(missing.tests.status,'unavailable');
  assert.match(adapter.formatReport(missing,'model'),/INCOMPLETE/);
});

test('secrets and Actions command channels are not inherited by project commands', () => {
  const original = process.env.INPUT_GEMINI_API_KEY;
  process.env.INPUT_GEMINI_API_KEY = 'not-a-real-key';
  try {
    const env = adapter.childEnvironment();
    assert.equal(env.INPUT_GEMINI_API_KEY,undefined);
    assert.ok(Object.keys(env).every(k => !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(k)));
  } finally {
    if (original === undefined) delete process.env.INPUT_GEMINI_API_KEY;
    else process.env.INPUT_GEMINI_API_KEY = original;
  }
});

test('HTML-only PR includes AngularJS modules and tests without executing them', async () => {
  const files = ['src/app.js','src/task.service.js','index.html','test/app.test.cjs'];
  const api = {rest:{git:{getTree:async()=>({data:{tree:files.map(p=>({path:p,type:'blob',mode:'100644',size:20}))}})},
    pulls:{listFiles:'list'},repos:{getContent:async({path:p})=>({data:{encoding:'base64',content:Buffer.from(`text ${p}`).toString('base64')}})}},
    paginate:async()=>[{filename:'index.html',status:'modified',patch:'+template'}]};
  const context = await adapter.remoteContext(api,{owner:'test',repo:'test'},{number:1,head:{sha:'abc'}});
  assert.equal(context.files[0],'index.html');
  assert.deepEqual(new Set(context.files),new Set(files));
  assert.match(context.text,/PR changes/);
});

test('untrusted logs cannot inject HTML or bot markers into comments', () => {
  const summary = adapter.emptySummary('abc');
  summary.tests.log = '<!-- automated-quality-gate --><img src="remote"> @someone';
  const report = adapter.formatReport(summary,'model');
  assert.ok(!report.includes('<img'));
  assert.ok(!report.includes('<!-- automated-quality-gate -->'));
  assert.ok(!report.includes('@someone'));
});
