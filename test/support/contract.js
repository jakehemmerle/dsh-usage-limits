import assert from 'node:assert/strict';

// UsageReport v2 (SPEC.md 0.2.0): severity 50/80, windows carry span and short, the headline is the
// fullest line window (fallback: fullest window), and ProviderProxy accounts come first.
const SEVERITIES = ['normal', 'warning', 'critical'];
const LOCAL = [
  { provider: 'anthropic', name: 'Claude' },
  { provider: 'openai-codex', name: 'Codex' },
];
const PROXY = [
  { provider: 'providerproxy/anthropic', name: 'Claude (proxy)' },
  { provider: 'providerproxy/openai-codex', name: 'Codex (proxy)' },
];

function assertKeys(value, keys, where) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${where}: keys`);
}

function isNullableEpoch(value) {
  return value === null || (Number.isFinite(value) && Number.isInteger(value));
}

export function severityOf(percent) {
  if (percent >= 80) return 'critical';
  if (percent >= 50) return 'warning';
  return 'normal';
}

export function assertWindow(window, where) {
  assertKeys(window, ['id', 'label', 'percent', 'resetsAt', 'severity', 'span', 'short'], where);
  assert.ok(window.span === null || (Number.isInteger(window.span) && window.span > 0), `${where}: span`);
  assert.ok(window.short === null || window.short === '5h' || window.short === '7d', `${where}: short`);
  if (window.short === '5h') assert.equal(window.span, 18000, `${where}: 5h span`);
  if (window.short === '7d') assert.equal(window.span, 604800, `${where}: 7d span`);
  assert.equal(typeof window.id, 'string', `${where}: id`);
  assert.ok(window.id.length > 0, `${where}: id non-empty`);
  assert.equal(typeof window.label, 'string', `${where}: label`);
  assert.ok(window.label.trim().length > 0, `${where}: label non-empty`);
  assert.ok(Number.isInteger(window.percent), `${where}: integer percent, got ${window.percent}`);
  assert.ok(window.percent >= 0 && window.percent <= 100, `${where}: percent in range, got ${window.percent}`);
  assert.ok(isNullableEpoch(window.resetsAt), `${where}: resetsAt`);
  assert.ok(SEVERITIES.includes(window.severity), `${where}: severity`);
  assert.equal(window.severity, severityOf(window.percent), `${where}: severity matches percent`);
}

export function assertProvider(entry, expected, where) {
  assert.equal(entry.provider, expected.provider, `${where}: provider`);
  assert.equal(entry.name, expected.name, `${where}: name`);
  switch (entry.status) {
    case 'ok':
      assertKeys(entry, ['provider', 'name', 'status', 'plan', 'windows', 'fetchedAt'], where);
      break;
    case 'stale':
      assertKeys(entry, ['provider', 'name', 'status', 'reason', 'plan', 'windows', 'fetchedAt'], where);
      assert.equal(typeof entry.reason, 'string', `${where}: reason`);
      assert.ok(entry.reason.length > 0, `${where}: reason non-empty`);
      break;
    case 'signed-out':
      assertKeys(entry, ['provider', 'name', 'status'], where);
      return;
    case 'error':
      assertKeys(entry, ['provider', 'name', 'status', 'reason'], where);
      assert.equal(typeof entry.reason, 'string', `${where}: reason`);
      assert.ok(entry.reason.length > 0, `${where}: reason non-empty`);
      return;
    default:
      assert.fail(`${where}: unknown status ${JSON.stringify(entry.status)}`);
  }
  assert.ok(entry.plan === null || typeof entry.plan === 'string', `${where}: plan`);
  assert.ok(Number.isInteger(entry.fetchedAt), `${where}: fetchedAt`);
  assert.ok(Array.isArray(entry.windows), `${where}: windows`);
  entry.windows.forEach((window, i) => assertWindow(window, `${where}.windows[${i}]`));
  for (const short of ['5h', '7d']) {
    assert.ok(entry.windows.filter((window) => window.short === short).length <= 1, `${where}: at most one ${short} line window`);
  }
  const ids = entry.windows.map((window) => window.id);
  assert.equal(new Set(ids).size, ids.length, `${where}: unique window ids ${JSON.stringify(ids)}`);
}

/** The fullest line window (5h/7d, shared) over ok/stale entries; else the fullest window of any kind. */
export function expectedHeadline(report) {
  const pick = (accept) => {
    let best = null;
    for (const entry of report.providers) {
      if (entry.status !== 'ok' && entry.status !== 'stale') continue;
      for (const window of entry.windows) {
        if (!accept(window)) continue;
        if (best === null || window.percent > best.percent) {
          best = {
            provider: entry.provider,
            name: entry.name,
            label: window.label,
            short: window.short,
            percent: window.percent,
            severity: window.severity,
          };
        }
      }
    }
    return best;
  };
  return pick((window) => window.short !== null) ?? pick(() => true);
}

/** `proxy`: whether the row configures ProviderProxy (its two accounts come first). */
export function assertReport(report, { proxy = false } = {}) {
  assert.equal(typeof report, 'object');
  assert.notEqual(report, null);
  assertKeys(report, ['generatedAt', 'providers', 'headline'], 'report');
  assert.ok(Number.isInteger(report.generatedAt), 'report.generatedAt');
  const expected = proxy ? [...PROXY, ...LOCAL] : LOCAL;
  assert.equal(report.providers.length, expected.length, 'every configured account, in order');
  report.providers.forEach((entry, i) => assertProvider(entry, expected[i], `providers[${i}]`));
  if (report.headline !== null) {
    assertKeys(report.headline, ['provider', 'name', 'label', 'short', 'percent', 'severity'], 'headline');
  }
  assert.deepEqual(report.headline, expectedHeadline(report), 'headline is the fullest line window');
}
