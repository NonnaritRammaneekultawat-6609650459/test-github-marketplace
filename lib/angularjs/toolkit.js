const pkg = require('./tooling/package.json');
const lock = require('./tooling/package-lock.json');
const runner = require('./runner');
const harness = require('./harness');
const assertions = require('./assertions');

function files() {
  return {'quality-gate/package.json':JSON.stringify(pkg,null,2)+'\n',
    'quality-gate/package-lock.json':JSON.stringify(lock,null,2)+'\n',
    'quality-gate/run.cjs':runner,'quality-gate/harness.cjs':harness,'quality-gate/assert.cjs':assertions};
}
module.exports = {files};
