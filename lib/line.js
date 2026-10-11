/**
 * The dst line (SPEC.md "dst line"): report + time + width → styled segments, or null when hidden.
 * Pure; tui.js renders the segments with dsh-TUI's Text and colours.
 *
 * Segment styles: 'name' (bold), 'plain', 'dim' (reset countdown, stale), and the severity of a
 * bar/percent: 'normal' | 'warning' | 'critical'.
 */
import { severityOf } from './report.js';

const SHORT_NAMES = {
  'providerproxy/anthropic': 'Claude·px',
  'providerproxy/openai-codex': 'Codex·px',
};

export function shortName(entry) {
  return SHORT_NAMES[entry.provider] ?? entry.name;
}

export function bar(percent, cells) {
  const fill = Math.min(cells, Math.floor((percent * cells + 50) / 100));
  return '█'.repeat(fill) + '░'.repeat(cells - fill);
}

/** omp's `dur`, for the time left until a reset. */
export function resetText(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 600) return `${Math.floor(m / 60)}h${m % 60}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
}

/** First 5h then first 7d shared window, as it reads at `now` (a passed reset reads 0%, no reset). */
function lineWindows(entry, now) {
  const out = [];
  for (const short of ['5h', '7d']) {
    const w = entry.windows.find((x) => x.short === short);
    if (!w) continue;
    const passed = w.resetsAt !== null && w.resetsAt <= now;
    out.push({ short, percent: passed ? 0 : w.percent, resetsAt: passed ? null : w.resetsAt });
  }
  return out;
}

function tierSegments(shown, tier, now) {
  if (tier === 5) {
    let best = null;
    for (const a of shown) for (const w of a.windows) if (best === null || w.percent > best.w.percent) best = { a, w };
    return [
      { text: shortName(best.a.entry), style: 'name' },
      { text: ` ${best.w.short} `, style: 'plain' },
      { text: `${best.w.percent}%`, style: severityOf(best.w.percent) },
    ];
  }
  const cells = tier === 0 ? 8 : tier === 1 ? 4 : 0;
  const withReset = tier <= 2;
  const separator = tier <= 2 ? '   ' : '  ';
  const segments = [];
  shown.forEach((a, i) => {
    if (i > 0) segments.push({ text: separator, style: 'plain' });
    segments.push({ text: tier <= 3 ? a.entry.name : shortName(a.entry), style: 'name' });
    for (const w of a.windows) {
      segments.push({ text: ` ${w.short} `, style: 'plain' });
      const pct = `${w.percent}%`;
      segments.push({ text: cells > 0 ? `${bar(w.percent, cells)} ${pct}` : pct, style: severityOf(w.percent) });
      if (withReset && w.resetsAt !== null) segments.push({ text: ` ↻${resetText(w.resetsAt - now)}`, style: 'dim' });
    }
    if (a.stale && tier <= 3) segments.push({ text: ' stale', style: 'dim' });
  });
  return segments;
}

const width = (segments) => segments.reduce((n, s) => n + [...s.text].length, 0);

function cut(segments, limit) {
  const out = [];
  let left = limit;
  for (const s of segments) {
    if (left <= 0) break;
    const chars = [...s.text];
    out.push({ ...s, text: chars.slice(0, left).join('') });
    left -= Math.min(left, chars.length);
  }
  return out;
}

/**
 * @param report - a UsageReport (v2).
 * @param options - `{ now, width }`; width is the cells available (dsh-TUI's content width).
 * @returns `{ tier, text, segments }`, or null when no account has a 5h/7d window to show.
 */
export function renderLine(report, { now, width: available }) {
  const shown = (report?.providers ?? [])
    .filter((entry) => entry.status === 'ok' || entry.status === 'stale')
    .map((entry) => ({ entry, stale: entry.status === 'stale', windows: lineWindows(entry, now) }))
    .filter((a) => a.windows.length > 0);
  if (shown.length === 0 || available <= 0) return null;
  for (let tier = 0; tier <= 5; tier += 1) {
    const segments = tierSegments(shown, tier, now);
    if (width(segments) <= available) return { tier, segments, text: segments.map((s) => s.text).join('') };
  }
  const segments = cut(tierSegments(shown, 5, now), available);
  return { tier: 6, segments, text: segments.map((s) => s.text).join('') };
}
