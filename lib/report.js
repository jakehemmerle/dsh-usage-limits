/** Pure projection from provider machine states to the UsageReport contract. */

export const EXPIRED_REASON = 'Sign-in token expired; DSH refreshes it on the next model request';

export function severityOf(percent) {
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warning';
  return 'normal';
}

function finalizeWindow(window, now) {
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return { id: window.id, label: window.label, percent: 0, resetsAt: null, severity: 'normal' };
  }
  return { id: window.id, label: window.label, percent: window.percent, resetsAt: window.resetsAt, severity: severityOf(window.percent) };
}

/**
 * @param provider - `{ id, name }`.
 * @param state - the provider's machine state.
 * @param credential - this request's credential classification.
 * @param now - report time.
 */
export function projectProvider(provider, state, credential, now) {
  const head = { provider: provider.id, name: provider.name };
  if (credential.kind === 'absent') return { ...head, status: 'signed-out' };
  const override = credential.kind === 'expired' ? EXPIRED_REASON : credential.kind === 'unusable' ? credential.reason : null;
  const reason = override ?? state.reason;
  const good = state.lastGood;
  if (good === null) return { ...head, status: 'error', reason: reason ?? 'No usage data yet' };
  const data = {
    plan: good.plan,
    windows: good.windows.map((window) => finalizeWindow(window, now)),
    fetchedAt: good.fetchedAt,
  };
  return reason === null ? { ...head, status: 'ok', ...data } : { ...head, status: 'stale', reason, ...data };
}

export function headlineOf(providers) {
  let best = null;
  for (const entry of providers) {
    if (entry.status !== 'ok' && entry.status !== 'stale') continue;
    for (const window of entry.windows) {
      if (best === null || window.percent > best.percent) {
        best = { provider: entry.provider, name: entry.name, label: window.label, percent: window.percent, severity: window.severity };
      }
    }
  }
  return best;
}

export function buildReport(providers, now) {
  return { generatedAt: now, providers, headline: headlineOf(providers) };
}

/**
 * Replace every occurrence of a secret inside any string of a JSON-shaped value.
 * Upstream text (plan names, limit names) reaches the report verbatim, so a
 * hostile or buggy upstream echoing the bearer token must not get it through.
 */
export function redact(value, secrets) {
  const ordered = [...secrets].filter((s) => typeof s === 'string' && s.length >= 8).sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return value;
  const walk = (node) => {
    if (typeof node === 'string') return ordered.reduce((text, secret) => text.split(secret).join('[redacted]'), node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [walk(k), walk(v)]));
    return node;
  };
  return walk(value);
}
