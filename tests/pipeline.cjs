const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {publishTests,MARKER} = require('../lib/persist-tests');

function apiFixture({sha='head',fork=false,existing='',race=false,branch='feature'}={}) {
  const calls=[];
  const api=async (route,method='GET',body)=>{
    calls.push({route,method,body});
    if(route.endsWith('/pulls/1')) return {state:'open',head:{sha,ref:branch,repo:{full_name:fork?'other/app':'user/app'}},base:{ref:'main'}};
    if(route==='/repos/user/app') return {default_branch:'main'};
    if(route.endsWith('/git/commits/head')) return {tree:{sha:'tree'}};
    if(route.includes('/git/trees/tree?')) return {truncated:false,tree:existing?[{path:'quality-gate/generated.test.cjs',mode:'100644',type:'blob',sha:'blob'}]:[]};
    if(route.endsWith('/git/blobs/blob')) return {encoding:'base64',content:Buffer.from(existing).toString('base64')};
    if(method==='POST'&&route.endsWith('/git/trees')) return {sha:'newtree'};
    if(method==='POST'&&route.endsWith('/git/commits')) return {sha:'newhead'};
    if(method==='PATCH') { if(race) throw new Error('Non-fast-forward'); return {}; }
    if(route.endsWith('/check-runs')) return {};
    throw new Error('Unexpected '+route);
  };
  return {api,calls};
}

test('tests including failures are committed only to the PR branch with a result on the new head',async()=>{
  const {api,calls}=apiFixture();
  const result=await publishTests(api,'user/app',1,'head',{'quality-gate/generated.test.cjs':MARKER+'test failing code'},'failure');
  assert.equal(result.sha,'newhead');
  const update=calls.find(c=>c.method==='PATCH');
  assert.equal(update.route,'/repos/user/app/git/refs/heads/feature');
  assert.deepEqual(update.body,{sha:'newhead',force:false});
  assert.equal(calls.find(c=>c.route.endsWith('/check-runs')).body.conclusion,'failure');
  assert.equal(calls.find(c=>c.route.endsWith('/check-runs')).body.head_sha,'newhead');
  assert.deepEqual(calls.find(c=>c.method==='POST'&&c.route.endsWith('/git/commits')).body.parents,['head']);
});

test('stale PRs, forks, default branches and user-owned tests are never overwritten',async()=>{
  for(const options of [{sha:'newer'},{fork:true},{branch:'main'},{existing:'// my own test'}]) {
    const {api,calls}=apiFixture(options);
    await assert.rejects(publishTests(api,'user/app',1,'head',{'quality-gate/generated.test.cjs':MARKER+'new'},'success'));
    assert.ok(!calls.some(c=>c.method!=='GET'));
  }
  const {api,calls}=apiFixture({race:true});
  await assert.rejects(publishTests(api,'user/app',1,'head',{'quality-gate/generated.test.cjs':MARKER+'new'},'success'),/Non-fast-forward/);
  assert.ok(!calls.some(c=>c.route.endsWith('/check-runs')));
});

test('identical generated tests do not create more commits; path injection is rejected',async()=>{
  const text=MARKER+'same';const {api,calls}=apiFixture({existing:text});
  const result=await publishTests(api,'user/app',1,'head',{'quality-gate/generated.test.cjs':text},'success');
  assert.equal(result.changed,0);assert.ok(!calls.some(c=>c.method==='PATCH'));
  for(const name of ['src/app.js','../main.js','.github/workflows/evil.yml']) await assert.rejects(publishTests(api,'user/app',1,'head',{[name]:text},'success'),/validation/);
});

