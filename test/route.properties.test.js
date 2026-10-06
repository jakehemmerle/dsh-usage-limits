import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { assertReport, expectedHeadline } from './support/contract.js';
import {
  mountHost, makeClock, okReplies, reply, serve, signedInRecords, windowsOf,
  NOW0, HOUR, MINUTE, ANTHROPIC_KEY, CODEX_KEY, PROVIDER_IDS,
} from './support/host.js';
import { anthropicBody, codexBody, upstreamExchange, tokenString, windowSeconds } from './support/arbitraries.js';

const RUNS = { numRuns: 150 };

function cycle(exchanges) {
  return (_request, index) => serve(exchanges[index % exchanges.length]);
}

test('totality: any upstream status and body yields 200 JSON satisfying the contract, on every call', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(upstreamExchange(anthropicBody), { minLength: 1, maxLength: 3 }),
    fc.array(upstreamExchange(codexBody), { minLength: 1, maxLength: 3 }),
    fc.integer({ min: 1, max: 3 }),
    async (anthropic, codex, rounds) => {
      const host = mountHost({ upstream: { anthropic: cycle(anthropic), 'openai-codex': cycle(codex) } });
      for (let round = 0; round < rounds; round += 1) {
        const response = await host.get();
        assert.equal(response.status, 200);
        assert.match(response.contentType, /^application\/json/);
        assertReport(response.body);
        host.clock.advance(2 * HOUR);
      }
    },
  ), RUNS);
});

test('totality: a credential store that throws or holds junk still yields a contract report', async () => {
  const junk = fc.oneof(fc.constant(undefined), fc.jsonValue(), fc.record({ kind: fc.constant('grant'), payload: fc.jsonValue() }));
  await fc.assert(fc.asyncProperty(junk, junk, fc.boolean(), async (anthropic, codex, throws) => {
    const records = { [ANTHROPIC_KEY]: anthropic, [CODEX_KEY]: codex };
    if (throws) Object.defineProperty(records, ANTHROPIC_KEY, { get() { throw new Error('keychain locked'); } });
    const host = mountHost({ records });
    const response = await host.get();
    assert.equal(response.status, 200);
    assertReport(response.body);
  }), RUNS);
});

test('bounds: windows carry integer percents in [0, 100], unique ids, and non-empty labels', async () => {
  await fc.assert(fc.asyncProperty(anthropicBody, codexBody, async (anthropic, codex) => {
    const host = mountHost({
      upstream: {
        anthropic: () => reply(200, JSON.stringify(anthropic)),
        'openai-codex': () => reply(200, JSON.stringify(codex)),
      },
    });
    const { body } = await host.get();
    assertReport(body);
    for (const provider of PROVIDER_IDS) {
      const windows = windowsOf(body, provider);
      for (const window of windows) {
        assert.ok(Number.isInteger(window.percent) && window.percent >= 0 && window.percent <= 100);
        assert.ok(window.label.trim().length > 0);
      }
      assert.equal(new Set(windows.map((w) => w.id)).size, windows.length);
    }
  }), RUNS);
});

test('a 200 after good data either reports at least one window from that body or keeps the previous windows as stale', async () => {
  const later = (shaped) => fc.oneof(
    fc.constantFrom('{"rate_limit":"garbage"}', '{"limits":[{"kind":"session_v2"}]}', '{"limits":[]}', '{}', '[]', 'null'),
    shaped.map((v) => JSON.stringify(v)),
    fc.json(),
  );
  await fc.assert(fc.asyncProperty(later(anthropicBody), later(codexBody), async (anthropic, codex) => {
    const good = okReplies();
    const next = { anthropic, 'openai-codex': codex };
    const upstream = Object.fromEntries(PROVIDER_IDS.map((provider) => [
      provider,
      (request, index) => (index === 0 ? good[provider](request) : reply(200, next[provider])),
    ]));
    const host = mountHost({ upstream });
    const before = (await host.get()).body;
    host.clock.advance(5 * MINUTE);
    const { body } = await host.get();
    assertReport(body);
    body.providers.forEach((entry, i) => {
      assert.equal(host.calls[entry.provider].length, 2);
      if (entry.status === 'ok') {
        assert.ok(entry.windows.length > 0, `${entry.provider}: ok with no windows`);
        assert.equal(entry.fetchedAt, body.generatedAt);
      } else {
        assert.equal(entry.status, 'stale', `${entry.provider}: ${entry.status}`);
        assert.deepEqual(entry.windows, before.providers[i].windows);
        assert.equal(entry.fetchedAt, before.providers[i].fetchedAt);
      }
    });
  }), RUNS);
});

