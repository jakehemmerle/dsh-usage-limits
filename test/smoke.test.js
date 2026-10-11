// Dependency-free smoke suite (node:test only). nix-config runs it in the vendored package's
// checkPhase, so a vendoring mistake or a missing file fails `nix build` on every host.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createPlugin } from '../index.js';
import * as tui from '../tui.js';
import { renderLine } from '../lib/line.js';
import { accountsOf } from '../lib/accounts.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-06T15:00:00Z');

async function webReport(config, upstream) {
  let route;
  const plugin = createPlugin({ fetch: async (url) => upstream(String(url)), now: () => NOW, env: () => ({ PROVIDERPROXY_API_KEY: 'proxy-key-000000' }) });
  plugin.apply({
    connection: { fetch: { register(entry) { route = entry; } } },
    credentials: { async readRecord() { return undefined; } },
    effect() {},
  }, config);
  return JSON.parse(await (await route.fetch(new Request('http://x/api/usage-limits'))).text());
}

test('web: proxy accounts from the recorded payloads, v2 windows and the 5h/7d headline', async () => {
  const report = await webReport({ proxy: { baseURL: 'http://proxy.test/v1' } }, (url) => new Response(
    url.endsWith('/usage/claude') ? fixture('anthropic-oauth-usage.json') : fixture('codex-wham-usage.json'), { status: 200 }));
  assert.deepEqual(report.providers.map((p) => [p.provider, p.status]), [
    ['providerproxy/anthropic', 'ok'], ['providerproxy/openai-codex', 'ok'], ['anthropic', 'signed-out'], ['openai-codex', 'signed-out'],
  ]);
  assert.deepEqual(report.providers[0].windows.map((w) => [w.label, w.short, w.span]), [['5-hour', '5h', 18000], ['Weekly', '7d', 604800], ['Weekly · Fable', null, 604800]]);
  assert.deepEqual(report.headline, { provider: 'providerproxy/anthropic', name: 'Claude (proxy)', label: '5-hour', short: '5h', percent: 8, severity: 'normal' });
  assert.equal(renderLine(report, { now: NOW, width: 200 }).text, 'Claude (proxy) 5h █░░░░░░░ 8% ↻4h0m 7d ░░░░░░░░ 2% ↻6d23h   Codex (proxy) 7d ░░░░░░░░ 0% ↻6d2h');
});

test('dst line: the omp line Jake used, and its narrow tiers', () => {
  const w = (span, percent, mins) => ({ id: `${span}`, label: '', percent, resetsAt: NOW + mins * 60_000 + 30_000, severity: 'normal', span, short: span === 18000 ? '5h' : '7d' });
  const report = { generatedAt: NOW, providers: [
    { provider: 'anthropic', name: 'Claude', status: 'ok', plan: null, fetchedAt: NOW, windows: [w(18000, 52, 51), w(604800, 80, 3600)] },
    { provider: 'openai-codex', name: 'Codex', status: 'ok', plan: null, fetchedAt: NOW, windows: [w(604800, 28, 4440)] },
  ] };
  assert.equal(renderLine(report, { now: NOW, width: 200 }).text, 'Claude 5h ████░░░░ 52% ↻51m 7d ██████░░ 80% ↻2d12h   Codex 7d ██░░░░░░ 28% ↻3d2h');
  assert.equal(renderLine(report, { now: NOW, width: 40 }).text, 'Claude 5h 52% 7d 80%  Codex 7d 28%');
  assert.equal(renderLine(report, { now: NOW, width: 20 }).text, 'Claude 7d 80%');
});

test('dst half: loads with only tuiStatus and registers one view', () => {
  assert.deepEqual([...tui.inject], ['tuiStatus']);
  const views = [];
  let disposed = 0;
  const intervals = [];
  const plugin = tui.createTuiPlugin({ fetch: async () => new Response('{}', { status: 503 }), now: () => NOW, env: () => ({}),
    setInterval: (fn, ms) => { intervals.push(ms); return intervals.length; }, clearInterval: () => { disposed += 1; } });
  const effects = [];
  plugin.apply({
    tuiStatus: { registerView(d) { views.push(d); return () => {}; }, set() {} },
    inject() {},
    effect(fn) { effects.push(fn()); },
  }, { proxy: { baseURL: 'http://proxy.test/v1' } });
  assert.deepEqual(views.map((v) => [v.key, v.maxRows]), [[tui.VIEW_KEY, 1]]);
  assert.deepEqual(intervals.sort((a, b) => a - b), [30_000, 60_000]);
  for (const dispose of effects) dispose();
  assert.equal(disposed, 2);
});

test('accounts: production intervals and floors; the testing block is the only way below them', () => {
  const [proxy, , local] = accountsOf({ minIntervalMs: 1000, proxy: { baseURL: 'http://p/v1', minIntervalMs: 1000 } });
  assert.equal(proxy.policy.minIntervalMs, 60_000);
  assert.equal(local.policy.minIntervalMs, 60_000);
  const defaults = accountsOf({ proxy: { baseURL: 'http://p/v1' } });
  assert.deepEqual(defaults.map((a) => [a.id, a.policy.minIntervalMs]), [
    ['providerproxy/anthropic', 60_000], ['providerproxy/openai-codex', 60_000], ['anthropic', 300_000], ['openai-codex', 300_000],
  ]);
  assert.equal(defaults[2].url, 'https://api.anthropic.com/api/oauth/usage');
});

test('web client: evaluates as the module loader expects', () => {
  const loaded = [];
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: (d) => loaded.push(d) } } });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, '@local/dsh-usage-limits');
});
