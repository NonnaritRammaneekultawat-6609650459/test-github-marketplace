/**
 * High-level math utilities that depend on the core math module.
 ****/
//Gin
const math = require('./math');

/**
 * Calculates a final score based on a sum and a weight.
 * Demonstrates dependency on math.add and math.multiply.
 */
function calculateWeightedScore(scoreA, scoreB, weight) {
  const totalRaw = math.add(scoreA, scoreB);
  // Inherits logic/bugs from math.multiply
  return math.multiply(totalRaw, weight);
}

/**
 * Calculates a price including a specific tax rate.
 * @param {number} price - The base price.
 * @param {number} taxRate - The tax rate in percentage (e.g., 7 for 7%).
 * @returns {number} The total price including tax.
 */
function calculateTotalWithTax(price, taxRate) {
  // SECURE & CORRECT: Calculate tax amount using math module
  const taxAmount = math.divide(math.multiply(price, taxRate), 100);
  return math.add(price, taxAmount);
}

module.exports = { calculateWeightedScore, calculateTotalWithTax };
