// Shared by the isolated Action runtime and the committed consumer test tooling.
module.exports = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {after} = require('node:test');
const {createInstrumenter} = require('istanbul-lib-instrument');
const {createCoverageMap} = require('istanbul-lib-coverage');
const root = process.env.AQ_PROJECT_ROOT;
const coverage = createCoverageMap({});
process.on('exit', () => {
  if (!process.env.AQ_COVERAGE_DIR) return;
  fs.mkdirSync(process.env.AQ_COVERAGE_DIR,{recursive:true});
  fs.writeFileSync(path.join(process.env.AQ_COVERAGE_DIR,'raw-'+process.pid+'.json'),JSON.stringify(coverage.toJSON()));
});

function setup(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost', runScripts: 'outside-only'
  });
  try {
    const files = JSON.parse(process.env.AQ_SOURCE_FILES || '[]');
    dom.window.eval(fs.readFileSync(path.join(root, 'node_modules/angular/angular.js'), 'utf8'));
    const instrumenter = createInstrumenter();
    for (const file of files) dom.window.eval(instrumenter.instrumentSync(fs.readFileSync(path.join(root, file), 'utf8'),path.join(root,file)));
    const modules = options.modules || JSON.parse(process.env.AQ_MODULES || '[]');
    const injector = dom.window.angular.injector(['ng', ...modules]);
    let collected = false;
    const close = () => {
      if (!collected) { coverage.merge(dom.window.__coverage__ || {}); collected=true; }
      dom.window.close();
    };
    after(close);
    return {dom, window: dom.window, angular: dom.window.angular, injector,
      get: name => injector.get(name),
      controller: (name, locals = {}) => injector.get('$controller')(name, locals),
      readPage: (name = 'index.html') => fs.readFileSync(path.join(root, name), 'utf8'),
      failStorageWrites: () => {
        const prototype = dom.window.Storage.prototype;
        const original = prototype.setItem;
        prototype.setItem = function () { throw new Error('Storage quota exceeded'); };
        return () => { prototype.setItem = original; };
      },
      close};
  } catch (error) { dom.window.close(); throw error; }
}
module.exports = {setup};
`;
