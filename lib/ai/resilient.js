const {createClient, safeError, AIError} = require('./client');

// One total deadline across retries and fallback models; never retry invalid credentials.
function createResilientClient(config, dependencies = {}) {
  const factory = dependencies.createClient || createClient;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = dependencies.now || Date.now;
  const warn = dependencies.warn || console.warn;
  const models = [...new Set([config.model, ...(config.fallbackModels || '').split(',').map(s=>s.trim()).filter(Boolean)])].slice(0, 3);
  const retryable = error => ['service','quota','timeout','connection'].includes(error.code);
  return {async generateContent(input) {
    const deadline = now() + config.timeout;
    let last;
    for (let index=0; index<models.length; index++) {
      for (let attempt=0; attempt<2; attempt++) {
        const remaining = deadline - now();
        if (remaining <= 0) throw last || new AIError('timeout','AI request timed out.');
        const slots = (models.length-index)*2-attempt;
        const client = factory({...config,model:models[index],timeout:Math.max(1,Math.floor(remaining/slots))});
        try {
          const result = await client.generateContent(input);
          if (index > 0) warn(`AI fallback model used: ${models[index]}`);
          return result;
        } catch (error) {
          last = safeError(error);
          if (!retryable(last)) throw last;
          if (attempt === 0 && deadline-now()>1000) {
            const delay = Math.min(5000 + Math.floor(Math.random()*1000), Math.floor((deadline-now())/4));
            warn(`AI temporarily unavailable; retrying after ${delay}ms.`);
            await sleep(delay);
          }
        }
      }
    }
    throw last;
  }};
}
module.exports = {createResilientClient};
