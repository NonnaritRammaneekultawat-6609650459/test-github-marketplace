const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const {GoogleGenerativeAI} = require('@google/generative-ai');

const MAX_BYTES = 2 * 1024 * 1024;
class AIError extends Error {
  constructor(code, message, status) {
    super(message); this.name = 'AIError'; this.code = code; this.status = status;
  }
}

function failure(status) {
  if (status === 401) return new AIError('authentication', 'AI API key is invalid or expired (401).', status);
  if (status === 403) return new AIError('permission', 'AI account cannot access this service or model (403).', status);
  if (status === 404) return new AIError('not_found', 'AI model or API URL was not found (404).', status);
  if (status === 429) return new AIError('quota', 'AI quota or rate limit exceeded (429).', status);
  if (status >= 500) return new AIError('service', 'AI service is temporarily unavailable (503).', status);
  return new AIError('unsupported', 'AI request was rejected; check the model and API format.', status);
}

// Never include provider response bodies, URLs or credentials in diagnostics.
function safeError(error) {
  if (error instanceof AIError) return error;
  if (['AbortError', 'TimeoutError'].includes(error?.name) || error?.code === 'ABORT_ERR') {
    return new AIError('timeout', 'AI request timed out.');
  }
  if (Number.isInteger(error?.status)) return failure(error.status);
  return new AIError('connection', 'AI connection failed; check API URL and network availability.');
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new AIError('configuration', 'Enter a valid HTTPS Chat Completions API URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\r\n]/.test(value)) {
    throw new AIError('configuration', 'AI API URL must use HTTPS without credentials, query parameters or fragments.');
  }
  return url;
}

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
  ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24],
  ['224.0.0.0',4], ['240.0.0.0',4]
]) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::',23], ['2001:db8::',32], ['2002::',16]]) blocked.addSubnet(address,prefix,'ipv6');
function publicAddress(address) {
  const family = net.isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') :
    family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, {all:true}, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) {
      return callback(new AIError('configuration', 'AI API URL must resolve only to public internet addresses.'));
    }
    // Pin the connection to these validated DNS results, avoiding a second lookup.
    if (options?.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

function postJson(url, body, key, timeout, requestImpl = https.request) {
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && !publicAddress(literal)) {
    return Promise.reject(new AIError('configuration', 'AI API URL must use a public internet address.'));
  }
  return new Promise((resolve, reject) => {
    const request = requestImpl(url, {
      method:'POST', lookup:publicLookup, signal:AbortSignal.timeout(timeout),
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${key}`}
    }, response => {
      // Redirects are deliberately never followed with credentials.
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy(); reject(failure(response.statusCode)); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          response.destroy(); reject(new AIError('response', 'AI response exceeded the size limit.'));
        } else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new AIError('response', 'AI service returned an unsupported response format.')); }
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function createClient({provider = 'gemini', apiKey, model, apiUrl, timeout = 60000}, dependencies = {}) {
  let native;
  return {async generateContent(input) {
    try {
      if (!['gemini', 'openai-compatible'].includes(provider)) throw new AIError('configuration', 'Unsupported AI API format.');
      if (!apiKey) throw new AIError('configuration', 'AI API key is not configured.');
      if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) {
        throw new AIError('configuration', 'AI model name is required and must not contain control characters.');
      }
      if (provider === 'gemini') {
        native ||= new (dependencies.GoogleGenerativeAI || GoogleGenerativeAI)(apiKey).getGenerativeModel({model}, {timeout});
        const result = await native.generateContent(input);
        const text = (await result.response).text();
        if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_BYTES) throw new AIError('response', 'AI returned empty or oversized text.');
        return {response:{text:() => text.replaceAll(apiKey, '[REDACTED]')}};
      }
      const url = endpoint(apiUrl);
      const prompt = typeof input === 'string' ? input : input.contents?.flatMap(c => c.parts || []).map(p => p.text || '').join('\n');
      if (!prompt || Buffer.byteLength(prompt) > MAX_BYTES) throw new AIError('request', 'AI prompt is empty or exceeds the size limit.');
      // Keep the request minimal; model-specific optional parameters reduce compatibility.
      const data = await (dependencies.postJson || postJson)(url, {model, messages:[{role:'user', content:prompt}]}, apiKey, timeout);
      const choice = data?.choices?.[0];
      const text = choice?.message?.content;
      if (choice?.finish_reason === 'length') throw new AIError('response', 'AI response was truncated; select a model with sufficient output capacity.');
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_BYTES) throw new AIError('response', 'AI returned no usable text; this model or API format may be unsupported.');
      return {response:{text:() => text.replaceAll(apiKey, '[REDACTED]')}};
    } catch (error) { throw safeError(error); }
  }};
}

module.exports = {createClient, AIError, safeError, endpoint, publicAddress, publicLookup, postJson};
