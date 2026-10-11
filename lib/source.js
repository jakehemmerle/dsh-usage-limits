/**
 * The shared core both clients use: read each account's credential, run at most the fetches the
 * per-account reducer (lib/machine.js) allows, share in-flight fetches, and project a redacted
 * UsageReport. No timers: the web route calls `report()` per request, dst calls it from its poller.
 * Tokens leave here only as request headers and as redaction input; they are never stored in state.
 */
import { createHash } from 'node:crypto';
import { initialState, reduce } from './machine.js';
import { buildReport, projectProvider, redact } from './report.js';

/** The proxy client key is the credential: absent means "not configured here". */
function classifyProxy(key) {
  if (typeof key !== 'string' || key.length === 0) return { credential: { kind: 'absent' }, secrets: [] };
  const fingerprint = createHash('sha256').update(key).digest('hex');
  return { credential: { kind: 'usable', fingerprint }, secrets: [key], payload: { access: key } };
}

/** The record changes when DSH refreshes it; hashing keeps the token itself out of plugin state. */
function fingerprintOf(payload) {
  return createHash('sha256').update(`${payload.expires}\u0000${payload.access}`).digest('hex');
}

function classify(account, record, now) {
  if (record === undefined || record === null) return { credential: { kind: 'absent' }, secrets: [] };
  if (record.kind !== 'grant') return { credential: { kind: 'absent' }, secrets: [] };
  const payload = record.payload;
  if (typeof payload !== 'object' || payload === null || payload.type !== 'oauth') return { credential: { kind: 'absent' }, secrets: [] };
  const secrets = [payload.access, payload.refresh].filter((s) => typeof s === 'string');
  if (typeof payload.access !== 'string' || payload.access.length === 0) {
    return { credential: { kind: 'unusable', reason: 'Stored sign-in has no access token; sign in again in DSH' }, secrets };
  }
  if (account.needsAccountId && (typeof payload.accountId !== 'string' || payload.accountId.length === 0)) {
    return { credential: { kind: 'unusable', reason: 'Stored sign-in has no ChatGPT account id; sign in again in DSH' }, secrets };
  }
  if (typeof payload.expires === 'number' && payload.expires <= now) return { credential: { kind: 'expired' }, secrets };
  return { credential: { kind: 'usable', fingerprint: fingerprintOf(payload) }, secrets, payload };
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

function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  return header !== null && /^\s*\d+\s*$/.test(header) ? Number(header) * 1000 : null;
}

/**
 * @param accounts - from lib/accounts.js `accountsOf(config)`.
 * @param deps - `{ fetch, now, env: () => process.env-like, readRecord: async (key) => record | undefined | null, timeoutMs }`;
 *   `readRecord` is null when the host has no credentials service (local accounts are then signed out).
 */
export function createUsageSource(accounts, deps) {
  const states = new Map(accounts.map((account) => [account.id, initialState()]));
  const inflight = new Map();
  const lifetime = new AbortController();

  const dispatch = (account, event) => {
    const result = reduce(states.get(account.id), event, account.policy);
    states.set(account.id, result.state);
    return result.fetch;
  };

  async function fetchUsage(account, payload, now) {
    const controller = new AbortController();
    const signal = lifetime.signal;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('timeout'));
        resolve({ kind: 'failed', reason: `Usage endpoint timed out after ${Math.round(deps.timeoutMs / 1000)} s` });
      }, deps.timeoutMs);
    });
    const exchange = (async () => {
      try {
        const response = await deps.fetch(account.url, { method: 'GET', headers: account.headers(payload), signal: controller.signal });
        if (!response.ok) {
          // A proxy 401/403 is about its client key, not a DSH sign-in that DSH will refresh.
          const proxied = account.proxy ? await proxyFailure(response) : null;
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
        const normalized = account.normalize(body, now());
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

  async function readCredential(account, now) {
    if (account.proxy) return classifyProxy(deps.env()[account.keyEnv]);
    if (deps.readRecord === null) return { credential: { kind: 'absent' }, secrets: [] };
    try {
      return classify(account, await deps.readRecord(account.recordKey), now);
    } catch {
      return { credential: { kind: 'unusable', reason: 'Could not read the stored sign-in' }, secrets: [] };
    }
  }

  async function settle(account) {
    const read = await readCredential(account, deps.now());
    if (lifetime.signal.aborted) return read;
    if (dispatch(account, { type: 'request', now: deps.now(), credential: read.credential })) {
      const run = fetchUsage(account, read.payload, deps.now)
        .then((outcome) => { if (!lifetime.signal.aborted) dispatch(account, { type: 'response', now: deps.now(), outcome }); })
        .finally(() => { inflight.delete(account.id); });
      inflight.set(account.id, run);
    }
    await inflight.get(account.id);
    return read;
  }

  /** One refresh of every account (each throttled by its own policy), then the redacted report. */
  async function report() {
    const reads = await Promise.all(accounts.map(settle));
    const now = deps.now();
    const entries = accounts.map((account, i) => projectProvider(account, states.get(account.id), reads[i].credential, now));
    return redact(buildReport(entries, now), reads.flatMap((read) => read.secrets));
  }

  function fallback() {
    const reason = 'Usage limits are temporarily unavailable';
    return buildReport(accounts.map((a) => ({ provider: a.id, name: a.name, status: 'error', reason })), deps.now());
  }

  return {
    report,
    fallback,
    /** Cancel in-flight requests; later reports start no fetch. */
    dispose(reason = new Error('usage-limits disposed')) {
      lifetime.abort(reason);
    },
    get disposed() { return lifetime.signal.aborted; },
  };
}
