const {test} = require('node:test');
const assert = require('node:assert/strict');
const {evaluateAudit} = require('../lib/audit');
const {renderComments} = require('../lib/reporting/angularjs');
const {emptySummary} = require('../lib/angularjs/adapter');
const advisory = (source=123) => ({source, severity:'high'});
const report = (via=[advisory()]) => ({vulnerabilities:{legacy:{name:'legacy',severity:'high',via}}});
const decision = {package:'legacy', id:123, reason:'Accepted temporarily', expires:'2030-01-01'};
const check = (data, decisions=[]) => evaluateAudit(data,{decisions},'2026-11-03');

test('audit exceptions match package AND advisory, never an undefined id', () => {
  assert.equal(check(report()).isSecure,false);
  const accepted = check(report(),[decision]);
  assert.equal(accepted.isSecure,true);
  assert.equal(accepted.ignored.length,1);
  assert.equal(check(report(),[{...decision,package:'another'}]).isSecure,false);
  assert.equal(check(report([advisory(456)]),[decision]).isSecure,false);
  for (const invalid of [{name:'legacy'}, {id:123}, {...decision,id:undefined}, {...decision,id:'123'}, {...decision,expires:'2030-02-30'}, {...decision,reason:''}]) {
    const result=check(report(),[invalid]);
    assert.equal(result.status,'error'); assert.equal(result.isSecure,null);
  }
});
test('new advisories and expired exceptions keep the gate failed', () => {
  assert.equal(check(report([advisory(),advisory(456)]),[decision]).isSecure,false);
  const expired = check(report(),[{...decision,expires:'2020-01-01'}]);
  assert.equal(expired.isSecure,false); assert.equal(expired.ignored.length,0); assert.equal(expired.warnings.length,1);
  assert.equal(check(report(),[{...decision,expires:'2026-11-03'}]).isSecure,true);
});
test('transitive causes require an explicit exception for each affected package; cycles stay failed', () => {
  const data=report(); data.vulnerabilities.parent={name:'parent',severity:'high',via:['legacy']};
  assert.equal(check(data,[decision]).isSecure,false);
  assert.equal(check(data,[decision,{...decision,package:'parent'}]).isSecure,true);
  data.vulnerabilities.legacy.via=['parent'];
  assert.equal(check(data,[decision,{...decision,package:'parent'}]).isSecure,false);
  data.vulnerabilities.legacy.via=['unknown'];
  assert.equal(check(data,[decision]).isSecure,false);
});
test('invalid output is never a pass, empty valid output is a pass', () => {
  for (const data of [{},{error:{code:'E401'},vulnerabilities:{}},{vulnerabilities:[]},report([{source:123}])]) {
    assert.notEqual(check(data,[decision]).isSecure,true);
  }
  assert.equal(check({vulnerabilities:{}}).isSecure,true);
});
test('security report preserves accepted-risk reasons and audit errors', () => {
  const summary=emptySummary('abc'); summary.audit=check(report(),[decision]);
  const output=renderComments(summary,'model')[1].body;
  assert.match(output,/Accepted temporarily/); assert.match(output,/2030-01-01/); assert.match(output,/#123/);
  summary.audit=check(report(),[{name:'legacy'}]);
  assert.match(renderComments(summary,'model')[1].body,/Each audit exception requires/);
});
