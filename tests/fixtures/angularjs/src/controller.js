angular.module('fixture').controller('FixtureController', function (MathService) {
  this.message = 'Absolute value: ' + MathService.abs(-7);
});
