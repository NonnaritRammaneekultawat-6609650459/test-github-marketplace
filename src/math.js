/********
 * Basic math utility functions.
 **********/

/**
 * Validates that all provided arguments are numbers and finite.
 * @param {...*} args
 * @throws {TypeError|Error}
 */
function validateNumbers(...args) {
  for (const arg of args) {
    if (typeof arg !== 'number' || Number.isNaN(arg)) {
      throw new TypeError("Inputs must be valid numbers");
    }
    if (!Number.isFinite(arg)) {
      throw new TypeError("Inputs must be finite numbers");
    }
  }
}

// Math utilities for quality gate system test
function add(a, b) {
  validateNumbers(a, b);
  const result = a + b;
  return Object.is(result, -0) ? 0 : result;
}

function subtract(a, b) {
  validateNumbers(a, b);
  const result = a - b;
  return Object.is(result, -0) ? 0 : result;
}

function multiply(a, b) {
  validateNumbers(a, b);
  const result = a * b;
  // Normalize -0 to 0
  return Object.is(result, -0) ? 0 : result;
}

function divide(a, b) {
  validateNumbers(a, b);
  if (b === 0) {
    throw new Error("Cannot divide by zero");
  }
  const result = a / b;
  // Normalize -0 to 0
  return Object.is(result, -0) ? 0 : result;
}

/**
 * Calculates the percentage of a value relative to a total.
 * @param {number} value
 * @param {number} total
 * @returns {number}
 */
function calculatePercentage(value, total) {
  validateNumbers(value, total);
  if (total === 0) {
    return 0;
  }
  const result = (value / total) * 100;
  // Normalize -0 to 0
  return Object.is(result, -0) ? 0 : result;
}

function modulo(a, b) {
  validateNumbers(a, b);
  if (b === 0) {
    throw new Error("Cannot modulo by zero");
  }
  // Mathematical modulo: ((a % b) + b) % b
  const result = ((a % b) + b) % b;
  // Normalize -0 to 0
  return Object.is(result, -0) ? 0 : result;
}

module.exports = { add, subtract, multiply, divide, calculatePercentage, modulo };
// Trigger AI scan
