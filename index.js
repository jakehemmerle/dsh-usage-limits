/**
 * Host half: `GET /api/usage-limits` → UsageReport. A thin shell over the
 * pure per-provider reducer in lib/machine.js — it reads credentials, feeds
 * events, runs the one fetch the reducer asks for, and projects the result.
 */
import { createHash } from 'node:crypto';
import { initialState, reduce } from './lib/machine.js';
import { normalizeAnthropic, normalizeCodex } from './lib/normalize.js';
import { buildReport, projectProvider, redact } from './lib/report.js';

export const ROUTE_PATH = '/api/usage-limits';
export const DEFAULT_MIN_INTERVAL_MS = 300_000;
export const MIN_INTERVAL_FLOOR_MS = 60_000;
export const UPSTREAM_TIMEOUT_MS = 10_000;

export const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Claude',
    recordKey: 'llm-pi-ai/anthropic',
    url: 'https://api.anthropic.com/api/oauth/usage',
    needsAccountId: false,
    headers: (payload) => ({ Authorization: `Bearer ${payload.access}`, 'anthropic-beta': 'oauth-2025-04-20' }),
    normalize: normalizeAnthropic,
  },
  {
    id: 'openai-codex',
    name: 'Codex',
    recordKey: 'llm-pi-ai/openai-codex',
    url: 'https://chatgpt.com/backend-api/wham/usage',
    needsAccountId: true,
    headers: (payload) => ({ Authorization: `Bearer ${payload.access}`, 'ChatGPT-Account-Id': payload.accountId, 'User-Agent': 'codex-cli' }),
    normalize: normalizeCodex,
  },
];

/**
 * Optional ProviderProxy source: the proxy holds its own Claude and Codex
 * sign-ins on the server and serves their plan usage at /v1/usage/{claude,chatgpt}.
 * Shown beside, never instead of, the sign-ins DSH stores itself.
 */
export const PROXY_PROVIDERS = [
  { id: 'providerproxy/anthropic', name: 'Claude (proxy)', path: 'claude', normalize: normalizeAnthropic },
  { id: 'providerproxy/openai-codex', name: 'Codex (proxy)', path: 'chatgpt', normalize: normalizeCodex },
];
export const DEFAULT_PROXY_KEY_ENV = 'PROVIDERPROXY_API_KEY';

export const inject = ['connection', 'credentials'];

/** `config.proxy` is `{ baseURL, apiKeyEnv? }`; anything else leaves the proxy off. */
function proxyProvidersOf(config) {
  const proxy = config?.proxy;
  if (proxy === null || typeof proxy !== 'object' || typeof proxy.baseURL !== 'string' || !/^https?:\/\//.test(proxy.baseURL)) return [];
  const base = proxy.baseURL.replace(/\/+$/, '');
  const keyEnv = typeof proxy.apiKeyEnv === 'string' && proxy.apiKeyEnv.length > 0 ? proxy.apiKeyEnv : DEFAULT_PROXY_KEY_ENV;
  return PROXY_PROVIDERS.map((provider) => ({
    ...provider,
    proxy: true,
    keyEnv,
    url: `${base}/usage/${provider.path}`,
    headers: (payload) => ({ Authorization: `Bearer ${payload.access}` }),
  }));
}

/** The proxy client token is the credential: absent means "not configured here". */
function classifyProxy(key) {
  if (typeof key !== 'string' || key.length === 0) return { credential: { kind: 'absent' }, secrets: [] };
  const fingerprint = createHash('sha256').update(key).digest('hex');
  return { credential: { kind: 'usable', fingerprint }, secrets: [key], payload: { access: key } };
}

/** ProviderProxy errors are safe for publication; show their message rather than a bare status. */
async function proxyFailure(response) {
  if (response.status === 429) return null;
  try {
    const message = JSON.parse(await response.text())?.error?.message;
    if (typeof message === 'string' && message.length > 0 && message.length <= 200) {
      return { kind: 'failed', reason: `ProviderProxy: ${message} (HTTP ${response.status})` };
    }
  } catch {
    // Fall through to the plain HTTP outcome.
  }
  return { kind: 'failed', reason: `ProviderProxy returned HTTP ${response.status}` };
}

function minIntervalOf(config) {
  const value = config?.minIntervalMs;
  return Math.max(MIN_INTERVAL_FLOOR_MS, typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MIN_INTERVAL_MS);
}

/** The record changes when DSH refreshes it; hashing keeps the token itself out of plugin state. */
function fingerprintOf(payload) {
  return createHash('sha256').update(`${payload.expires}\u0000${payload.access}`).digest('hex');
}

/** Tokens leave here only as `payload` (for the upstream header) and `secrets` (for redaction), never in state. */
function classify(provider, record, now) {
  if (record === undefined || record === null) return { credential: { kind: 'absent' }, secrets: [] };
  if (record.kind !== 'grant') return { credential: { kind: 'absent' }, secrets: [] };
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || payload.type !== 'oauth') return { credential: { kind: 'absent' }, secrets: [] };
  const secrets = [payload.access, payload.refresh].filter((s) => typeof s === 'string');
  if (typeof payload.access !== 'string' || payload.access.length === 0) {
    return { credential: { kind: 'unusable', reason: 'Stored sign-in has no access token; sign in again in DSH' }, secrets };
  }
  if (provider.needsAccountId && (typeof payload.accountId !== 'string' || payload.accountId.length === 0)) {
    return { credential: { kind: 'unusable', reason: 'Stored sign-in has no ChatGPT account id; sign in again in DSH' }, secrets };
  }
  if (typeof payload.expires === 'number' && payload.expires <= now) return { credential: { kind: 'expired' }, secrets };
  return { credential: { kind: 'usable', fingerprint: fingerprintOf(payload) }, secrets, payload };
}

