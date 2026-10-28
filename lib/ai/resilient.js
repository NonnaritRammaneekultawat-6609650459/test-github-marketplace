const {createClient, safeError} = require('./client');

// Retry the selected model only; no deadline or model/provider switching.
function createResilientClient(config, dependencies = {}) {
  const factory = dependencies.createClient || createClient;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const random = dependencies.random || Math.random;
  const warn = dependencies.warn || console.warn;
  const {provider, apiKey, model, apiUrl} = config;
  const client = factory({provider, apiKey, model, apiUrl});
  return {async generateContent(input) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await client.generateContent(input); }
      catch (error) {
        const diagnostic = safeError(error);
        if (attempt === 1 || !(diagnostic.status === 429 || diagnostic.status >= 500)) throw diagnostic;
        const delay = 1000 + Math.floor(random() * 1000);
        warn(`AI temporarily unavailable; retrying the selected model after ${delay}ms (attempt 2/2).`);
        await sleep(delay);
      }
    }
  }};
}
module.exports = {createResilientClient};
