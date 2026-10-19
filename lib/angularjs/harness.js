// Copied by the action into its temporary runtime, never into the consumer repo.
module.exports = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {after} = require('node:test');
const root = process.env.AQ_PROJECT_ROOT;

function setup(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost', runScripts: 'outside-only'
  });
  try {
    const files = JSON.parse(process.env.AQ_SOURCE_FILES || '[]');
    dom.window.eval(fs.readFileSync(path.join(root, 'node_modules/angular/angular.js'), 'utf8'));
    for (const file of files) dom.window.eval(fs.readFileSync(path.join(root, file), 'utf8'));
    const modules = options.modules || JSON.parse(process.env.AQ_MODULES || '[]');
    const injector = dom.window.angular.injector(['ng', ...modules]);
    after(() => dom.window.close());
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
      close: () => dom.window.close()};
  } catch (error) { dom.window.close(); throw error; }
}
module.exports = {setup};
`;