function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  return header !== null && /^\s*\d+\s*$/.test(header) ? Number(header) * 1000 : null;
}

/**
 * Build the plugin around injectable seams. DSH loads the module-level
 * `apply`, bound to the real fetch and clock; tests build their own.
 * @param deps - `{ fetch, now, timeoutMs?, env? }`; `env()` returns the variables holding a proxy token.
 */
export function createPlugin(deps) {
  const timeoutMs = deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const env = deps.env ?? (() => process.env);

  async function fetchUsage(provider, payload, signal, now) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('timeout'));
        resolve({ kind: 'failed', reason: `Usage endpoint timed out after ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
    });
    const exchange = (async () => {
      try {
        const response = await deps.fetch(provider.url, { method: 'GET', headers: provider.headers(payload), signal: controller.signal });
        if (!response.ok) {
          // A proxy 401/403 is about its client token, not a DSH sign-in that DSH will refresh.
          const proxied = provider.proxy ? await proxyFailure(response) : null;
          if (proxied !== null) return proxied;
          await response.body?.cancel().catch(() => {});
          return { kind: 'http', status: response.status, retryAfterMs: retryAfterMs(response) };
        }
        let body;
        try {
          body = JSON.parse(await response.text());
        } catch {
          return { kind: 'failed', reason: 'Usage endpoint returned invalid JSON' };
        }
        const normalized = provider.normalize(body, now());
        return normalized.ok ? { kind: 'ok', usage: normalized.usage } : { kind: 'failed', reason: normalized.reason };
      } catch {
        return controller.signal.aborted
          ? { kind: 'failed', reason: 'Usage request was cancelled' }
          : { kind: 'failed', reason: 'Could not reach the usage endpoint' };
      }
    })();
    try {
      return await Promise.race([exchange, timeout]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }

  function apply(ctx, config = {}) {
    const policy = { minIntervalMs: minIntervalOf(config) };
    const providers = [...PROVIDERS, ...proxyProvidersOf(config)];
    const states = new Map(providers.map((provider) => [provider.id, initialState()]));
    const inflight = new Map();
    const lifetime = new AbortController();

    const dispatch = (provider, event) => {
      const result = reduce(states.get(provider.id), event, policy);
      states.set(provider.id, result.state);
      return result.fetch;
    };

    async function readCredential(provider, now) {
      if (provider.proxy) return classifyProxy(env()[provider.keyEnv]);
      try {
        return classify(provider, await ctx.credentials.readRecord(provider.recordKey), now);
      } catch {
        return { credential: { kind: 'unusable', reason: 'Could not read the stored sign-in' }, secrets: [] };
      }
    }

    async function settleProvider(provider) {
      const read = await readCredential(provider, deps.now());
      if (dispatch(provider, { type: 'request', now: deps.now(), credential: read.credential })) {
        const run = fetchUsage(provider, read.payload, lifetime.signal, deps.now)
          .then((outcome) => { dispatch(provider, { type: 'response', now: deps.now(), outcome }); })
          .finally(() => { inflight.delete(provider.id); });
        inflight.set(provider.id, run);
      }
      await inflight.get(provider.id);
      return read;
    }

    async function respond() {
      const reads = await Promise.all(providers.map(settleProvider));
      const now = deps.now();
      const entries = providers.map((provider, i) => projectProvider(provider, states.get(provider.id), reads[i].credential, now));
      return redact(buildReport(entries, now), reads.flatMap((read) => read.secrets));
    }

    function fallback(now) {
      const reason = 'Usage limits are temporarily unavailable';
      return buildReport(providers.map((p) => ({ provider: p.id, name: p.name, status: 'error', reason })), now);
    }

    ctx.effect(() => () => lifetime.abort(new Error('usage-limits plugin disposed')), 'usage-limits: in-flight upstream requests');

    ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      // `?refresh=1` is accepted but every read already refetches once the throttle allows it.
      fetch: async () => {
        let report;
        try {
          report = await respond();
        } catch {
          report = fallback(deps.now());
        }
        return new Response(JSON.stringify(report), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    });
  }

  return { inject, apply };
}

export const { apply } = createPlugin({
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
});
