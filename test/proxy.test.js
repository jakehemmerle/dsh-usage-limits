import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../index.js';
import { fixture, makeClock, reply, HOUR, MINUTE } from './support/host.js';

const BASE = 'http://gpu.example:4000/v1';
const TOKEN = 'proxy-client-token-0000000000';

/** Mount with no DSH sign-ins, so every report row past the first two comes from the proxy. */
function mountProxy({ upstream, env = { PROVIDERPROXY_API_KEY: TOKEN }, config = { proxy: { baseURL: `${BASE}/` } } } = {}) {
  const clock = makeClock();
  const calls = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ url: request.url, headers: Object.fromEntries(request.headers) });
    return upstream(request);
  };
  let route;
  const plugin = createPlugin({ fetch, now: clock.now, env: () => env });
  plugin.apply({
    connection: { fetch: { register(entry) { route = entry; return async () => {}; } } },
    credentials: { async readRecord() { return undefined; } },
    effect() { return () => {}; },
  }, config);
  const get = async () => JSON.parse(await (await route.fetch(new Request('http://127.0.0.1:3080/api/usage-limits'))).text());
  return { get, calls, clock };
}

function byUrl(request) {
  if (request.url === `${BASE}/usage/claude`) return reply(200, fixture('anthropic-oauth-usage.json'));
  if (request.url === `${BASE}/usage/chatgpt`) return reply(200, fixture('codex-wham-usage.json'));
  throw new Error(`unexpected upstream ${request.url}`);
}

test('proxy: without config the report has only the DSH sign-ins', async () => {
  const host = mountProxy({ upstream: byUrl, config: {} });
  const report = await host.get();
  assert.deepEqual(report.providers.map((p) => p.provider), ['anthropic', 'openai-codex']);
  assert.equal(host.calls.length, 0);
});

test('proxy: reads both accounts through the proxy with only its bearer token', async () => {
  const host = mountProxy({ upstream: byUrl });
  const report = await host.get();
  assert.deepEqual(report.providers.map((p) => [p.provider, p.name, p.status]), [
    ['anthropic', 'Claude', 'signed-out'],
    ['openai-codex', 'Codex', 'signed-out'],
    ['providerproxy/anthropic', 'Claude (proxy)', 'ok'],
    ['providerproxy/openai-codex', 'Codex (proxy)', 'ok'],
  ]);
  assert.deepEqual(report.headline, { provider: 'providerproxy/anthropic', name: 'Claude (proxy)', label: '5-hour', percent: 8, severity: 'normal' });
  assert.equal(host.calls.length, 2);
  for (const call of host.calls) assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(report).includes(TOKEN));
});

test('proxy: no token means signed out and no request', async () => {
  const host = mountProxy({ upstream: byUrl, env: {} });
  const report = await host.get();
  assert.ok(report.providers.every((p) => p.status === 'signed-out'));
  assert.equal(host.calls.length, 0);
});

test('proxy: a proxy error shows its message and the last good data stays', async () => {
  let fail = false;
  const host = mountProxy({
    upstream: (request) => fail
      ? reply(503, JSON.stringify({ error: { message: 'The selected upstream requires sign-in.', type: 'authentication_error' } }))
      : byUrl(request),
  });
  await host.get();
  fail = true;
  host.clock.advance(HOUR);
  const report = await host.get();
  const claude = report.providers.find((p) => p.provider === 'providerproxy/anthropic');
  assert.equal(claude.status, 'stale');
  assert.equal(claude.reason, 'ProviderProxy: The selected upstream requires sign-in. (HTTP 503)');
  assert.equal(claude.windows.length, 3);
});

test('proxy: 429 keeps Retry-After backoff', async () => {
  const host = mountProxy({ upstream: () => reply(429, '{}', { 'retry-after': '1800' }) });
  await host.get();
  host.clock.advance(10 * MINUTE);
  await host.get();
  assert.equal(host.calls.length, 2, 'no retry before Retry-After elapses');
  host.clock.advance(25 * MINUTE);
  await host.get();
  assert.equal(host.calls.length, 4);
});
