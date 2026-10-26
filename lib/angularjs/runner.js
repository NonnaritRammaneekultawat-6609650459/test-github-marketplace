// This exact runner is installed in consumers and used by the isolated checks job.
module.exports = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createCoverageMap} = require('istanbul-lib-coverage');
const {createInstrumenter} = require('istanbul-lib-instrument');
const {createContext} = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const root = process.env.AQ_PROJECT_ROOT || path.resolve(__dirname, '..');
const output = process.env.AQ_COVERAGE_DIR || path.join(root, 'coverage', 'quality-gate');
fs.mkdirSync(output, {recursive:true});
// A run must not reuse coverage emitted by an earlier test process.
for (const entry of fs.readdirSync(output)) if (/^raw-\d+\.json$/.test(entry) || ['result.json','coverage-summary.json','lcov.info','index.html'].includes(entry)) fs.unlinkSync(path.join(output,entry));
const files = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir,entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js') && !/\.(test|spec)\.js$/.test(entry.name)) files.push(path.relative(root,full).replaceAll('\\','/'));
  }
}
walk(path.join(root,'src'));
const html = fs.existsSync(path.join(root,'index.html')) ? fs.readFileSync(path.join(root,'index.html'),'utf8') : '';
const ordered = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi)].map(m=>m[1].replace(/^\.\//,'').split('?')[0]).filter(f=>files.includes(f));
const definitions = [], modules = [];
for (const file of files) for (const match of fs.readFileSync(path.join(root,file),'utf8').matchAll(/angular\s*\.\s*module\s*\(\s*['"]([^'"]+)['"]\s*,\s*\[/g)) { definitions.push(file); modules.push(match[1]); }
const app = html.match(/\bng-app\s*=\s*['"]([^'"]+)['"]/i)?.[1];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(key) && !/^(INPUT_|ACTIONS_|NODE_OPTIONS|NODE_TEST_CONTEXT|GITHUB_(ENV|OUTPUT|PATH|STEP_SUMMARY))/.test(key)));
const result = spawnSync(process.execPath,['--test','--test-reporter=tap',path.join(__dirname,'generated.test.cjs')], {
  cwd:root, encoding:'utf8', timeout:120000, maxBuffer:4*1024*1024,
  env:{...env,AQ_PROJECT_ROOT:root,AQ_COVERAGE_DIR:output,AQ_SOURCE_FILES:JSON.stringify([...new Set([...ordered,...definitions,...files])]),AQ_MODULES:JSON.stringify(app ? [app] : [...new Set(modules)])}
});
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
let coverage;
try {
  if (result.error || result.signal) throw new Error('Test process did not finish; coverage unavailable');
  if (!files.length) throw new Error('No source files for coverage');
  const rawFiles = fs.readdirSync(output).filter(f=>/^raw-\d+\.json$/.test(f));
  if (!rawFiles.length) throw new Error('Tests produced no coverage evidence');
  const map = createCoverageMap({});
  // Include unexecuted source files at 0%, rather than silently excluding them.
  for (const file of files) {
    const instrumenter = createInstrumenter();
    instrumenter.instrumentSync(fs.readFileSync(path.join(root,file),'utf8'),path.join(root,file));
    map.addFileCoverage(instrumenter.lastFileCoverage());
  }
  const expected = new Set(files.map(f=>path.join(root,f)));
  for (const file of rawFiles) {
    const raw = JSON.parse(fs.readFileSync(path.join(output,file),'utf8'));
    for (const name of Object.keys(raw)) if (!expected.has(name)) delete raw[name];
    map.merge(raw);
  }
  const config = JSON.parse(fs.readFileSync(path.join(root,'config_cov.json'),'utf8'));
  if (!Number.isInteger(config.global) || config.global < 1 || config.global > 100) throw new Error('Invalid coverage threshold');
  if (config.files && (typeof config.files !== 'object' || Object.values(config.files).some(n=>!Number.isInteger(n)||n<1||n>100))) throw new Error('Invalid per-file coverage threshold');
  const summary = map.getCoverageSummary().toJSON();
  const byFile = {};
  let passed = Number(summary.statements.pct) >= config.global;
  for (const file of files) {
    const actual = map.fileCoverageFor(path.join(root,file)).toSummary().toJSON();
    const required = config.files?.[file];
    if (required !== undefined && Number(actual.statements.pct) < required) passed=false;
    byFile[file] = actual;
  }
  coverage={status:passed ? 'passed':'failed',required:config.global,metrics:summary,files:byFile,fileThresholds:config.files || {}};
  fs.writeFileSync(path.join(output,'coverage-summary.json'),JSON.stringify({total:summary,...byFile},null,2));
  const context = createContext({dir:output,coverageMap:map});
  for (const type of ['lcovonly','html']) reports.create(type).execute(context);
  console.log('Coverage statements: '+summary.statements.pct+'% / required '+config.global+'%');
} catch (error) { coverage={status:'unavailable',error:error.message}; }
fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(coverage,null,2));
process.exitCode = result.status === 0 && coverage.status === 'passed' ? 0 : 1;
`;