test('committable AngularJS tooling measures real source and keeps test failure separate from coverage',()=>{
  const toolkit=require('../lib/angularjs/toolkit');
  const fixture=path.join(__dirname,'fixtures/angularjs');
  const deps=path.resolve(__dirname,'../lib/angularjs/tooling/node_modules');
  assert.ok(fs.existsSync(path.join(deps,'jsdom')),'Run npm ci --prefix lib/angularjs/tooling first');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aq-angular-coverage-'));
  try {
    fs.mkdirSync(path.join(root,'src'));
    fs.copyFileSync(path.join(fixture,'src/app.js'),path.join(root,'src/app.js'));
    fs.symlinkSync(path.join(fixture,'node_modules'),path.join(root,'node_modules'),'junction');
    for(const [name,text] of Object.entries(toolkit.files())) { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),text); }
    fs.symlinkSync(deps,path.join(root,'quality-gate/node_modules'),'junction');
    const file=path.join(root,'quality-gate/generated.test.cjs');
    const start="const {test}=require('node:test'); const assert=require('./assert.cjs'); const {setup}=require('./harness.cjs');\n";
    function run(code,threshold=100) {
      fs.writeFileSync(file,start+code);
      fs.writeFileSync(path.join(root,'config_cov.json'),JSON.stringify({global:threshold,files:{}}));
      const result=spawnSync(process.execPath,[path.join(root,'quality-gate/run.cjs')],{cwd:root,encoding:'utf8',timeout:20000});
      const coverage=JSON.parse(fs.readFileSync(path.join(root,'coverage/quality-gate/result.json'),'utf8'));
      return {result,coverage};
    }
    let run1=run("test('positive',()=>assert.equal(setup().get('MathService').abs(2),2));");
    assert.equal(run1.coverage.status,'failed',run1.result.stdout+run1.result.stderr+JSON.stringify(run1.coverage));
    assert.ok(run1.coverage.metrics.statements.pct<100);
    assert.match(run1.result.stdout,/# pass 1/);
    const full="test('both paths',()=>{const s=setup().get('MathService');assert.equal(s.abs(2),2);assert.equal(s.abs(-2),2);});";
    const run2=run(full);
    assert.equal(run2.result.status,0,run2.result.stdout+run2.result.stderr+JSON.stringify(run2.coverage));
    assert.equal(run2.coverage.metrics.statements.pct,100);
    assert.equal(run2.coverage.metrics.branches.pct,100);
    assert.ok(fs.existsSync(path.join(root,'coverage/quality-gate/lcov.info')));
    assert.ok(fs.existsSync(path.join(root,'coverage/quality-gate/index.html')));
    const run3=run("test('failing',()=>{const s=setup().get('MathService');s.abs(-2);assert.equal(s.abs(2),999);});",1);
    assert.equal(run3.result.status,1);assert.match(run3.result.stdout,/# fail 1/);
    assert.equal(run3.coverage.status,'passed'); // Test failure is still retained separately.
    fs.writeFileSync(path.join(root,'src/unused.js'),'function neverCalled(){ return 1; }');
    const run4=run(full);
    assert.equal(run4.coverage.status,'failed');
    assert.equal(run4.coverage.files['src/unused.js'].statements.pct,0);
  } finally {
    // Unlink junctions explicitly before removing the verified temporary fixture.
    for(const name of ['node_modules','quality-gate/node_modules']) if(fs.existsSync(path.join(root,name))) fs.unlinkSync(path.join(root,name));
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('aq-angular-coverage-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('isolated JavaScript phases generate reviewable tests and run real Jest coverage without AI credentials',async()=>{
  const phases=require('../lib/javascript-phases');
  const original=process.cwd();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aq-javascript-pipeline-'));
  try {
    process.chdir(root);
    fs.mkdirSync('src');fs.writeFileSync('src/math.js','module.exports = (a,b) => a+b;');
    fs.writeFileSync('package.json',JSON.stringify({private:true}));
    fs.writeFileSync('jest.config.cjs',"module.exports={collectCoverageFrom:['src/**/*.js'],testEnvironment:'node'};");
    fs.writeFileSync('config_cov.json',JSON.stringify({global:80,files:{}}));
    fs.symlinkSync(path.join(original,'node_modules'),path.join(root,'node_modules'),'junction');
    const api=async route=>({encoding:'base64',content:fs.readFileSync(route.includes('config_cov')?'config_cov.json':'src/math.js').toString('base64')});
    const options={api,repository:'user/app',head:'head',files:[{filename:'src/math.js',status:'modified'}],
      classify:async()=>({review:{status:'clean',findings:'clean'}}),
      generateText:async()=>"const sum=require('../../src/math'); test('adds',()=>expect(sum(1,2)).toBe(3));",template:'{{code}} {{relative_path}}'};
    const generated=await phases.generate(options);
    assert.equal(generated.status,'generated');
    assert.equal(Object.keys(generated.files).length,1);
    assert.ok(Object.values(generated.files)[0].startsWith(MARKER));
    let summary=phases.checks('head','success',()=>({status:'complete',isSecure:true}));
    assert.equal(summary.success,true,JSON.stringify(summary));
    assert.equal(summary.tests.passed,1);assert.equal(summary.coverageMet,true);
    const {api:publish,calls}=apiFixture();
    await publishTests(publish,'user/app',1,'head',generated.files,'success');
    assert.ok(calls.find(c=>c.method==='POST'&&c.route.endsWith('/git/trees')).body.tree[0].path.startsWith('Test/quality-gate/'));
    await phases.generate({...options,classify:async()=>({review:{status:'unavailable',findings:'AI unavailable'}})});
    summary=phases.checks('head','success',()=>({status:'complete',isSecure:true}));
    assert.equal(summary.tests.status,'passed');assert.equal(summary.success,false);
    assert.ok(summary.aiErrors.includes('AI unavailable'));
    await phases.generate({...options,files:[]});
    summary=phases.checks('head','success',()=>({status:'complete',isSecure:true}));
    assert.equal(summary.testOrigin,'existing');
    assert.equal(summary.tests.passed,1);
    assert.equal(summary.success,true);
    assert.throws(()=>phases.read('different-head'),/stale/);
  } finally {
    process.chdir(original);
    if(fs.existsSync(path.join(root,'node_modules'))) fs.unlinkSync(path.join(root,'node_modules'));
    if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('aq-javascript-pipeline-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root,{recursive:true,force:true});
  }
});
