// Test-side scenario model: abstract usage windows and their upstream payload encodings.
// Independent of lib/: written from SPEC.md and the recorded upstream fixtures.
//
// An abstract window is { span, scoped, name, percent, resetsAt }:
//   span     seconds (18000 = 5h, 604800 = 7d, anything else) — always known in a scenario
//   scoped   true for a per-model / additional limit (never on the dst line)
//   name     scope name for scoped windows
//   percent  integer 0..100
//   resetsAt epoch ms, or null

export const FIVE_HOURS = 18000;
export const SEVEN_DAYS = 604800;

export const ACCOUNTS = [
  { id: 'providerproxy/anthropic', name: 'Claude (proxy)', short: 'Claude·px', family: 'claude', proxy: true },
  { id: 'providerproxy/openai-codex', name: 'Codex (proxy)', short: 'Codex·px', family: 'codex', proxy: true },
  { id: 'anthropic', name: 'Claude', short: 'Claude', family: 'claude', proxy: false, recordKey: 'llm-pi-ai/anthropic' },
  { id: 'openai-codex', name: 'Codex', short: 'Codex', family: 'codex', proxy: false, recordKey: 'llm-pi-ai/openai-codex' },
];
export const accountById = (id) => ACCOUNTS.find((a) => a.id === id);

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

/** Claude OAuth usage (`limits[]` form, as ProviderProxy relays it). Only 5h/7d/scoped are representable. */
export function claudeBody(windows, { legacy = false } = {}) {
  if (legacy) {
    const body = {};
    for (const w of windows) {
      const entry = { utilization: w.percent, resets_at: iso(w.resetsAt) };
      if (!w.scoped && w.span === FIVE_HOURS) body.five_hour = entry;
      else if (!w.scoped && w.span === SEVEN_DAYS) body.seven_day = entry;
      else if (w.scoped && w.name === 'Opus') body.seven_day_opus = entry;
    }
    return body;
  }
  const limits = [];
  for (const w of windows) {
    if (w.scoped) {
      limits.push({ kind: 'weekly_scoped', group: 'weekly', percent: w.percent, resets_at: iso(w.resetsAt), severity: 'normal',
        scope: { model: { display_name: w.name } } });
    } else if (w.span === FIVE_HOURS) {
      limits.push({ kind: 'session', group: 'session', percent: w.percent, resets_at: iso(w.resetsAt), severity: 'normal' });
    } else if (w.span === SEVEN_DAYS) {
      limits.push({ kind: 'weekly_all', group: 'weekly', percent: w.percent, resets_at: iso(w.resetsAt), severity: 'normal', is_active: true });
    }
  }
  return { limits, extra_usage: { user_disabled: true, credits_ever_enabled: false } };
}

function codexWindow(w, now) {
  return {
    used_percent: w.percent,
    limit_window_seconds: w.span,
    ...(w.resetsAt === null ? {} : {
      reset_at: Math.floor(w.resetsAt / 1000),
      reset_after_seconds: Math.max(0, Math.round((w.resetsAt - now) / 1000)),
    }),
  };
}

/** ChatGPT `wham/usage`: shared windows in rate_limit (≤ 2), scoped ones in additional_rate_limits. */
export function codexBody(windows, now = Date.now(), plan = 'promax') {
  const shared = windows.filter((w) => !w.scoped).slice(0, 2);
  const scoped = windows.filter((w) => w.scoped);
  return {
    plan_type: plan,
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: shared[0] ? codexWindow(shared[0], now) : null,
      secondary_window: shared[1] ? codexWindow(shared[1], now) : null,
    },
    additional_rate_limits: scoped.map((w) => ({ limit_name: w.name, rate_limit: { primary_window: codexWindow(w, now), secondary_window: null } })),
    credits: { has_credits: false, balance: '0' },
  };
}

/** The windows an account's payload actually carries (Codex keeps two shared windows). */
export function representable(account, windows) {
  if (accountById(account).family === 'codex') {
    const shared = windows.filter((w) => !w.scoped).slice(0, 2);
    return [...shared, ...windows.filter((w) => w.scoped)];
  }
  return windows.filter((w) => w.scoped || w.span === FIVE_HOURS || w.span === SEVEN_DAYS);
}

export function bodyFor(account, windows, now = Date.now()) {
  return accountById(account).family === 'claude' ? claudeBody(windows) : codexBody(windows, now);
}

/** A synthetic DSH sign-in record. */
export function grant(account, { access, expires }) {
  const payload = { type: 'oauth', access, refresh: `${access}-refresh`, expires };
  if (accountById(account).family === 'codex') payload.accountId = '00000000-0000-4000-8000-00000000c0de';
  return { kind: 'grant', payload };
}
