// dst half inside dsh-TUI's real status runtime, rendered by dsh-TUI's ink into xterm.
// Properties: U1/U3 (line text), U2 (cell colours), U4 (stale/recovery), U5 (no fetch from
// rendering/ticks/resizes; per-account intervals), U7 (width), U10 (unload).
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { bootTui, fakeUpstream, fakeIntervals, makeClock, PROXY, UPSTREAM, PROXY_KEY, TOKENS, KEY, cordis } from './support/tui-host.js';
import { ACCOUNTS, grant } from './e2e/support/scenario.mjs';
import { expectedLine, COLOUR } from './oracle/line.mjs';
import { T0, windowArb } from './support/v2.js';

const RUNS = Number(process.env.HOST_RUNS ?? 150);
const seed = process.env.SEED === undefined ? undefined : Number(process.env.SEED);
const POLL = 60_000;
const TICK = 30_000;

function config(extra = {}) {
  return { minIntervalMs: 300_000, proxy: { baseURL: PROXY, apiKeyEnv: 'PROVIDERPROXY_API_KEY' }, testing: { upstream: UPSTREAM }, ...extra };
}

function recordsFor(locals, now) {
  return Object.fromEntries(locals.map((id) => {
    const account = ACCOUNTS.find((a) => a.id === id);
    return [account.recordKey, grant(id, { access: TOKENS[id], expires: now + 8 * 3600_000 })];
  }));
}

const scenarioArb = fc.record({
  proxyKey: fc.boolean(),
  locals: fc.subarray(['anthropic', 'openai-codex']),
  responses: fc.record(Object.fromEntries(ACCOUNTS.map((a) => [a.id, fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant('ok'), windows: fc.array(windowArb(T0), { maxLength: 4 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('status'), status: fc.constantFrom(401, 429, 500, 503) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant('malformed'), body: fc.constantFrom('<html>', '{}', '{"limits":[]}', 'null') }) },
  )]))),
  cols: fc.integer({ min: 24, max: 220 }),
});

/** What the spec says is shown after the first load of a scenario. */
function shownAfterLoad(s) {
  return ACCOUNTS.flatMap((account) => {
    const configured = account.proxy ? s.proxyKey : s.locals.includes(account.id);
    const r = s.responses[account.id];
    if (!configured || r.kind !== 'ok') return [];
    return [{ ...account, stale: false, windows: representable(account, r.windows) }];
  });
}

function representable(account, windows) {
  if (account.family === 'codex') return [...windows.filter((w) => !w.scoped).slice(0, 2), ...windows.filter((w) => w.scoped)];
  return windows.filter((w) => w.scoped || w.span === 18000 || w.span === 604800);
}

/** Severity-coloured runs; a space never breaks a run (ink skips unchanged blank cells, so their colour is unobservable). */
function colouredRuns(cells) {
  const runs = [];
  let current = null;
  for (const c of cells) {
    if (c.ch === ' ' && current) { current.text += ' '; continue; }
    if (c.fg !== null && Object.values(COLOUR).includes(c.fg)) {
      if (current && current.fg === c.fg) current.text += c.ch;
      else { current = { text: c.ch, fg: c.fg }; runs.push(current); }
    } else current = null;
  }
  return runs.map((r) => ({ ...r, text: r.text.trim() }));
}

test('harness: a probe view registered through the real host renders in the frame with its colour', async () => {
  const probe = await import('./e2e/support/probe-status.mjs');
  const clock = makeClock(T0);
  const host = await bootTui({ config: config(), records: {}, clock, upstream: fakeUpstream(clock), intervals: fakeIntervals(), env: {},
    before: async (root) => { await root.plugin(probe, { text: 'PROBE 52%' }); } });
  try {
    await host.until(() => host.line().join('').includes('PROBE 52%'));
    assert.deepEqual(colouredRuns(host.cells(0)), [{ text: 'PROBE 52%', fg: 130 }]);
  } finally {
    await host.unload();
    await host.unmount();
  }
});

test('U1/U2/U3/U7: after the first load the rendered line equals the spec line, with severity colours', async () => {
  await fc.assert(fc.asyncProperty(scenarioArb, async (s) => {
    const clock = makeClock(T0);
    const upstream = fakeUpstream(clock);
    for (const [account, r] of Object.entries(s.responses)) upstream.set(account, r);
    const intervals = fakeIntervals();
    const host = await bootTui({
      config: config(), records: recordsFor(s.locals, T0), cols: s.cols, clock, upstream, intervals,
      env: s.proxyKey ? { PROVIDERPROXY_API_KEY: PROXY_KEY } : {},
    });
    try {
      // No PageMargin in this harness: the view gets the whole width (in dst, W = columns - page margin).
      const want = expectedLine(shownAfterLoad(s), clock.now(), s.cols);
      await host.until(() => (want === null ? true : host.line().join('').trim() === want.text));
      await host.quiet();
      const rows = host.line();
      if (want === null) {
        assert.equal(rows.join('').trim(), '', 'hidden');
        return;
      }
      assert.equal(rows.length, 1, 'one row');
      assert.equal(rows[0].trim(), want.text);
      assert.ok([...rows[0].trimEnd()].length <= s.cols, 'within W');
      assert.deepEqual(colouredRuns(host.cells(0)), want.cells.map((c) => ({ text: c.text, fg: COLOUR[c.severity] })));
    } finally {
      await host.unload();
      await host.unmount();
    }
  }), { numRuns: RUNS, seed, verbose: 1 });
});

