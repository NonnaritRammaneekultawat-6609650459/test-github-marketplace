const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createClient, AIError, safeError, endpoint, publicAddress, publicLookup, postJson} = require('../lib/ai/client');

const config = {provider:'openai-compatible', apiKey:'fake-private-key', model:'vendor/model:custom', apiUrl:'https://ai.example/v1/chat/completions', timeout:10000};

test('arbitrary model IDs use the exact endpoint, key and prompt without a model allowlist', async () => {
  let calls = 0;
  const client = createClient(config, {postJson:async (url, body, key, timeout) => {
    calls++; assert.equal(url.href, config.apiUrl); assert.equal(key, config.apiKey); assert.equal(timeout, 10000);
    assert.deepEqual(body, {model:config.model, messages:[{role:'user',content:'write tests'}]});
    return {choices:[{message:{content:'test code'}}]};
  }});
  assert.equal((await client.generateContent('write tests')).response.text(), 'test code');
  assert.equal((await client.generateContent({contents:[{role:'user',parts:[{text:'write tests'}]}],generationConfig:{maxOutputTokens:8192}})).response.text(), 'test code');
  assert.equal(calls,2);
});

test('native Gemini preserves its SDK contract and uses the requested model and timeout', async () => {
  class FakeGemini {
    constructor(key) { assert.equal(key, config.apiKey); }
    getGenerativeModel(options, request) {
      assert.equal(options.model,'custom-gemini'); assert.equal(request.timeout,10000);
      return {generateContent:async prompt => {assert.equal(prompt,'hello'); return {response:{text:()=>'Gemini text'}};}};
    }
  }
  const client = createClient({...config,provider:'gemini',model:'custom-gemini'}, {GoogleGenerativeAI:FakeGemini});
  assert.equal((await client.generateContent('hello')).response.text(), 'Gemini text');
});

test('invalid credentials, permissions, missing models, quota, service errors and timeouts have safe distinct diagnostics', async () => {
  for (const [status,code] of [[401,'authentication'],[403,'permission'],[404,'not_found'],[429,'quota'],[503,'service'],[400,'unsupported']]) {
    const client = createClient(config, {postJson:async () => {throw Object.assign(new Error(config.apiKey),{status});}});
    await assert.rejects(client.generateContent('hello'), error => error.code === code && !error.message.includes(config.apiKey));
  }
  assert.equal(safeError({name:'AbortError',message:config.apiKey}).code,'timeout');
  assert.equal(safeError(new Error(config.apiKey)).code,'connection');
});

test('missing keys and malformed, empty, truncated or oversized AI outputs never become success', async () => {
  await assert.rejects(createClient({...config,apiKey:''}).generateContent('hello'), /not configured/);
  for (const data of [{}, {choices:[]}, {choices:[{message:{content:''}}]}, {choices:[{message:{content:[]}}]},
    {choices:[{message:{content:'partial'},finish_reason:'length'}]}, {choices:[{message:{content:'x'.repeat(2*1024*1024+1)}}]}]) {
    await assert.rejects(createClient(config,{postJson:async()=>data}).generateContent('hello'), AIError);
  }
});

test('credential reflections are removed from returned model text', async () => {
  const client = createClient(config,{postJson:async()=>({choices:[{message:{content:'reflected '+config.apiKey}}]})});
  assert.equal((await client.generateContent('hello')).response.text(),'reflected [REDACTED]');
});

test('unsafe URLs and private, mapped, link-local and reserved addresses are blocked', async () => {
  for (const url of ['http://ai.example/chat', 'https://user:pass@ai.example/chat', 'https://ai.example/chat?key=x', 'https://ai.example/#key']) assert.throws(()=>endpoint(url), AIError);
  for (const address of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','172.16.0.1','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2002:7f00:1::']) assert.equal(publicAddress(address),false,address);
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicAddress(address),true,address);
  await assert.rejects(postJson(endpoint('https://127.0.0.1/chat'),{},config.apiKey,1000), /public/);
  await assert.rejects(new Promise((resolve,reject)=>publicLookup('localhost',{},error=>error ? reject(error) : resolve())), /public/);
});

function mockRequest({status = 200, content = '{"choices":[]}', error} = {}) {
  return (url, options, callback) => {
    assert.equal(options.method,'POST'); assert.equal(options.headers.Authorization,'Bearer '+config.apiKey);
    assert.equal(options.lookup,publicLookup); assert.ok(options.signal);
    const req = new EventEmitter();
    req.end = body => {
      assert.deepEqual(JSON.parse(body),{prompt:'hello'});
      queueMicrotask(() => {
        if (error) { req.emit('error',error); return; }
        const res = new EventEmitter(); res.statusCode=status; res.destroy=()=>{};
        callback(res); res.emit('data',Buffer.from(content)); res.emit('end');
      });
    };
    return req;
  };
}

test('HTTPS transport parses bounded JSON and rejects redirects without forwarding credentials', async () => {
  const args = [endpoint(config.apiUrl),{prompt:'hello'},config.apiKey,1000];
  assert.deepEqual(await postJson(...args,mockRequest()),{choices:[]});
  await assert.rejects(postJson(...args,mockRequest({status:302,content:config.apiKey})),error=>error.code==='unsupported' && !error.message.includes(config.apiKey));
  await assert.rejects(postJson(...args,mockRequest({content:'not JSON '+config.apiKey})), /unsupported response format/);
  await assert.rejects(postJson(...args,mockRequest({content:'x'.repeat(2*1024*1024+1)})), /size limit/);
});

test('real Action entry preserves missing-key diagnostics through AngularJS generate and report phases', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const {spawnSync} = require('node:child_process');
  const adapter = require('../lib/angularjs/adapter');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'aq-ai-entry-'));
  const entry = path.resolve(__dirname,'../generate-tests.js');
  const env = {...adapter.childEnvironment(), INPUT_PROJECT_TYPE:'angularjs', INPUT_AI_PROVIDER:'openai-compatible',
    INPUT_AI_MODEL:'vendor/model', INPUT_AI_API_URL:config.apiUrl, GITHUB_SHA:'test-head'};
  try {
    const generate = spawnSync(process.execPath,[entry],{cwd:dir,env:{...env,INPUT_PHASE:'generate'},encoding:'utf8',timeout:20000});
    assert.equal(generate.status,0,generate.stdout+generate.stderr);
    const metadata = JSON.parse(fs.readFileSync(path.join(dir,'.aq-generated/manifest.json'),'utf8'));
    assert.equal(metadata.status,'unavailable');
    assert.match(metadata.error,/AI API key is not configured/);
    assert.equal(fs.existsSync(path.join(dir,'.aq-generated/generated.test.cjs')),false);
    const state = adapter.emptySummary('test-head');
    state.install.status='passed'; state.syntax.status='passed'; state.tests={status:'passed',total:1,passed:1};
    state.audit={status:'complete',isSecure:true,critical:0,high:0};
    fs.writeFileSync(path.join(dir,'.gate-state.json'),JSON.stringify(state));
    const report = spawnSync(process.execPath,[entry],{cwd:dir,env:{...env,INPUT_PHASE:'report'},encoding:'utf8',timeout:20000});
    assert.equal(report.status,1,report.stdout+report.stderr);
    assert.match(report.stdout,/AI API key is not configured/);
    assert.match(report.stdout,/INCOMPLETE|UNAVAILABLE/);
    assert.ok(!report.stdout.includes('Checks passed (coverage deferred)'));
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
