/** Pure projection from provider machine states to the UsageReport contract (v2, SPEC.md). */
import { FIVE_HOURS, SEVEN_DAYS } from './normalize.js';

export const EXPIRED_REASON = 'Sign-in token expired; DSH refreshes it on the next model request';

/** omp's thresholds: critical from 80%, warning from 50%. */
export function severityOf(percent) {
  if (percent >= 80) return 'critical';
  if (percent >= 50) return 'warning';
  return 'normal';
}

/** `5h` / `7d` for a shared window of that span (a line window), else null. */
export function shortOf(window) {
  if (window.scoped === true) return null;
  if (window.span === FIVE_HOURS) return '5h';
  if (window.span === SEVEN_DAYS) return '7d';
  return null;
}

function finalizeWindow(window, now) {
  const span = Number.isInteger(window.span) && window.span > 0 ? window.span : null;
  const common = { id: window.id, label: window.label, span, short: shortOf({ ...window, span }) };
  if (window.resetsAt !== null && window.resetsAt <= now) {
    return { ...common, percent: 0, resetsAt: null, severity: 'normal' };
  }
  return { ...common, percent: window.percent, resetsAt: window.resetsAt, severity: severityOf(window.percent) };
}

/**
 * @param provider - `{ id, name }`.
 * @param state - the provider's machine state.
 * @param credential - this request's credential classification.
 * @param now - report time.
 */
/** Only the first shared 5h and the first shared 7d window of an account are its line windows. */
function markLineWindows(windows) {
  const seen = new Set();
  return windows.map((window) => {
    if (window.short === null) return window;
    if (seen.has(window.short)) return { ...window, short: null };
    seen.add(window.short);
    return window;
  });
}

export function projectProvider(provider, state, credential, now) {
  const head = { provider: provider.id, name: provider.name };
  if (credential.kind === 'absent') return { ...head, status: 'signed-out' };
  const override = credential.kind === 'expired' ? EXPIRED_REASON : credential.kind === 'unusable' ? credential.reason : null;
  const reason = override ?? state.reason;
  const good = state.lastGood;
  if (good === null) return { ...head, status: 'error', reason: reason ?? 'No usage data yet' };
  const data = {
    plan: good.plan,
    windows: markLineWindows(good.windows.map((window) => finalizeWindow(window, now))),
    fetchedAt: good.fetchedAt,
  };
  return reason === null ? { ...head, status: 'ok', ...data } : { ...head, status: 'stale', reason, ...data };
}

function fullest(providers, accept) {
  let best = null;
  for (const entry of providers) {
    if (entry.status !== 'ok' && entry.status !== 'stale') continue;
    for (const window of entry.windows) {
      if (!accept(window)) continue;
      if (best === null || window.percent > best.percent) {
        best = { provider: entry.provider, name: entry.name, label: window.label, short: window.short, percent: window.percent, severity: window.severity };
      }
    }
  }
  return best;
}

/** The fullest 5h/7d window (ties: earlier account, then earlier window); else the fullest window. */
export function headlineOf(providers) {
  return fullest(providers, (window) => window.short !== null) ?? fullest(providers, () => true);
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