test('bounds: Anthropic fractional utilization (non-integer <= 1) reads as a fraction of 100', async () => {
  await fc.assert(fc.asyncProperty(fc.double({ min: 0.001, max: 0.999, noNaN: true }), async (fraction) => {
    const body = { five_hour: { utilization: fraction, resets_at: new Date(NOW0 + HOUR).toISOString() } };
    const host = mountHost({ upstream: { anthropic: () => reply(200, JSON.stringify(body)), 'openai-codex': () => reply(200, '{}') } });
    const [window] = windowsOf((await host.get()).body, 'anthropic');
    assert.equal(window.percent, Math.round(fraction * 100));
  }), RUNS);
});

const validCodexWindow = fc.record({
  used_percent: fc.integer({ min: 0, max: 100 }),
  limit_window_seconds: windowSeconds,
  reset_at: fc.integer({ min: 1, max: 14 * 24 }).map((h) => Math.floor((NOW0 + h * HOUR) / 1000)),
});

function codexOnly(rateLimit) {
  return mountHost({ upstream: { anthropic: () => reply(200, '{}'), 'openai-codex': () => reply(200, JSON.stringify({ rate_limit: rateLimit })) } });
}

test('codex labels depend only on window length: swapping primary and secondary keeps the (label, percent) set', async () => {
  const pairs = (report) => windowsOf(report, 'openai-codex').map((w) => `${w.label}|${w.percent}`).sort();
  await fc.assert(fc.asyncProperty(validCodexWindow, fc.oneof(validCodexWindow, fc.constant(null)), async (first, second) => {
    const forward = (await codexOnly({ primary_window: first, secondary_window: second }).get()).body;
    const swapped = (await codexOnly({ primary_window: second, secondary_window: first }).get()).body;
    assert.equal(windowsOf(forward, 'openai-codex').length, second === null ? 1 : 2);
    assert.deepEqual(pairs(forward), pairs(swapped));
  }), RUNS);
});

test('codex labels are a function of window length alone', async () => {
  await fc.assert(fc.asyncProperty(validCodexWindow, validCodexWindow, fc.boolean(), async (a, b, asSecondary) => {
    const sameLength = { ...b, limit_window_seconds: a.limit_window_seconds };
    const place = (w) => (asSecondary ? { primary_window: null, secondary_window: w } : { primary_window: w, secondary_window: null });
    const [left] = windowsOf((await codexOnly({ primary_window: a, secondary_window: null }).get()).body, 'openai-codex');
    const [right] = windowsOf((await codexOnly(place(sameLength)).get()).body, 'openai-codex');
    assert.equal(left.label, right.label);
  }), RUNS);
});

test('codex labels: 18000 s is "5-hour", 604800 s is "Weekly", whichever slot carries them', async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), async (weeklyFirst, fivePercent, weeklyPercent) => {
    const five = { used_percent: fivePercent, limit_window_seconds: 18000, reset_at: Math.floor(NOW0 / 1000) + 3600 };
    const weekly = { used_percent: weeklyPercent, limit_window_seconds: 604800, reset_at: Math.floor(NOW0 / 1000) + 86400 };
    const host = codexOnly(weeklyFirst ? { primary_window: weekly, secondary_window: five } : { primary_window: five, secondary_window: weekly });
    const windows = windowsOf((await host.get()).body, 'openai-codex');
    assert.deepEqual(
      windows.map((w) => [w.label, w.percent]).sort(),
      [['5-hour', fivePercent], ['Weekly', weeklyPercent]].sort(),
    );
  }), RUNS);
});

