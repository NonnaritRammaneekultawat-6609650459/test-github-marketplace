// Plain data crosses jsdom's VM boundary. Preserve value checks without requiring
// its built-in Object/Array prototypes to equal Node's built-in prototypes.
module.exports = String.raw`
const strict = require('node:assert/strict');
function hostData(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  const array = Array.isArray(value) && proto?.constructor?.name === 'Array';
  const plain = Object.prototype.toString.call(value) === '[object Object]' &&
    (proto === null || proto?.constructor?.name === 'Object');
  if (!array && !plain) return value;
  if (seen.has(value)) return seen.get(value);
  const copy = array ? new Array(value.length) : proto === null ? Object.create(null) : {};
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, key)) {
      Object.defineProperty(copy, key, {value:hostData(value[key], seen), enumerable:true, writable:true, configurable:true});
    }
  }
  return copy;
}
const assert = Object.assign((...args) => strict(...args), strict);
assert.deepStrictEqual = (actual, expected, ...rest) => strict.deepStrictEqual(hostData(actual), hostData(expected), ...rest);
assert.notDeepStrictEqual = (actual, expected, ...rest) => strict.notDeepStrictEqual(hostData(actual), hostData(expected), ...rest);
assert.deepEqual = assert.deepStrictEqual;
assert.notDeepEqual = assert.notDeepStrictEqual;
module.exports = assert;
`;
