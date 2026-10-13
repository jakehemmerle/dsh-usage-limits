import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fc, fcOpts } from './support/fc.js';
import { initialState, reduce, AUTH_RETRY_MS, MAX_BACKOFF_MS } from '../lib/machine.js';
import { assertReport } from './support/contract.js';
import { mountHost, makeClock, serve, fixture, signedInRecords, MINUTE, HOUR, PROVIDER_IDS } from './support/host.js';

const RUNS = fcOpts('throttle gates through the route', { cost: 6, floor: 150 });
const FLOOR_MS = 60_000;

const outcomeKind = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ kind: 'ok' }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('transient'), status: fc.constantFrom(429, 500, 502, 503, 504) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('transient'), status: fc.constant(429), retryAfter: fc.integer({ min: 0, max: 2 * 3600 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('auth'), status: fc.constantFrom(401, 403) }) },
  { weight: 1, arbitrary: fc.constantFrom({ kind: 'malformed' }, { kind: 'throw' }, { kind: 'not-found' }) },
);

function exchangeFor(provider, outcome) {
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'response', status: 200, body: fixture(provider === 'anthropic' ? 'anthropic-oauth-usage.json' : 'codex-wham-usage.json') };
    case 'transient':
    case 'auth':
      return { kind: 'response', status: outcome.status, body: '{}', retryAfter: outcome.retryAfter === undefined ? undefined : String(outcome.retryAfter) };
    case 'malformed':
      return { kind: 'response', status: 200, body: '{"limits": [' };
    case 'not-found':
      return { kind: 'response', status: 404, body: 'nope' };
    default:
      return { kind: 'throw' };
  }
}

/** The earliest moment the brief allows the next upstream call after `calls[i]`, as a lower bound. */
function earliestNext(call, transientStreak, minInterval) {
  let earliest = call.at + minInterval;
  if (call.outcome.kind === 'transient') {
    const delay = call.outcome.retryAfter !== undefined
      ? Math.min(call.outcome.retryAfter * 1000, MAX_BACKOFF_MS)
      : Math.min(minInterval * 2 ** transientStreak, MAX_BACKOFF_MS);
    earliest = Math.max(earliest, call.at + delay);
  }
  if (call.outcome.kind === 'auth') earliest = Math.max(earliest, call.at + AUTH_RETRY_MS);
  return earliest;
}

test('throttle through the route: upstream calls per provider never exceed the minInterval buckets touched, and never fire during a backoff', async () => {
  const step = fc.record({
    advance: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 10 * MINUTE }), fc.integer({ min: 0, max: 2 * HOUR })),
    burst: fc.integer({ min: 1, max: 4 }),
    refresh: fc.boolean(),
  });
  await fc.assert(fc.asyncProperty(
    fc.oneof(fc.constant(undefined), fc.integer({ min: 0, max: 20 * MINUTE })),
    fc.array(step, { minLength: 1, maxLength: 20 }),
    fc.array(outcomeKind, { minLength: 1, maxLength: 6 }),
    fc.array(outcomeKind, { minLength: 1, maxLength: 6 }),
    async (configured, steps, anthropicOutcomes, codexOutcomes) => {
      const minInterval = configured === undefined ? 300_000 : Math.max(FLOOR_MS, configured);
      const outcomes = { anthropic: anthropicOutcomes, 'openai-codex': codexOutcomes };
      const clock = makeClock();
      const upstream = Object.fromEntries(PROVIDER_IDS.map((provider) => [
        provider,
        (_request, index) => serve(exchangeFor(provider, outcomes[provider][index % outcomes[provider].length])),
      ]));
      const host = mountHost({ clock, upstream, config: configured === undefined ? {} : { minIntervalMs: configured } });
      const requestTimes = [];
      for (const { advance, burst, refresh } of steps) {
        clock.advance(advance);
        requestTimes.push(clock.now());
        const responses = await Promise.all(Array.from({ length: burst }, () => host.get(refresh ? '?refresh=1' : '')));
        for (const response of responses) assertReport(response.body);
      }
      const buckets = new Set(requestTimes.map((t) => Math.floor(t / minInterval))).size;
      for (const provider of PROVIDER_IDS) {
        const calls = host.calls[provider].map((call, i) => ({ at: call.at, outcome: outcomes[provider][i % outcomes[provider].length] }));
        assert.ok(calls.length <= buckets, `${provider}: ${calls.length} upstream calls over ${buckets} buckets`);
        let streak = 0;
        for (let i = 1; i < calls.length; i += 1) {
          streak = calls[i - 1].outcome.kind === 'transient' ? streak + 1 : 0;
          const earliest = earliestNext(calls[i - 1], streak, minInterval);
          assert.ok(calls[i].at >= earliest, `${provider}: call ${i} at +${calls[i].at - calls[i - 1].at}ms, allowed from +${earliest - calls[i - 1].at}ms after ${JSON.stringify(calls[i - 1].outcome)}`);
        }
      }
    },
  ), RUNS);
});