test('headline: the max-percent ok/stale window, earlier provider then earlier window on ties, null when none', async () => {
  const scenario = fc.constantFrom('fresh', 'anthropic-stale', 'codex-signed-out', 'both-signed-out', 'both-error');
  await fc.assert(fc.asyncProperty(anthropicBody, codexBody, scenario, async (anthropic, codex, kind) => {
    const records = signedInRecords();
    if (kind === 'codex-signed-out' || kind === 'both-signed-out') delete records[CODEX_KEY];
    if (kind === 'both-signed-out') delete records[ANTHROPIC_KEY];
    const host = mountHost({
      records,
      upstream: {
        anthropic: (_r, i) => (kind === 'both-error' || (kind === 'anthropic-stale' && i > 0) ? reply(503, 'no') : reply(200, JSON.stringify(anthropic))),
        'openai-codex': () => (kind === 'both-error' ? reply(500, 'no') : reply(200, JSON.stringify(codex))),
      },
    });
    let { body } = await host.get();
    if (kind === 'anthropic-stale') {
      const first = body.providers[0].status;
      host.clock.advance(10 * MINUTE);
      ({ body } = await host.get());
      assert.equal(body.providers[0].status, first === 'ok' ? 'stale' : 'error');
    }
    assertReport(body);
    assert.deepEqual(body.headline, expectedHeadline(body));
    if (kind === 'both-signed-out' || kind === 'both-error') assert.equal(body.headline, null);
  }), RUNS);
});

test('headline: equal percents everywhere pick the first Claude window', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 100 }), async (percent) => {
    const later = new Date(NOW0 + 2 * HOUR).toISOString();
    const anthropic = { limits: [
      { kind: 'session', percent, resets_at: later },
      { kind: 'weekly_all', percent, resets_at: later },
    ] };
    const codex = { rate_limit: { primary_window: { used_percent: percent, limit_window_seconds: 18000, reset_at: Math.floor(NOW0 / 1000) + 3600 } } };
    const host = mountHost({ upstream: { anthropic: () => reply(200, JSON.stringify(anthropic)), 'openai-codex': () => reply(200, JSON.stringify(codex)) } });
    const { body } = await host.get();
    assert.equal(body.headline.provider, 'anthropic');
    assert.equal(body.headline.label, windowsOf(body, 'anthropic')[0].label);
    assert.equal(body.headline.percent, percent);
  }), RUNS);
});

test('expired windows: a reset time at or before report time reports 0 / normal / null', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: -3 * HOUR, max: 3 * HOUR }),
    fc.integer({ min: 0, max: 100 }),
    fc.integer({ min: -3 * 3600, max: 3 * 3600 }),
    fc.integer({ min: 0, max: 4 * HOUR }),
    async (claudePercent, claudeOffsetMs, codexPercent, codexOffsetS, later) => {
      const claudeReset = NOW0 + claudeOffsetMs;
      const codexReset = (Math.floor(NOW0 / 1000) + codexOffsetS) * 1000;
      const host = mountHost({
        upstream: {
          anthropic: () => reply(200, JSON.stringify({ limits: [{ kind: 'session', percent: claudePercent, resets_at: new Date(claudeReset).toISOString() }] })),
          'openai-codex': () => reply(200, JSON.stringify({ rate_limit: { primary_window: { used_percent: codexPercent, limit_window_seconds: 18000, reset_at: codexReset / 1000 } } })),
        },
      });
      await host.get();
      host.clock.advance(later);
      const { body } = await host.get();
      for (const [provider, reset, percent] of [['anthropic', claudeReset, claudePercent], ['openai-codex', codexReset, codexPercent]]) {
        const [window] = windowsOf(body, provider);
        if (reset <= body.generatedAt) {
          assert.deepEqual([window.percent, window.severity, window.resetsAt], [0, 'normal', null]);
        } else {
          assert.deepEqual([window.percent, window.resetsAt], [percent, reset]);
        }
      }
    },
  ), RUNS);
});

