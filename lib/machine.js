/**
 * Per-provider upstream fetch state as a pure reducer.
 *
 *   idle ──request──▶ fetching ──ok──────────────▶ ok
 *                        │      ──401/403────────▶ auth-blocked
 *                        └───── anything else ───▶ backoff
 *   ok | backoff | auth-blocked ──request, gates open──▶ fetching
 *
 * `reduce` performs no I/O; it answers whether the caller must start a fetch.
 * What the report shows (last good data, current failure reason) lives on the
 * state, so the projection is a pure read of it.
 */

export const AUTH_RETRY_MS = 30 * 60 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;

export function initialState() {
  return {
    phase: 'idle',
    lastGood: null,
    reason: null,
    lastAttemptAt: null,
    attemptFingerprint: null,
    retryAt: null,
    authFingerprint: null,
    failures: 0,
  };
}

function gateOpen(state, now, fingerprint, minIntervalMs) {
  if (state.phase === 'fetching') return false;
  if (state.lastAttemptAt !== null && now < state.lastAttemptAt + minIntervalMs) return false;
  if (state.phase === 'backoff' && now < state.retryAt) return false;
  if (state.phase === 'auth-blocked' && fingerprint === state.authFingerprint && now < state.retryAt) return false;
  return true;
}

function isTransientStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function describeHttp(status) {
  if (status === 429) return 'Rate limited by the usage endpoint (HTTP 429)';
  if (status >= 500) return `Usage endpoint unavailable (HTTP ${status})`;
  return `Usage endpoint returned HTTP ${status}`;
}

function settle(state, now, outcome, minIntervalMs) {
  const base = { ...state, attemptFingerprint: null, retryAt: null, authFingerprint: null };
  if (outcome.kind === 'ok') {
    return { ...base, phase: 'ok', reason: null, failures: 0, lastGood: { ...outcome.usage, fetchedAt: now } };
  }
  if (outcome.kind === 'http' && (outcome.status === 401 || outcome.status === 403)) {
    return {
      ...base,
      phase: 'auth-blocked',
      reason: `Sign-in rejected by the usage endpoint (HTTP ${outcome.status}); waiting for DSH to refresh the credential`,
      failures: 0,
      authFingerprint: state.attemptFingerprint,
      retryAt: now + AUTH_RETRY_MS,
    };
  }
  const failures = state.failures + 1;
  const retryAfterMs = outcome.kind === 'http' && isTransientStatus(outcome.status) ? outcome.retryAfterMs ?? null : null;
  const delay = retryAfterMs !== null
    ? Math.min(Math.max(retryAfterMs, 0), MAX_BACKOFF_MS)
    : Math.min(minIntervalMs * 2 ** failures, MAX_BACKOFF_MS);
  return {
    ...base,
    phase: 'backoff',
    reason: outcome.kind === 'http' ? describeHttp(outcome.status) : outcome.reason,
    failures,
    retryAt: now + delay,
  };
}

/**
 * @param state - current provider state.
 * @param event - `{ type: 'request', now, credential }` or `{ type: 'response', now, outcome }`.
 * @param policy - `{ minIntervalMs }`, already floored by the caller.
 * @returns the next state and whether the caller must start exactly one upstream fetch.
 */
export function reduce(state, event, policy) {
  if (event.type === 'request') {
    const { credential } = event;
    if (credential.kind !== 'usable' || !gateOpen(state, event.now, credential.fingerprint, policy.minIntervalMs)) {
      return { state, fetch: false };
    }
    return {
      state: { ...state, phase: 'fetching', lastAttemptAt: event.now, attemptFingerprint: credential.fingerprint },
      fetch: true,
    };
  }
  if (event.type === 'response' && state.phase === 'fetching') {
    return { state: settle(state, event.now, event.outcome, policy.minIntervalMs), fetch: false };
  }
  return { state, fetch: false };
}
