angular.module('fixture', []).factory('MathService', function () {
  return { abs: function (n) { if (n < 0) return -n; return n; } };
});
