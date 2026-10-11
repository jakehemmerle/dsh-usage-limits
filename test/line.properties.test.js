// U1, U2, U3, U6, U7 at the pure layer: lib/line.js against the independent oracle.
// The real-client and host-runtime suites check the same properties on rendered output.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { renderLine } from '../lib/line.js';
import { expectedLine } from './oracle/line.mjs';
import { NUM_RUNS, T0, entriesArb, oracleAccounts, v2Report } from './support/v2.js';

const MIN = 60_000;
const seed = process.env.SEED === undefined ? undefined : Number(process.env.SEED);
const opts = { numRuns: NUM_RUNS, seed, verbose: 1 };

function plain(result) {
  return result === null ? null : result.segments.map((s) => s.text).join('');
}

test('U1/U3/U6: the dst line equals the spec line for every report, time and width', () => {
  fc.assert(fc.property(entriesArb(T0), fc.integer({ min: 0, max: 30 * MIN }), fc.integer({ min: -2, max: 320 }), (entries, later, width) => {
    const report = v2Report(entries, T0);
    const now = T0 + later;
    const want = expectedLine(oracleAccounts(entries), now, width);
    const got = renderLine(report, { now, width });
    assert.equal(plain(got), want === null ? null : want.text);
    if (want !== null) {
      assert.equal(got.text, want.text);
      assert.equal(got.tier, want.tier);
    }
  }), opts);
});

test('U2: every bar/percent carries its severity colour; nothing else is coloured', () => {
  fc.assert(fc.property(entriesArb(T0), fc.integer({ min: 20, max: 320 }), (entries, width) => {
    const want = expectedLine(oracleAccounts(entries), T0, width);
    const got = renderLine(v2Report(entries, T0), { now: T0, width });
    if (want === null) return;
    const coloured = got.segments.filter((s) => ['normal', 'warning', 'critical'].includes(s.style));
    assert.deepEqual(coloured.map((s) => ({ text: s.text, severity: s.style })), want.cells);
  }), opts);
});

test('U7: the line never exceeds W cells, and is never cut when W >= 20', () => {
  fc.assert(fc.property(entriesArb(T0), fc.integer({ min: -5, max: 320 }), (entries, width) => {
    const got = renderLine(v2Report(entries, T0), { now: T0, width });
    if (got === null) return;
    assert.ok([...got.text].length <= Math.max(0, width), `${got.text} > ${width}`);
    if (width >= 20) assert.ok(got.tier <= 5, `cut at width ${width}`);
  }), opts);
});

test('example: the line Jake saw in omp on October 10 (local Claude and Codex)', () => {
  const now = T0;
  const entries = [
    { id: 'anthropic', status: 'ok', windows: [
      { span: 18000, scoped: false, percent: 52, resetsAt: now + 51 * MIN + 30_000 },
      { span: 604800, scoped: false, percent: 80, resetsAt: now + (2 * 24 + 12) * 60 * MIN + 30_000 },
      { span: 604800, scoped: true, name: 'Fable', percent: 3, resetsAt: now + 3 * 86400_000 },
    ] },
    { id: 'openai-codex', status: 'ok', windows: [
      { span: 604800, scoped: false, percent: 28, resetsAt: now + (3 * 24 + 2) * 60 * MIN + 30_000 },
    ] },
  ];
  const got = renderLine(v2Report(entries, now), { now, width: 200 });
  assert.equal(got.text, 'Claude 5h ████░░░░ 52% ↻51m 7d ██████░░ 80% ↻2d12h   Codex 7d ██░░░░░░ 28% ↻3d2h');
  assert.equal(got.tier, 0);
});

test('example: no data, signed out or errors only → hidden', () => {
  const report = v2Report([{ id: 'anthropic', status: 'error', windows: [] }, { id: 'providerproxy/anthropic', status: 'signed-out', windows: [] }], T0);
  assert.equal(renderLine(report, { now: T0, width: 200 }), null);
  assert.equal(renderLine({ generatedAt: T0, providers: [] }, { now: T0, width: 200 }), null);
});

test('example: a scoped-only or spanless account is not on the line', () => {
  const report = v2Report([{ id: 'openai-codex', status: 'ok', windows: [
    { span: 604800, scoped: true, name: 'codex-spark', percent: 99, resetsAt: null },
    { span: 86400, scoped: false, percent: 90, resetsAt: null },
  ] }], T0);
  assert.equal(renderLine(report, { now: T0, width: 200 }), null);
});
