/*
*****/
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
require('dotenv').config();

// Secrets are handled via process.env and not exported
const DB_PASSWORD = process.env.DB_PASSWORD || "default_safe_placeholder";
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY || "default_safe_placeholder";

function processInputInsecurely(userInput) {
  // Safer alternative to eval() for simple JSON-like input
  try {
    return JSON.parse(userInput);
  } catch (e) {
    // If not JSON, return as is or handle appropriately
    return userInput;
  }
}

function runDiagnostic(command) {
  console.log("Running diagnostic...");
  // SECURE: Use execFileSync with arguments to prevent shell injection
  return execFileSync('echo', [`Result: ${command}`]).toString();
}

function generateToken() {
  // SECURE: Use cryptographically strong random values
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { processInputInsecurely, runDiagnostic, generateToken };