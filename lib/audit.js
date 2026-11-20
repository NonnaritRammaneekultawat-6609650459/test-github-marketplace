const levels = ['info', 'low', 'moderate', 'high', 'critical'];
const packageName = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

function validateExceptions(config) {
  if (!config || !Array.isArray(config.decisions) || config.decisions.length > 500) throw new Error('audit-resolve.json must contain a decisions array (maximum 500).');
  for (const d of config.decisions) {
    // A package-name decision waives every current and future advisory for that package.
    if (typeof d === 'string') {
      if (!packageName.test(d)) throw new Error('Each package-name decision must contain a valid npm package name.');
      continue;
    }
    if (!d || typeof d.package !== 'string' || !packageName.test(d.package) ||
        !Number.isSafeInteger(d.id) || d.id <= 0 || typeof d.reason !== 'string' || !d.reason.trim() || d.reason.length > 1000 ||
        typeof d.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.expires) ||
        !Number.isFinite(Date.parse(d.expires)) || new Date(d.expires).toISOString().slice(0,10) !== d.expires) {
      throw new Error('Each audit decision must be a package name or include package, numeric advisory id, reason and a valid expires date (YYYY-MM-DD).');
    }
  }
  return config.decisions;
}

function evaluateAudit(data, config = {decisions: []}, today = new Date().toISOString().slice(0,10)) {
  const result = {critical:0, high:0, moderate:0, low:0, isSecure:null, status:'error', details:[], ignored:[], warnings:[]};
  try {
    const decisions = validateExceptions(config);
    if (data?.error || !data?.vulnerabilities || typeof data.vulnerabilities !== 'object' || Array.isArray(data.vulnerabilities)) throw new Error('npm audit returned no valid vulnerability report.');
    const entries = data.vulnerabilities;
    // npm reports transitive vulnerabilities as package-name references. Resolve
    // all causes; an unknown or cyclic cause must never be silently accepted.
    function causes(name, seen = new Set()) {
      if (seen.has(name)) return null;
      const v = entries[name];
      if (!v || !Array.isArray(v.via) || !v.via.length) return null;
      const next = new Set([...seen, name]);
      const all = [];
      for (const via of v.via) {
        if (typeof via === 'string') {
          const nested = causes(via, next);
          if (!nested) return null;
          all.push(...nested);
        } else if (via && Number.isSafeInteger(via.source) && levels.includes(via.severity)) all.push(via);
        else return null;
      }
      return all;
    }
    for (const d of decisions) {
      if (typeof d !== 'string' && d.expires < today) result.warnings.push(`Expired exception: ${d.package} #${d.id} (${d.expires})`);
    }
    for (const [name,v] of Object.entries(entries)) {
      if (!v || v.name !== name || !levels.includes(v.severity)) throw new Error('Invalid vulnerability entry from npm audit.');
      if (decisions.includes(name)) {
        result.ignored.push(`${name} (all advisories waived by package-name decision)`);
        continue;
      }
      const all = causes(name);
      const remaining = all?.filter(a => {
        const d = decisions.find(d => typeof d !== 'string' && d.package === name && d.id === a.source && d.expires >= today);
        if (!d) return true;
        const line = `${name} #${a.source} (${a.severity}) - ${d.reason}; expires ${d.expires}`;
        if (!result.ignored.includes(line)) result.ignored.push(line);
        return false;
      });
      if (remaining && remaining.length === 0) continue;
      // Retain npm's package severity for unresolved causes (conservative).
      if (v.severity !== 'info') result[v.severity]++;
      result.details.push(`${name} (${v.severity})`);
    }
    result.status = 'complete';
    result.isSecure = result.high === 0 && result.critical === 0;
  } catch (error) { result.error = error.message; }
  return result;
}
module.exports = {evaluateAudit, validateExceptions};