test('a concurrent burst shares one in-flight upstream fetch per provider', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 12 }), async (burst) => {
    const host = mountHost();
    const responses = await Promise.all(Array.from({ length: burst }, () => host.get('?refresh=1')));
    assert.equal(host.calls.anthropic.length, 1);
    assert.equal(host.calls['openai-codex'].length, 1);
    for (const response of responses) assert.deepEqual(response.body, responses[0].body);
  }), fcOpts('concurrent burst shares one in-flight upstream fetch', { cost: 50, floor: 30 }));
});

test('a configured minIntervalMs below the floor is raised to 60 s', async () => {
  const clock = makeClock();
  const host = mountHost({ clock, config: { minIntervalMs: 1000 } });
  await host.get();
  clock.advance(FLOOR_MS - 1);
  await host.get('?refresh=1');
  assert.equal(host.calls.anthropic.length, 1);
  clock.advance(1);
  await host.get('?refresh=1');
  assert.equal(host.calls.anthropic.length, 2);
});

test('auth-blocked lifts as soon as the credential record changes, without waiting 30 minutes', async () => {
  const clock = makeClock();
  const records = signedInRecords();
  let status = 401;
  const host = mountHost({
    clock,
    records,
    upstream: {
      anthropic: () => serve({ kind: 'response', status, body: fixture('anthropic-oauth-usage.json') }),
      'openai-codex': () => serve({ kind: 'response', status: 200, body: fixture('codex-wham-usage.json') }),
    },
  });
  assert.equal((await host.get()).body.providers[0].status, 'error');
  clock.advance(10 * MINUTE);
  await host.get();
  assert.equal(host.calls.anthropic.length, 1);
  records['llm-pi-ai/anthropic'].payload.access = 'sk-ant-oat01-rotated-access-token-1111';
  records['llm-pi-ai/anthropic'].payload.expires += HOUR;
  status = 200;
  const { body } = await host.get();
  assert.equal(host.calls.anthropic.length, 2);
  assert.equal(body.providers[0].status, 'ok');
});

const usable = (fingerprint) => ({ kind: 'usable', fingerprint });

const machineEvent = fc.oneof(
  { weight: 4, arbitrary: fc.record({ type: fc.constant('request'), advance: fc.integer({ min: 0, max: 40 * MINUTE }), credential: fc.oneof({ weight: 5, arbitrary: fc.constantFrom('a', 'b').map(usable) }, { weight: 1, arbitrary: fc.constantFrom({ kind: 'expired' }, { kind: 'absent' }) }) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant('response'),
      advance: fc.integer({ min: 0, max: 15_000 }),
      outcome: fc.oneof(
        fc.constant({ kind: 'ok', usage: { plan: null, windows: [] } }),
        fc.record({ kind: fc.constant('http'), status: fc.constantFrom(429, 500, 503, 401, 403, 404), retryAfterMs: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 3 * HOUR })) }),
        fc.constant({ kind: 'failed', reason: 'unexpected response shape' }),
      ),
    }),
  },
);