test('U3: the line is hidden before the first data and never shows a placeholder 0%', async () => {
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetch = upstream.fetch;
  upstream.fetch = async (...args) => { await gate; return fetch(...args); };
  upstream.set('providerproxy/anthropic', { kind: 'ok', windows: [{ span: 18000, scoped: false, percent: 12, resetsAt: T0 + 3600_000 }] });
  const host = await bootTui({ config: config(), records: {}, clock, upstream, intervals: fakeIntervals() });
  try {
    await host.quiet();
    assert.equal(host.line().join('').trim(), '');
    assert.deepEqual(host.viewKeys(), [KEY]);
    release();
    await host.until(() => host.line().join('').includes('Claude (proxy) 5h'));
  } finally {
    await host.unload();
    await host.unmount();
  }
});

test('U5: rendering, 30 s ticks and resizes cause no request; proxy every 60 s, sign-ins every 5 min', async () => {
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  for (const account of ACCOUNTS) upstream.set(account.id, { kind: 'ok', windows: [{ span: 604800, scoped: false, percent: 40, resetsAt: T0 + 86400_000 }] });
  const intervals = fakeIntervals();
  const host = await bootTui({ config: config(), records: recordsFor(['anthropic', 'openai-codex'], T0), clock, upstream, intervals });
  try {
    await host.until(() => host.line().join('').includes('Codex 7d'));
    assert.deepEqual(intervals.periods(), [TICK, POLL]);
    const counts = () => ACCOUNTS.map((a) => upstream.callsFor(a.id).length);
    assert.deepEqual(counts(), [1, 1, 1, 1]);
    for (let i = 0; i < 10; i += 1) {
      intervals.fire(TICK);
      host.resize(80 + i * 10);
      await host.quiet();
    }
    assert.deepEqual(counts(), [1, 1, 1, 1], 'ticks and resizes fetch nothing');
    clock.advance(59_000);
    intervals.fire(POLL);
    await host.quiet();
    assert.deepEqual(counts(), [1, 1, 1, 1], 'nothing before 60 s');
    clock.advance(2_000);
    intervals.fire(POLL);
    await host.quiet();
    assert.deepEqual(counts(), [2, 2, 1, 1], 'proxy again after 60 s, sign-ins wait 5 min');
    clock.advance(5 * 60_000);
    intervals.fire(POLL);
    await host.quiet();
    assert.deepEqual(counts(), [3, 3, 2, 2]);
    // Every interval has elapsed: a countdown tick still must not request (only the poll may).
    clock.advance(10 * 60_000);
    intervals.fire(TICK);
    await host.quiet();
    assert.deepEqual(counts(), [3, 3, 2, 2], 'a tick redraws without a request even when every throttle is open');
    intervals.fire(POLL);
    await host.quiet();
    assert.deepEqual(counts(), [4, 4, 3, 3]);
  } finally {
    await host.unload();
    await host.unmount();
  }
});

test('U4/U6: a failure keeps the data and marks it stale; success clears it; countdowns tick without requests', async () => {
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  const windows = [{ span: 18000, scoped: false, percent: 55, resetsAt: T0 + 90 * 60_000 }];
  upstream.set('providerproxy/anthropic', { kind: 'ok', windows });
  const intervals = fakeIntervals();
  const host = await bootTui({ config: config(), records: {}, clock, upstream, intervals, cols: 120 });
  try {
    await host.until(() => host.line().join('').trim() === 'Claude (proxy) 5h ████░░░░ 55% ↻1h30m');
    clock.advance(61_000);
    upstream.set('providerproxy/anthropic', { kind: 'malformed', body: '<html>' });
    intervals.fire(POLL);
    await host.until(() => host.line().join('').trim() === 'Claude (proxy) 5h ████░░░░ 55% ↻1h28m stale');
    clock.advance(30_000);
    intervals.fire(TICK);
    await host.until(() => host.line().join('').trim() === 'Claude (proxy) 5h ████░░░░ 55% ↻1h28m stale');
    clock.advance(31_000);
    intervals.fire(TICK);
    await host.until(() => host.line().join('').trim() === 'Claude (proxy) 5h ████░░░░ 55% ↻1h27m stale');
    const before = upstream.callsFor('providerproxy/anthropic').length;
    clock.advance(10 * 60_000);
    upstream.set('providerproxy/anthropic', { kind: 'ok', windows: [{ span: 18000, scoped: false, percent: 81, resetsAt: T0 + 300 * 60_000 }] });
    intervals.fire(POLL);
    await host.until(() => host.line().join('').trim() === 'Claude (proxy) 5h ██████░░ 81% ↻4h47m');
    // Ticks fetched nothing; the poll fetched this account exactly once.
    assert.equal(upstream.callsFor('providerproxy/anthropic').length, before + 1);
  } finally {
    await host.unload();
    await host.unmount();
  }
});

