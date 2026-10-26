const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adapter = require('../lib/angularjs/adapter');
const generation = require('../lib/angularjs/generation');

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

test('generation validates syntax without executing code and binds tests to the commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'aq-generation-'));
  try {
    const code = "const assert=require('node:assert/strict');\nconst expected = \"require('node:assert/strict')\";\nconst {test}=require('node:test'); const {setup}=require('./harness.cjs'); throw new Error('must not execute during generation');";
    generation.saveGeneration(dir,'abc',code,{ai:{status:'clean',findings:'ok'}});
    const saved=fs.readFileSync(path.join(dir,'generated.test.cjs'),'utf8');
    assert.ok(saved.includes("const assert=require('./assert.cjs')"));
    assert.ok(saved.includes("const expected = \"require('node:assert/strict')\""));
    assert.equal(generation.readGeneration(dir,'abc').status,'generated');
    assert.throws(()=>generation.readGeneration(dir,'wrong-head'),/mismatch/);
    assert.throws(()=>generation.saveGeneration(dir,'abc','const broken = ;'),SyntaxError);
    generation.saveGeneration(dir,'abc',null,{error:'API unavailable'});
    assert.equal(generation.readGeneration(dir,'abc').status,'unavailable');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('discovers AngularJS bootstrap order without consumer test scripts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'aq-discovery-'));
  try {
    fs.mkdirSync(path.join(dir,'src'));
    fs.writeFileSync(path.join(dir,'src/module.js'),"angular.module('demo',[]);");
    fs.writeFileSync(path.join(dir,'src/service.js'),"angular.module('demo').factory('Example',function(){});");
    fs.writeFileSync(path.join(dir,'index.html'),'<html ng-app="demo"><script src="src/module.js"></script><script src="src/service.js"></script>');
    const discovered = generation.discover(dir);
    assert.deepEqual(discovered.files,['src/module.js','src/service.js']);
    assert.deepEqual(discovered.modules,['demo']);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('cross-realm assertions preserve real value failures and reference equality', () => {
  const vm = require('node:vm');
  const shim = {exports:{}};
  new Function('require','module',require('../lib/angularjs/assertions'))(require,shim);
  const compare = shim.exports;
  const foreign = vm.runInNewContext('({items:[1,undefined,NaN], nested:{value:2}})');
  compare.deepStrictEqual(foreign,{items:[1,undefined,NaN],nested:{value:2}});
  assert.throws(()=>compare.deepStrictEqual(foreign,{items:[1,undefined,NaN],nested:{value:3}}));
  assert.throws(()=>compare.strictEqual(foreign,{}));
  assert.throws(()=>compare.deepStrictEqual(new Array(1),[undefined]));
  assert.throws(()=>compare.deepStrictEqual(Object.create(null),{}));
  class Example {constructor(){this.x=1;}}
  assert.throws(()=>compare.deepStrictEqual(new Example(),{x:1}));
});

test('harness registers cleanup without a generated test context variable', () => {
  const hooks = [];
  let closed = 0;
  const shim = {exports:{}};
  class DOM {
    constructor() {
      this.window = {eval(){}, angular:{injector:()=>({})}, close:()=>closed++};
    }
  }
  const imports = name => ({
    'node:fs':{readFileSync:()=>''}, 'node:path':{join:()=>''},
    jsdom:{JSDOM:DOM}, 'node:test':{after:callback=>hooks.push(callback)},
    'istanbul-lib-instrument':{createInstrumenter:()=>({instrumentSync:code=>code})},
    'istanbul-lib-coverage':{createCoverageMap:()=>({merge(){},toJSON:()=>({})})}
  })[name];
  new Function('require','module',require('../lib/angularjs/harness'))(imports,shim);
  shim.exports.setup();
  assert.equal(closed,0);
  assert.equal(hooks.length,1);
  hooks[0]();
  assert.equal(closed,1);
});
