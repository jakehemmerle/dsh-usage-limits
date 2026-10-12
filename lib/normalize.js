/**
 * Upstream payload → `{ plan, windows }` with raw (pre-expiry) windows
 * `{ id, label, percent, resetsAt, span, scoped }`: `span` is the window length in seconds
 * (null when the payload does not say) and `scoped` marks a per-model or additional limit,
 * both read from the payload rather than inferred from labels. Total: a payload with no parseable
 * window returns `{ ok: false, reason }` instead of throwing, so a junk 200
 * keeps the last good data.
 */

const UNEXPECTED = { ok: false, reason: 'Unexpected response shape from the usage endpoint' };

export const FIVE_HOURS = 18000;
export const SEVEN_DAYS = 604800;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every payload shape carries a percentage (0–100); SPEC U13. Nearest integer, clamped. */
function toPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

const MAX_DATE_MS = 8.64e15;

function epoch(ms) {
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS ? Math.round(ms) : null;
}

function isoToEpoch(value) {
  return typeof value === 'string' ? epoch(Date.parse(value)) : null;
}

function secondsToEpoch(value) {
  return typeof value === 'number' ? epoch(value * 1000) : null;
}

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Ids follow labels, so a window keeps its id whichever payload shape carried it. */
function withLabelIds(windows) {
  const seen = new Set();
  return windows.map((window) => {
    const base = slug(window.label);
    let id = base;
    for (let n = 2; seen.has(id); n += 1) id = `${base}-${n}`;
    seen.add(id);
    return { id, ...window };
  });
}

function parsed(plan, windows) {
  return windows.length === 0 ? UNEXPECTED : { ok: true, usage: { plan, windows: withLabelIds(windows) } };
}

/** Label a window by its length so a weekly window reads "Weekly" whichever slot carries it. */
function durationLabel(seconds) {
  if (seconds === null) return 'Usage';
  if (seconds === 18000) return '5-hour';
  if (seconds === 604800) return 'Weekly';
  if (seconds % 86400 === 0) return `${seconds / 86400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return `${Math.max(1, Math.round(seconds / 60))}-minute`;
}

function scopedName(entry) {
  const name = entry.scope?.model?.display_name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
}

function anthropicLimit(entry) {
  if (!isObject(entry)) return null;
  const percent = toPercent(entry.percent);
  if (percent === null) return null;
  const resetsAt = isoToEpoch(entry.resets_at);
  if (entry.kind === 'session') return { label: '5-hour', percent, resetsAt, span: FIVE_HOURS, scoped: false };
  if (entry.kind === 'weekly_all') return { label: 'Weekly', percent, resetsAt, span: SEVEN_DAYS, scoped: false };
  if (entry.kind === 'weekly_scoped') return { label: `Weekly · ${scopedName(entry) ?? 'scoped'}`, percent, resetsAt, span: SEVEN_DAYS, scoped: true };
  return null;
}

const ANTHROPIC_LEGACY = [
  ['five_hour', '5-hour', FIVE_HOURS, false],
  ['seven_day', 'Weekly', SEVEN_DAYS, false],
  ['seven_day_opus', 'Weekly · Opus', SEVEN_DAYS, true],
  ['seven_day_sonnet', 'Weekly · Sonnet', SEVEN_DAYS, true],
];

export function normalizeAnthropic(body) {
  if (!isObject(body)) return UNEXPECTED;
  const fromLimits = Array.isArray(body.limits) ? body.limits.map(anthropicLimit).filter(Boolean) : [];
  if (fromLimits.length > 0) return parsed(null, fromLimits);
  const legacy = [];
  for (const [key, label, span, scoped] of ANTHROPIC_LEGACY) {
    const entry = body[key];
    if (!isObject(entry)) continue;
    const percent = toPercent(entry.utilization);
    if (percent !== null) legacy.push({ label, percent, resetsAt: isoToEpoch(entry.resets_at), span, scoped });
  }
  return parsed(null, legacy);
}

function codexWindow(window, labelSuffix, fetchedAt) {
  if (!isObject(window)) return null;
  const percent = toPercent(window.used_percent);
  if (percent === null) return null;
  const seconds = window.limit_window_seconds;
  const length = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
  let resetsAt = secondsToEpoch(window.reset_at);
  if (resetsAt === null && typeof window.reset_after_seconds === 'number' && Number.isFinite(window.reset_after_seconds)) {
    resetsAt = epoch(fetchedAt + Math.max(0, window.reset_after_seconds * 1000));
  }
  const label = durationLabel(length);
  return { label: labelSuffix === null ? label : `${label} · ${labelSuffix}`, percent, resetsAt, span: length, scoped: labelSuffix !== null };
}

function codexPair(rateLimit, labelSuffix, fetchedAt) {
  if (!isObject(rateLimit)) return [];
  return [rateLimit.primary_window, rateLimit.secondary_window]
    .map((window) => codexWindow(window, labelSuffix, fetchedAt))
    .filter(Boolean);
}

export function normalizeCodex(body, fetchedAt) {
  if (!isObject(body)) return UNEXPECTED;
  const windows = codexPair(body.rate_limit, null, fetchedAt);
  if (Array.isArray(body.additional_rate_limits)) {
    for (const extra of body.additional_rate_limits) {
      if (!isObject(extra)) continue;
      const name = typeof extra.limit_name === 'string' && extra.limit_name.trim().length > 0 ? extra.limit_name.trim() : null;
      windows.push(...codexPair(extra.rate_limit, name ?? 'additional', fetchedAt));
    }
  }
  const individual = isObject(body.spend_control) ? body.spend_control.individual_limit : null;
  if (isObject(individual)) {
    const percent = toPercent(individual.used_percent);
    if (percent !== null) windows.push({ label: 'Spend limit', percent, resetsAt: secondsToEpoch(individual.reset_at), span: null, scoped: true });
  }
  const plan = typeof body.plan_type === 'string' && body.plan_type.length > 0 ? body.plan_type : null;
  return parsed(plan, windows);
}