test('U6: a window whose reset passes shows 0% without a countdown until new data', async () => {
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  upstream.set('providerproxy/openai-codex', { kind: 'ok', windows: [{ span: 604800, scoped: false, percent: 90, resetsAt: T0 + 45_000 }] });
  const intervals = fakeIntervals();
  const host = await bootTui({ config: config(), records: {}, clock, upstream, intervals, cols: 120 });
  try {
    await host.until(() => host.line().join('').trim() === 'Codex (proxy) 7d ███████░ 90% ↻0m');
    clock.advance(46_000);
    intervals.fire(TICK);
    await host.until(() => host.line().join('').trim() === 'Codex (proxy) 7d ░░░░░░░░ 0%');
  } finally {
    await host.unload();
    await host.unmount();
  }
});

test('U10: unloading removes the view, clears every interval and stops requests', async () => {
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  upstream.set('providerproxy/anthropic', { kind: 'ok', windows: [{ span: 18000, scoped: false, percent: 5, resetsAt: null }] });
  const intervals = fakeIntervals();
  const host = await bootTui({ config: config(), records: {}, clock, upstream, intervals });
  try {
    await host.until(() => host.line().join('').includes('Claude (proxy)'));
    await host.unload();
    await host.quiet();
    assert.deepEqual(host.viewKeys(), []);
    assert.equal(host.line().join('').trim(), '');
    assert.equal(intervals.size, 0, 'no live intervals');
    const before = upstream.calls.length;
    clock.advance(3600_000);
    intervals.fire(POLL);
    await host.quiet();
    assert.equal(upstream.calls.length, before);
  } finally {
    await host.unmount();
  }
});

test('U8: tokens and the proxy key never reach the screen, even when echoed in payload names', async () => {
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  upstream.set('providerproxy/anthropic', { kind: 'ok', windows: [
    { span: 604800, scoped: true, name: PROXY_KEY, percent: 99, resetsAt: null },
    { span: 18000, scoped: false, percent: 5, resetsAt: null },
  ] });
  const host = await bootTui({ config: config(), records: {}, clock, upstream, intervals: fakeIntervals(), cols: 300 });
  try {
    await host.until(() => host.line().join('').includes('Claude (proxy)'));
    assert.ok(!host.line().join('').includes(PROXY_KEY));
    for (const call of upstream.calls) assert.equal(call.authorization, `Bearer ${PROXY_KEY}`);
  } finally {
    await host.unload();
    await host.unmount();
  }
});

test('fallback: when registerView is refused the line still appears as plain status text', async () => {
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  upstream.set('providerproxy/anthropic', { kind: 'ok', windows: [{ span: 18000, scoped: false, percent: 64, resetsAt: null }] });
  // Another plugin uses the whole six-row view budget first.
  const hog = {
    name: 'hog', inject: ['tuiStatus'],
    apply(ctx) {
      const component = () => null;
      ctx.tuiStatus.registerView({ key: 'hog-a', maxRows: 3, component });
      ctx.tuiStatus.registerView({ key: 'hog-b', maxRows: 3, component });
    },
  };
  const host = await bootTui({ config: config(), records: {}, clock, upstream, intervals: fakeIntervals(), before: async (root) => { await root.plugin(hog); } });
  try {
    await host.until(() => host.textEntries().some((e) => e.key === KEY && e.text === 'Claude (proxy) 5h █████░░░ 64%'));
  } finally {
    await host.unload();
    await host.unmount();
  }
});

test('contract: the plugin needs only tuiStatus; credentials are optional', async () => {
  const { inject, name } = await import('../tui.js');
  assert.deepEqual([...inject], ['tuiStatus']);
  assert.equal(typeof name, 'string');
  const clock = makeClock(T0);
  const upstream = fakeUpstream(clock);
  upstream.set('providerproxy/openai-codex', { kind: 'ok', windows: [{ span: 604800, scoped: false, percent: 12, resetsAt: null }] });
  const host = await bootTui({ config: config(), records: null, clock, upstream, intervals: fakeIntervals() });
  try {
    await host.until(() => host.line().join('').trim() === 'Codex (proxy) 7d █░░░░░░░ 12%');
    assert.ok(upstream.calls.every((c) => c.account.startsWith('providerproxy/')));
  } finally {
    await host.unload();
    await host.unmount();
  }
  assert.ok(cordis.Context);
});