/** Independent model of the gate: when, per the brief, the reducer must (and may only) start a fetch. */
function modelGate() {
  const m = { fetching: false, lastAttempt: null, until: -Infinity, authFingerprint: null, authUntil: -Infinity, streak: 0, attemptFingerprint: null };
  return {
    request(now, credential, minInterval) {
      if (credential.kind !== 'usable' || m.fetching) return false;
      if (m.lastAttempt !== null && now < m.lastAttempt + minInterval) return false;
      if (now < m.until) return false;
      if (m.authFingerprint !== null && credential.fingerprint === m.authFingerprint && now < m.authUntil) return false;
      m.fetching = true;
      m.lastAttempt = now;
      m.attemptFingerprint = credential.fingerprint;
      return true;
    },
    respond(now, outcome, minInterval) {
      if (!m.fetching) return;
      m.fetching = false;
      m.until = -Infinity;
      m.authFingerprint = null;
      if (outcome.kind === 'ok') {
        m.streak = 0;
      } else if (outcome.kind === 'http' && (outcome.status === 401 || outcome.status === 403)) {
        m.streak = 0;
        m.authFingerprint = m.attemptFingerprint;
        m.authUntil = now + AUTH_RETRY_MS;
      } else {
        m.streak += 1;
        const honored = outcome.kind === 'http' && outcome.status === 429 || outcome.kind === 'http' && outcome.status >= 500;
        const delay = honored && outcome.retryAfterMs !== null
          ? Math.min(outcome.retryAfterMs, MAX_BACKOFF_MS)
          : Math.min(minInterval * 2 ** m.streak, MAX_BACKOFF_MS);
        m.until = now + delay;
      }
    },
  };
}

const phasesSeen = new Set();

test('reducer: a fetch starts exactly when the throttle, backoff, and auth gates allow it', () => {
  fc.assert(fc.property(
    fc.integer({ min: FLOOR_MS, max: 20 * MINUTE }),
    fc.array(machineEvent, { minLength: 1, maxLength: 60 }),
    (minInterval, events) => {
      const model = modelGate();
      let state = initialState();
      let now = 1_000_000;
      phasesSeen.add(state.phase);
      for (const event of events) {
        now += event.advance;
        if (event.type === 'request') {
          const result = reduce(state, { type: 'request', now, credential: event.credential }, { minIntervalMs: minInterval });
          assert.equal(result.fetch, model.request(now, event.credential, minInterval), `request at ${now} in ${state.phase}`);
          if (!result.fetch) assert.equal(result.state.phase, state.phase);
          state = result.state;
        } else {
          const result = reduce(state, { type: 'response', now, outcome: event.outcome }, { minIntervalMs: minInterval });
          assert.equal(result.fetch, false);
          if (state.phase !== 'fetching') assert.equal(result.state, state, 'a response with nothing in flight is ignored');
          model.respond(now, event.outcome, minInterval);
          state = result.state;
        }
        phasesSeen.add(state.phase);
      }
    },
  ), fcOpts('reducer model: gates stay honest', { cost: 1, floor: 400 }));
  assert.deepEqual([...phasesSeen].sort(), ['auth-blocked', 'backoff', 'fetching', 'idle', 'ok']);
});

test('reducer: consecutive transient failures double the delay from minInterval up to one hour', () => {
  fc.assert(fc.property(fc.integer({ min: FLOOR_MS, max: 20 * MINUTE }), fc.integer({ min: 1, max: 10 }), (minInterval, failures) => {
    const policy = { minIntervalMs: minInterval };
    let state = initialState();
    let now = 0;
    for (let n = 1; n <= failures; n += 1) {
      const started = reduce(state, { type: 'request', now, credential: usable('a') }, policy);
      assert.equal(started.fetch, true);
      state = reduce(started.state, { type: 'response', now, outcome: { kind: 'http', status: 503, retryAfterMs: null } }, policy).state;
      const delay = Math.min(minInterval * 2 ** n, MAX_BACKOFF_MS);
      assert.equal(state.phase, 'backoff');
      assert.equal(reduce(state, { type: 'request', now: now + delay - 1, credential: usable('a') }, policy).fetch, false);
      now += delay;
    }
  }));
});