test('secrecy: no access or refresh token ever appears in the response or the console, even when upstream echoes it', async () => {
  const logged = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[level] = console[level];
    console[level] = (...args) => { logged.push(args.map(String).join(' ')); };
  }
  try {
    await fc.assert(fc.asyncProperty(
      tokenString, tokenString, tokenString, tokenString,
      fc.constantFrom(200, 200, 401, 429, 500),
      fc.boolean(),
      async (anthropicAccess, anthropicRefresh, codexAccess, codexRefresh, status, expired) => {
        const tokens = { anthropicAccess, anthropicRefresh, codexAccess, codexRefresh };
        const secrets = Object.values(tokens);
        const records = signedInRecords(NOW0, tokens);
        const echo = (request) => {
          const header = request.headers.get('authorization') ?? '';
          const bearer = header.replace(/^Bearer /, '');
          const body = {
            plan_type: bearer,
            error: header,
            limits: [{ kind: 'weekly_scoped', percent: 50, resets_at: new Date(NOW0 + HOUR).toISOString(), scope: { model: { display_name: `${bearer} ${secrets.join(' ')}` } } }],
            rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor(NOW0 / 1000) + 60 } },
            additional_rate_limits: [{ limit_name: secrets.join('/'), rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: Math.floor(NOW0 / 1000) + 60 } } }],
          };
          return reply(status, JSON.stringify(body));
        };
        const host = mountHost({ records, upstream: { anthropic: echo, 'openai-codex': echo } });
        await host.get();
        if (expired) {
          records[ANTHROPIC_KEY].payload.expires = NOW0;
          records[CODEX_KEY].payload.expires = NOW0;
        }
        host.clock.advance(HOUR);
        const response = await host.get();
        for (const secret of secrets) {
          assert.ok(!response.text.includes(secret), 'token leaked into the response');
          assert.ok(!logged.some((line) => line.includes(secret)), 'token leaked into the console');
        }
        assertReport(response.body);
      },
    ), RUNS);
  } finally {
    Object.assign(console, originals);
  }
});

test('expired credential: upstream is never called and the provider reports stale or error', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 30 * 24 * HOUR }),
    fc.boolean(),
    fc.array(fc.integer({ min: 0, max: 2 * HOUR }), { minLength: 1, maxLength: 4 }),
    async (expiredAgo, hadGoodData, advances) => {
      const clock = makeClock();
      const records = signedInRecords();
      const host = mountHost({ records, clock });
      if (hadGoodData) await host.get();
      const before = { anthropic: host.calls.anthropic.length, 'openai-codex': host.calls['openai-codex'].length };
      for (const advance of advances) {
        clock.advance(advance);
        for (const key of [ANTHROPIC_KEY, CODEX_KEY]) records[key].payload.expires = clock.now() - expiredAgo;
        const { body } = await host.get(advance % 2 === 0 ? '?refresh=1' : '');
        assertReport(body);
        for (const entry of body.providers) {
          assert.equal(entry.status, hadGoodData ? 'stale' : 'error');
          assert.match(entry.reason, /next model request/i);
        }
      }
      assert.equal(host.calls.anthropic.length, before.anthropic);
      assert.equal(host.calls['openai-codex'].length, before['openai-codex']);
    },
  ), RUNS);
});

test('signed out: no credential record, or a non-OAuth record, reports signed-out without calling upstream', async () => {
  const records = { [CODEX_KEY]: { kind: 'api-key', key: 'sk-not-a-subscription-000000' } };
  const host = mountHost({ records });
  const { body } = await host.get();
  assertReport(body);
  assert.deepEqual(body.providers.map((p) => p.status), ['signed-out', 'signed-out']);
  assert.equal(body.headline, null);
  assert.equal(host.calls.anthropic.length + host.calls['openai-codex'].length, 0);
});

test('a hung upstream times out into an error instead of hanging the route', async () => {
  const host = mountHost({
    timeoutMs: 20,
    upstream: {
      anthropic: (request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason))),
      'openai-codex': () => new Promise(() => {}),
    },
  });
  const { body } = await host.get();
  assertReport(body);
  assert.deepEqual(body.providers.map((p) => p.status), ['error', 'error']);
  assert.match(body.providers[0].reason, /timed out/i);
});

test('route registration: GET /api/usage-limits, buffered, owned by the plugin context', () => {
  const host = mountHost();
  assert.equal(host.routes.length, 1);
  assert.equal(host.route.path, '/api/usage-limits');
  assert.deepEqual([...host.route.methods], ['GET']);
  assert.equal(host.route.requestBody, 'buffered');
  assert.deepEqual([...host.plugin.inject].sort(), ['connection', 'credentials']);
});

test('upstream requests carry exactly the verified headers', async () => {
  const host = mountHost();
  await host.get();
  const [claude] = host.calls.anthropic;
  const [codex] = host.calls['openai-codex'];
  assert.equal(claude.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(claude.headers.authorization, 'Bearer sk-ant-oat01-anthropic-access-token-0000');
  assert.equal(claude.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(codex.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(codex.headers.authorization, 'Bearer eyJcodex-access-token-0000000000');
  assert.equal(codex.headers['chatgpt-account-id'], '00000000-0000-4000-8000-000000000000');
  assert.equal(codex.headers['user-agent'], 'codex-cli');
});
