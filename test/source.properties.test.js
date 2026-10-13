// Source-level concurrency properties (usage-b3): the behaviors TESTING.md attributed to this
// file, which had never been committed. The oracle is SPEC.md's timing and failure behaviour,
// applied through the public source facade and asserted independently of lib/ internals:
//
//   - a hung upstream fetch times out (deps.timeoutMs) without hanging report(); the account
//     reports the failed reason with no fake 0% (U4/U3);
//   - the failure enters backoff, so an immediate retry starts no upstream request (U5);
//   - the abandoned exchange resolving LATE never replaces data - neither the failure report
//     before a newer refresh, nor good data a newer refresh already applied (U4, omp's
//     "discards a timed-out report after a newer refresh applies", inverted to the plugin's
//     own semantics: a late exchange is discarded, never re-dispatched);
//   - once the backoff window elapses, the next report starts exactly one upstream fetch and,
//     on success, restores the account to ok with the fresh data (U4's "later success clears
//     it" and the recovery half of the omp row).
//
// Fresh fixture for every generated case; timeouts are real timers (25 ms), so every case takes
// one timeout's worth of wall clock; the fetch scripts keep requests deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fc, fcOpts } from './support/fc.js';
import { createUsageSource } from '../lib/source.js';
import { accountsOf } from '../lib/accounts.js';

const NOW = Date.parse('2026-10-06T15:00:00Z');
const MIN_INTERVAL_MS = 300; // config minIntervalMs; the testing floor (125) stays below it
const TIMEOUT_MS = 25;       // deps.timeoutMs overrides every account's own timeout in tests
const BACKOFF_MS = MIN_INTERVAL_MS * 2; // the machine doubles minIntervalMs on the first failure

/** Anthropic-shaped payload: one shared 5h window (limit percent p) and one weekly 7d (-10). */
function anthropicBody(percent) {
  const iso = new Date(NOW + 14 * 86400_000).toISOString();
  return {
    limits: [
      { kind: 'session', percent, resets_at: iso },
      { kind: 'weekly_all', percent: Math.max(0, percent - 10), resets_at: iso },
    ],
  };
}

const okResponse = (body) => ({ ok: true, text: async () => JSON.stringify(body), headers: new Headers() });
const entry = (report) => report.providers[0];

function fixture() {
  const account = accountsOf({
    minIntervalMs: MIN_INTERVAL_MS,
    testing: {
      floorMs: 125,
      upstream: {
        anthropic: 'https://upstream.test.invalid/api/oauth/usage',
        'openai-codex': 'https://upstream.test.invalid/backend-api/wham/usage',
      },
    },
  }).find((a) => a.id === 'anthropic');
  if (account === undefined) throw new Error('anthropic account missing');

  let now = NOW;
  let calls = 0;
  const script = [];
  const held = [];

  const src = createUsageSource([account], {
    fetch: async (_url, { signal }) => {
      if (signal !== undefined && signal.aborted) throw new Error('aborted before send');
      const step = script[calls];
      calls += 1;
      if (step === undefined) throw new Error('fetch script exhausted at call ' + calls);
      if (step.kind === 'ok') return okResponse(step.body);
      return new Promise((resolve) => { held.push(resolve); });
    },
    now: () => now,
    env: () => ({}),
    readRecord: async () => ({
      kind: 'grant',
      payload: { type: 'oauth', access: 'access-token-0000', refresh: 'refresh-token-0000', expires: NOW + 30 * 86400_000 },
    }),
    timeoutMs: TIMEOUT_MS,
  });

  return {
    src,
    get calls() { return calls; },
    queue: (step) => script.push(step),
    resolveHeld: (index, body) => {
      const resolve = held[index];
      if (resolve === undefined) throw new Error('no held call ' + index);
      resolve(okResponse(body));
    },
    flush: () => new Promise((r) => setImmediate(r)),
    advance: (delta) => { now += delta; },
  };
}

test('a hung fetch times out without hanging report(); an immediate retry starts nothing; a late resolution never replaces anything', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 100 }),
    async (latePercent) => {
      const fx = fixture();
      fx.queue({ kind: 'hang' });
      const r1 = await fx.src.report();
      assert.equal(entry(r1).status, 'error');
      assert.match(entry(r1).reason, /timed out/i);
      assert.equal(fx.calls, 1);

      const r2 = await fx.src.report();
      assert.equal(fx.calls, 1);
      assert.deepEqual(entry(r2), entry(r1));

      fx.resolveHeld(0, anthropicBody(latePercent));
      await fx.flush();
      const r3 = await fx.src.report();
      assert.equal(fx.calls, 1);
      assert.deepEqual(entry(r3), entry(r1));
    },
  ), fcOpts('source: timeout, backoff gate and late discard', { cost: 6, floor: 60 }));
});

test('after the backoff elapses one fetch restores ok; the timed-out exchange stays discarded even after a newer refresh applied', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: 0, max: 100 }),
    async (goodPercent, latePercent) => {
      const fx = fixture();
      fx.queue({ kind: 'hang' });
      const r1 = await fx.src.report();
      assert.equal(entry(r1).status, 'error');
      assert.match(entry(r1).reason, /timed out/i);

      fx.advance(BACKOFF_MS);
      fx.queue({ kind: 'ok', body: anthropicBody(goodPercent) });
      const r2 = await fx.src.report();
      assert.equal(fx.calls, 2);
      assert.equal(entry(r2).status, 'ok');
      assert.equal(entry(r2).reason, undefined);
      assert.equal(entry(r2).windows[0].percent, goodPercent);
      assert.equal(entry(r2).windows[1].percent, Math.max(0, goodPercent - 10));

      const r3 = await fx.src.report();
      assert.equal(fx.calls, 2);
      assert.deepEqual(entry(r3), entry(r2));

      fx.resolveHeld(0, anthropicBody(latePercent));
      await fx.flush();
      const r4 = await fx.src.report();
      assert.equal(fx.calls, 2);
      assert.deepEqual(entry(r4), entry(r2));
    },
  ), fcOpts('source: recovery after backoff and discard-after-newer', { cost: 6, floor: 60 }));
});
