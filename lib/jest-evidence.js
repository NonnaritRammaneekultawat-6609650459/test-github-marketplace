const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');

// This function runs inside Jest's test environment, including when the Action is bundled.
function registerEvidence(fs, inspect) {
  const registry = globalThis[Symbol.for('$$jest-matchers-object')];
  if (!registry) return;
  let count = 0;
  const format = value => inspect(value, {depth:2, maxArrayLength:6, maxStringLength:100,
    customInspect:false, breakLength:Infinity}).slice(0,180);
  for (const [name, matcher] of Object.entries(registry.matchers)) {
    registry.matchers[name] = new Proxy(matcher, {
      apply(target, context, args) {
        const result = Reflect.apply(target, context, args);
        try {
          const test = context.currentConcurrentTestName?.() || context.currentTestName;
          if (test && count < 300) {
            const expected = name === 'toBe' && !context.isNot ? format(args[1])
              : (context.isNot ? 'not.' : '') + name + '(' + args.slice(1).map(format).join(', ') + ')';
            const entry = {file:context.testPath, test, expected, actual:format(args[0])};
            fs.appendFileSync(process.env.AQ_ASSERTIONS, JSON.stringify(entry)+'\n');
            count++;
          }
        } catch { /* Optional diagnostics must preserve the original matcher outcome. */ }
        return result;
      }
    });
  }
}

function runJest(env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqg-jest-'));
  try {
    const projectRequire = createRequire(require('node:url').pathToFileURL(process.cwd() + path.sep + '__aq_project__.cjs'));
    const cli = projectRequire.resolve('jest/bin/jest');
    const setup = path.join(temp,'capture.cjs');
    const evidence = path.join(temp,'assertions.jsonl');
    const options = {encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...env,AQ_ASSERTIONS:evidence}};
    const args = ['--runInBand','--json','--outputFile=.aq-jest-results.json','--coverage',
      '--coverageReporters=json-summary','--coverageReporters=lcov'];
    // Retain each project's configured test runner and setup modules.
    const config = spawnSync(process.execPath,[cli,'--showConfig'],options);
    if (config.status === 0) {
      const {configs} = JSON.parse(config.stdout);
      const runners = Object.fromEntries(configs.map(project => [project.id,project.testRunner]));
      fs.writeFileSync(setup,'(' + registerEvidence.toString() + ")(require('node:fs'), require('node:util').inspect);");
      const wrapper = path.join(temp,'runner.cjs');
      fs.writeFileSync(wrapper, [
        'const runners = '+JSON.stringify(runners)+';',
        'module.exports = (globalConfig, config, ...rest) => {',
        '  const runner = require(runners[config.id]);',
        '  const setupFilesAfterEnv = [...config.setupFilesAfterEnv, '+JSON.stringify(setup)+'];',
        '  return (runner.default || runner)(globalConfig, {...config,setupFilesAfterEnv}, ...rest);',
        '};'
      ].join('\n'));
      args.push('--testRunner',wrapper);
    }
    const result = spawnSync(process.execPath,[cli,...args],options);
    const entries = [];
    if (fs.existsSync(evidence) && fs.statSync(evidence).size < 4*1024*1024) {
      for (const line of fs.readFileSync(evidence,'utf8').trim().split('\n')) {
        try { entries.push(JSON.parse(line)); } catch { /* Ignore incomplete records. */ }
      }
    }
    return {result,entries};
  } finally {
    fs.rmSync(temp,{recursive:true,force:true});
  }
}

module.exports = {runJest};

