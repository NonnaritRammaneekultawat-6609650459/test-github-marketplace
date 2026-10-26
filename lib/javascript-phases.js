const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {childEnvironment} = require('./angularjs/adapter');
const {jestResults} = require('./reporting/javascript');
const {MARKER} = require('./persist-tests');
const dir = '.aq-generated';
const manifestPath = path.join(dir,'javascript.json');

function read(head) {
  if (fs.statSync(manifestPath).size > 2*1024*1024) throw new Error('Oversized generation artifact');
  const data = JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if (data.version !== 1 || data.head !== head || data.framework !== 'javascript' || !data.files || Object.keys(data.files).length > 20) throw new Error('Invalid generation artifact or stale commit');
  for (const [name,text] of Object.entries(data.files)) if (!/^Test\/quality-gate\/[a-f0-9]{16}\.test\.js$/.test(name) || typeof text !== 'string' || !text.startsWith(MARKER) || text.length > 100000) throw new Error('Invalid generated test file');
  return data;
}

async function generate({api,repository,head,files,classify,generateText,template}) {
  const data = {version:1,framework:'javascript',head,status:'unavailable',files:{},classifications:{},modifiedFiles:[],aiErrors:[]};
  try {
    const source = files.filter(f=>f.status !== 'removed' && /^src\/.*\.js$/.test(f.filename) && !/\.(test|spec)\.js$/.test(f.filename));
    if (source.length > 20) throw new Error('Too many changed source files; split the PR');
    const configFile = await api(`/repos/${repository}/contents/config_cov.json?ref=${head}`);
    data.config = JSON.parse(Buffer.from(configFile.content,'base64').toString('utf8'));
    if (data.config.files && (typeof data.config.files !== 'object' || Array.isArray(data.config.files) || Object.values(data.config.files).some(n=>!Number.isInteger(n)||n<1||n>100))) throw new Error('Invalid per-file coverage config');
    if (!source.length) { data.status='existing'; return data; }
    for (const file of source) {
      const blob = await api(`/repos/${repository}/contents/${file.filename}?ref=${head}`);
      const code = Buffer.from(blob.content,'base64').toString('utf8');
      if (Buffer.byteLength(code) > 40000) throw new Error('Source exceeds AI context limit');
      data.modifiedFiles.push(file.filename);
      const classification = await classify(file.filename,code);
      classification.targetCoverage = data.config.files?.[file.filename] || data.config.global;
      data.classifications[file.filename] = classification;
      if (classification.review.status === 'unavailable') data.aiErrors.push(classification.review.findings);
      const name = 'Test/quality-gate/'+createHash('sha256').update(file.filename).digest('hex').slice(0,16)+'.test.js';
      let relative = path.posix.relative(path.posix.dirname(name),file.filename);
      if (!relative.startsWith('.')) relative='./'+relative;
      const prompt = template.replaceAll('{{source_file}}',file.filename).replaceAll('{{relative_path}}',relative)
        .replaceAll('{{code}}',code).replace('{{classification}}',JSON.stringify(classification))
        .replace('{{spec_context}}','').replace('{{target_coverage}}',String(classification.targetCoverage));
      let text = (await generateText(prompt)).trim().replace(/^```(?:javascript|js)?\s*\n?/,'').replace(/\n?```$/,'');
      new vm.Script(text); // Parse, never execute with AI credentials.
      if (!/\b(test|it|describe)(?:\.(each|only|skip))?\s*\(/.test(text)) throw new Error('AI output has no Jest tests');
      data.files[name]=MARKER+text+'\n';
    }
    data.status='generated';
  } catch (error) { data.aiErrors.push(error.name === 'AIError' ? error.message : 'JavaScript test generation incomplete; check source, coverage config and AI output.'); }
  finally {
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(manifestPath,JSON.stringify(data,null,2));
  }
  return data;
}

function checks(head,installStatus,audit) {
  const summary = {framework:'javascript',head,modifiedFiles:[],classifications:{},testsGenerated:0,
    tests:{status:'unavailable'},jestPassed:false,coverageMet:false,coverage:{},audit:null,aiErrors:[],success:false,startTime:Date.now()};
  try {
    const data = read(head);
    Object.assign(summary,{modifiedFiles:data.modifiedFiles,classifications:data.classifications,aiErrors:data.aiErrors,testsGenerated:Object.keys(data.files).length});
    summary.install={status:installStatus==='success'?'passed':'failed'};
    summary.testOrigin=data.status==='existing'?'existing':'generated';
    summary.reviewSkipped=data.status==='existing';
    try { summary.audit=audit(); } catch { summary.audit={status:'error',isSecure:false}; }
    if (!['generated','existing'].includes(data.status) || installStatus !== 'success') throw new Error('Tests unavailable or dependency installation failed');
    for (const [name,text] of Object.entries(data.files)) {
      // Refuse symlinked directories/files from untrusted checkouts.
      let current=process.cwd();
      for (const segment of name.split('/')) {
        current=path.join(current,segment);
        if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Generated test path is a symlink');
      }
      fs.mkdirSync(path.dirname(name),{recursive:true}); fs.writeFileSync(name,text);
    }
    for (const file of ['.aq-jest-results.json','coverage/coverage-summary.json']) if (fs.existsSync(file)) fs.unlinkSync(file);
    const result = spawnSync(process.platform === 'win32' ? 'npx.cmd':'npx',
      ['--no-install','jest','--runInBand','--json','--outputFile=.aq-jest-results.json','--coverage','--coverageReporters=json-summary','--coverageReporters=lcov'],
      {encoding:'utf8',shell:process.platform==='win32',timeout:120000,maxBuffer:4*1024*1024,env:childEnvironment()});
    console.log(result.stdout || ''); console.log(result.stderr || '');
    const results=JSON.parse(fs.readFileSync('.aq-jest-results.json','utf8'));
    summary.tests=jestResults(results,(result.stdout||'')+'\n'+(result.stderr||''),result.status);
    for (const name of Object.keys(data.files)) {
      if (!results.testResults?.some(suite=>path.resolve(suite.name)===path.resolve(name))) throw new Error('Jest config did not run all generated tests; include Test/quality-gate/ in the project test roots');
    }
    summary.jestPassed=!result.error && result.status===0 && summary.tests.total>0 && summary.tests.passed>0;
    const coverage=JSON.parse(fs.readFileSync('coverage/coverage-summary.json','utf8'));
    summary.coverage={...coverage.total,required:data.config.global};
    if (!Number.isInteger(data.config.global) || data.config.global<1 || data.config.global>100) throw new Error('Invalid coverage configuration');
    summary.coverageMet=Number(coverage.total?.statements?.pct)>=data.config.global;
    summary.fileStatus={};
    for (const file of data.modifiedFiles) {
      const actual=coverage[path.resolve(file)]?.statements?.pct;
      const required=data.config.files?.[file] || data.config.global;
      const pass=Number.isFinite(actual) && actual>=required;
      summary.fileStatus[file]={actual,required,pass};
      if (!pass) summary.coverageMet=false;
    }
    summary.success=summary.jestPassed && summary.coverageMet && summary.audit.isSecure===true && !summary.aiErrors.length && Object.values(data.classifications).every(c=>c.review?.status==='clean');
  } catch (error) { summary.aiErrors.push('Checks incomplete: '+error.message); }
  finally { fs.writeFileSync('.gate-state.json',JSON.stringify(summary,null,2)); }
  return summary;
}

function state(head) {
  if (fs.statSync('.gate-state.json').size > 2*1024*1024) throw new Error('Oversized check artifact');
  const data=JSON.parse(fs.readFileSync('.gate-state.json','utf8'));
  if (data.head!==head || data.framework!=='javascript') throw new Error('Check artifact belongs to a different commit');
  return data;
}
module.exports={generate,checks,read,state};
