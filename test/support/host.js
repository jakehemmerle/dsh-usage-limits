import { readFileSync } from 'node:fs';
import { createPlugin } from '../../index.js';

export const NOW0 = Date.parse('2026-10-06T15:00:00Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const ANTHROPIC_KEY = 'llm-pi-ai/anthropic';
export const CODEX_KEY = 'llm-pi-ai/openai-codex';
export const PROVIDER_IDS = ['anthropic', 'openai-codex'];

export function fixture(name) {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
}

export function makeClock(start = NOW0) {
  let value = start;
  return {
    now: () => value,
    set: (next) => { value = next; },
    advance: (delta) => { value += delta; },
  };
}

export function grant({ access, refresh, expires, accountId }) {
  const payload = { type: 'oauth', access, refresh, expires };
  if (accountId !== undefined) payload.accountId = accountId;
  return { kind: 'grant', payload };
}

export function signedInRecords(now = NOW0, tokens = {}) {
  return {
    [ANTHROPIC_KEY]: grant({
      access: tokens.anthropicAccess ?? 'sk-ant-oat01-anthropic-access-token-0000',
      refresh: tokens.anthropicRefresh ?? 'sk-ant-ort01-anthropic-refresh-token-0000',
      expires: now + 8 * HOUR,
    }),
    [CODEX_KEY]: grant({
      access: tokens.codexAccess ?? 'eyJcodex-access-token-0000000000',
      refresh: tokens.codexRefresh ?? 'rt_codex-refresh-token-000000000',
      expires: now + 8 * HOUR,
      accountId: '00000000-0000-4000-8000-000000000000',
    }),
  };
}

export function reply(status, body, headers = {}) {
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export async function serve(exchange) {
  await new Promise((resolve) => setImmediate(resolve));
  if (exchange.kind === 'throw') throw new TypeError('fetch failed');
  const headers = exchange.retryAfter === undefined ? {} : { 'retry-after': exchange.retryAfter };
  return reply(exchange.status, exchange.body, headers);
}

export function okReplies() {
  return {
    anthropic: () => reply(200, fixture('anthropic-oauth-usage.json')),
    'openai-codex': () => reply(200, fixture('codex-wham-usage.json')),
  };
}

function providerOf(url) {
  if (url.startsWith('https://api.anthropic.com/')) return 'anthropic';
  if (url.startsWith('https://chatgpt.com/')) return 'openai-codex';
  throw new Error(`unexpected upstream ${url}`);
}

/**
 * Mount the Host half exactly as DSH does — `apply(ctx, config)` — over a fake
 * connection registry and credential store, then expose the registered route.
 */
export function mountHost({ records = signedInRecords(), upstream = okReplies(), config = {}, clock = makeClock(), timeoutMs } = {}) {
  const calls = { anthropic: [], 'openai-codex': [] };
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const provider = providerOf(request.url);
    calls[provider].push({ at: clock.now(), url: request.url, headers: Object.fromEntries(request.headers) });
    const handler = upstream[provider];
    return handler(request, calls[provider].length - 1);
  };
  const plugin = createPlugin({ fetch, now: clock.now, timeoutMs });
  const routes = [];
  const disposers = [];
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.push(route);
          return async () => {};
        },
      },
    },
    credentials: {
      async readRecord(key) {
        const record = records[key];
        return record === undefined ? undefined : structuredClone(record);
      },
    },
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => dispose?.();
    },
    on() { return () => {}; },
  };
  plugin.apply(ctx, config);

  const route = routes.find((entry) => entry.path === '/api/usage-limits');

  async function get(query = '') {
    const response = await route.fetch(new Request(`http://127.0.0.1:3080/api/usage-limits${query}`));
    const text = await response.text();
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text,
      body: JSON.parse(text),
    };
  }

  return { plugin, routes, route, get, calls, clock, records, dispose: () => disposers.forEach((d) => d()) };
}

export function windowsOf(report, provider) {
  const entry = report.providers.find((p) => p.provider === provider);
  return entry.status === 'ok' || entry.status === 'stale' ? entry.windows : [];
}
