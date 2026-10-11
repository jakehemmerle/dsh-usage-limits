// U13 (SPEC.md): a window's displayed percent is the payload's percentage rounded to the nearest
// integer and clamped to 0–100, for every payload shape. Anthropic's legacy `utilization` field is a
// percentage like `percent` (ProviderProxy's recorded payload carries `five_hour.utilization: 8`
// beside `limits[].percent: 8`), so 0.9 means 0.9 %, never 90 %.
//
// The oracle is written from the spec, not from lib/normalize.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fc, fcOpts } from './support/fc.js';
import { normalizeAnthropic, normalizeCodex } from '../lib/normalize.js';

/** Spec oracle: nearest integer (halves up), clamped. */
function expectedPercent(value) {
  const nearest = Math.floor(value + 0.5);
  return Math.min(100, Math.max(0, nearest));
}

const percentValue = fc.oneof(
  fc.double({ min: -10, max: 110, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.integer({ min: 0, max: 100 }),
  fc.constantFrom(0, 0.4, 0.5, 0.9, 1, 1.0, 1.5, 49.5, 99.6, 100),
);

const legacyKeys = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];
const NOW = Date.parse('2026-10-11T16:00:00Z');

function percentsOf(result) {
  assert.equal(result.ok, true);
  return result.usage.windows.map((w) => w.percent);
}

test('U13: Anthropic legacy utilization is a percentage on every legacy key', () => {
  fc.assert(fc.property(fc.constantFrom(...legacyKeys), percentValue, (key, value) => {
    const [percent] = percentsOf(normalizeAnthropic({ [key]: { utilization: value, resets_at: null } }));
    assert.equal(percent, expectedPercent(value), `${key}.utilization ${value}`);
  }), fcOpts('U13 legacy utilization'));
});

test('U13: limits[].percent, legacy utilization and Codex used_percent agree for the same value', () => {
  fc.assert(fc.property(percentValue, (value) => {
    const limits = percentsOf(normalizeAnthropic({ limits: [{ kind: 'session', percent: value }] }));
    const legacy = percentsOf(normalizeAnthropic({ five_hour: { utilization: value } }));
    const codex = percentsOf(normalizeCodex({ rate_limit: { primary_window: { used_percent: value, limit_window_seconds: 18000 } } }, NOW));
    assert.deepEqual([limits[0], legacy[0], codex[0]], Array(3).fill(expectedPercent(value)), `value ${value}`);
  }), fcOpts('U13 shapes agree'));
});

test('U13: the displayed percent never decreases as utilization grows', () => {
  fc.assert(fc.property(percentValue, percentValue, (a, b) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const [pLo] = percentsOf(normalizeAnthropic({ five_hour: { utilization: lo } }));
    const [pHi] = percentsOf(normalizeAnthropic({ five_hour: { utilization: hi } }));
    assert.ok(pLo <= pHi, `utilization ${lo} -> ${pLo}% but ${hi} -> ${pHi}%`);
  }), fcOpts('U13 monotone'));
});

test('U13 examples: 0.9 → 1 %, 1.0 → 1 %, 0.4 → 0 %, 52 → 52 %', () => {
  const at = (u) => percentsOf(normalizeAnthropic({ five_hour: { utilization: u } }))[0];
  assert.deepEqual([at(0.9), at(1.0), at(0.4), at(52)], [1, 1, 0, 52]);
});
