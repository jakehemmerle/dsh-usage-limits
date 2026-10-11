/**
 * Row config → the ordered account list (SPEC.md "Accounts and labels") and timing.
 * ProviderProxy accounts come first, then DSH's own sign-ins.
 */
import { normalizeAnthropic, normalizeCodex } from './normalize.js';

export const DEFAULT_MIN_INTERVAL_MS = 300_000;
export const DEFAULT_PROXY_INTERVAL_MS = 60_000;
export const MIN_INTERVAL_FLOOR_MS = 60_000;
export const UPSTREAM_TIMEOUT_MS = 10_000;
export const POLL_MS = 60_000;
export const TICK_MS = 30_000;
export const DEFAULT_PROXY_KEY_ENV = 'PROVIDERPROXY_API_KEY';

export const UPSTREAM = {
  anthropic: 'https://api.anthropic.com/api/oauth/usage',
  'openai-codex': 'https://chatgpt.com/backend-api/wham/usage',
};

export const LOCAL_ACCOUNTS = [
  {
    id: 'anthropic',
    name: 'Claude',
    recordKey: 'llm-pi-ai/anthropic',
    needsAccountId: false,
    headers: (payload) => ({ Authorization: `Bearer ${payload.access}`, 'anthropic-beta': 'oauth-2025-04-20' }),
    normalize: normalizeAnthropic,
  },
  {
    id: 'openai-codex',
    name: 'Codex',
    recordKey: 'llm-pi-ai/openai-codex',
    needsAccountId: true,
    headers: (payload) => ({ Authorization: `Bearer ${payload.access}`, 'ChatGPT-Account-Id': payload.accountId, 'User-Agent': 'codex-cli' }),
    normalize: normalizeCodex,
  },
];

export const PROXY_ACCOUNTS = [
  { id: 'providerproxy/anthropic', name: 'Claude (proxy)', path: 'claude', normalize: normalizeAnthropic },
  { id: 'providerproxy/openai-codex', name: 'Codex (proxy)', path: 'chatgpt', normalize: normalizeCodex },
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The test-only `testing` block (never set by nix-config); `{}` when absent. */
export function testingOf(config) {
  return isObject(config?.testing) ? config.testing : {};
}

/** Timing for the dst poller and every account's fetch policy. */
export function timingOf(config) {
  const t = testingOf(config);
  return {
    pollMs: positive(t.pollMs) ?? POLL_MS,
    tickMs: positive(t.tickMs) ?? TICK_MS,
    timeoutMs: positive(t.timeoutMs) ?? UPSTREAM_TIMEOUT_MS,
    floorMs: positive(t.floorMs) ?? MIN_INTERVAL_FLOOR_MS,
    maxBackoffMs: positive(t.maxBackoffMs) ?? undefined,
    authRetryMs: positive(t.authRetryMs) ?? undefined,
  };
}

function interval(value, fallback, floorMs) {
  return Math.max(floorMs, typeof value === 'number' && Number.isFinite(value) ? value : fallback);
}

/** `config.proxy` is `{ baseURL, apiKeyEnv?, minIntervalMs? }`; anything else leaves the proxy off. */
function proxyAccounts(config, timing) {
  const proxy = config?.proxy;
  if (!isObject(proxy) || typeof proxy.baseURL !== 'string' || !/^https?:\/\//.test(proxy.baseURL)) return [];
  const base = proxy.baseURL.replace(/\/+$/, '');
  const keyEnv = typeof proxy.apiKeyEnv === 'string' && proxy.apiKeyEnv.length > 0 ? proxy.apiKeyEnv : DEFAULT_PROXY_KEY_ENV;
  const policy = {
    minIntervalMs: interval(proxy.minIntervalMs, DEFAULT_PROXY_INTERVAL_MS, timing.floorMs),
    maxBackoffMs: timing.maxBackoffMs,
    authRetryMs: timing.authRetryMs,
  };
  return PROXY_ACCOUNTS.map((account) => ({
    ...account,
    proxy: true,
    keyEnv,
    policy,
    url: `${base}/usage/${account.path}`,
    headers: (payload) => ({ Authorization: `Bearer ${payload.access}` }),
  }));
}

/** Every configured account, in display order, each with `url` and `policy`. */
export function accountsOf(config) {
  const timing = timingOf(config);
  const upstream = isObject(testingOf(config).upstream) ? testingOf(config).upstream : {};
  const policy = {
    minIntervalMs: interval(config?.minIntervalMs, DEFAULT_MIN_INTERVAL_MS, timing.floorMs),
    maxBackoffMs: timing.maxBackoffMs,
    authRetryMs: timing.authRetryMs,
  };
  const local = LOCAL_ACCOUNTS.map((account) => ({
    ...account,
    proxy: false,
    policy,
    url: typeof upstream[account.id] === 'string' ? upstream[account.id] : UPSTREAM[account.id],
  }));
  return [...proxyAccounts(config, timing), ...local];
}
