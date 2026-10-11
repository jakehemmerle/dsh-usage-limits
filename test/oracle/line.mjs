// Independent oracle for the dst line and the web headline, written from SPEC.md only.
// It must never import lib/ or the plugin entries.
//
// accounts: [{ name, short, stale, windows: [{ span, scoped, name?, percent, resetsAt }] }]
// in display order, already limited to accounts the spec says have data.

const FIVE = 18000;
const SEVEN = 604800;

export function severity(p) {
  if (p >= 80) return 'critical';
  if (p >= 50) return 'warning';
  return 'normal';
}

/** SGR colour index per severity (omp's 256-colour palette). */
export const COLOUR = { normal: 28, warning: 130, critical: 160 };

export function resetText(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 600) return `${Math.floor(m / 60)}h${m % 60}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
}

export function bar(p, cells) {
  const fill = Math.min(cells, Math.floor((p * cells + 50) / 100));
  return '█'.repeat(fill) + '░'.repeat(cells - fill);
}

/** A window as it shows at `now`: past resets read 0% with no reset time. */
function atTime(w, now) {
  return w.resetsAt !== null && w.resetsAt <= now ? { ...w, percent: 0, resetsAt: null } : w;
}

/** The account's line windows: first shared 5h, then first shared 7d. */
export function lineWindows(account, now) {
  const shared = account.windows.filter((w) => !w.scoped);
  const out = [];
  const five = shared.find((w) => w.span === FIVE);
  const seven = shared.find((w) => w.span === SEVEN);
  if (five) out.push({ short: '5h', ...atTime(five, now) });
  if (seven) out.push({ short: '7d', ...atTime(seven, now) });
  return out;
}

function renderTier(shown, tier, now) {
  if (tier === 5) {
    let best = null;
    for (const a of shown) for (const w of a.lw) if (best === null || w.percent > best.w.percent) best = { a, w };
    const pct = `${best.w.percent}%`;
    return { text: `${best.a.short} ${best.w.short} ${pct}`, cells: [{ text: pct, severity: severity(best.w.percent) }] };
  }
  const cellsN = tier === 0 ? 8 : tier === 1 ? 4 : 0;
  const withReset = tier <= 2;
  const sep = tier <= 2 ? '   ' : '  ';
  const cells = [];
  const parts = shown.map((a) => {
    const windows = a.lw.map((w) => {
      const pct = `${w.percent}%`;
      const coloured = cellsN > 0 ? `${bar(w.percent, cellsN)} ${pct}` : pct;
      cells.push({ text: coloured, severity: severity(w.percent) });
      const reset = withReset && w.resetsAt !== null ? ` ↻${resetText(w.resetsAt - now)}` : '';
      return `${w.short} ${coloured}${reset}`;
    });
    const name = tier <= 3 ? a.name : a.short;
    const stale = a.stale && tier <= 3 ? ' stale' : '';
    return `${name} ${windows.join(' ')}${stale}`;
  });
  return { text: parts.join(sep), cells };
}

/**
 * Expected dst line. Returns null when hidden. `width` is W (dsh-TUI's content width).
 * { text, tier, cells: [{ text: '<bar> <p>%' | '<p>%', severity }] }
 */
export function expectedLine(accounts, now, width) {
  const shown = accounts.map((a) => ({ ...a, lw: lineWindows(a, now) })).filter((a) => a.lw.length > 0);
  if (shown.length === 0 || width <= 0) return null;
  for (let tier = 0; tier <= 5; tier += 1) {
    const r = renderTier(shown, tier, now);
    if ([...r.text].length <= width) return { ...r, tier };
  }
  const r = renderTier(shown, 5, now);
  return { ...r, text: [...r.text].slice(0, width).join(''), tier: 6 };
}

function durationLabel(span) {
  if (span === FIVE) return '5-hour';
  if (span === SEVEN) return 'Weekly';
  if (span % 86400 === 0) return `${span / 86400}-day`;
  if (span % 3600 === 0) return `${span / 3600}-hour`;
  return `${Math.max(1, Math.round(span / 60))}-minute`;
}

/** Window label as the web panel shows it. */
export function windowLabel(account, w) {
  const family = account.family ?? (account.name.startsWith('Claude') ? 'claude' : 'codex');
  if (family === 'claude') {
    if (w.scoped) return `Weekly · ${w.name}`;
    return w.span === FIVE ? '5-hour' : 'Weekly';
  }
  return w.scoped ? `${durationLabel(w.span)} · ${w.name}` : durationLabel(w.span);
}

/**
 * Expected web headline over accounts with data: { text, severity } or null (trigger reads `Usage`).
 */
export function expectedHeadline(accounts, now) {
  let best = null;
  for (const a of accounts) {
    for (const w of lineWindows(a, now)) {
      if (best === null || w.percent > best.percent) best = { text: `${a.name} ${w.short} ${w.percent}%`, percent: w.percent };
    }
  }
  if (best === null) {
    for (const a of accounts) {
      for (const raw of a.windows) {
        const w = atTime(raw, now);
        if (best === null || w.percent > best.percent) best = { text: `${a.name} ${windowLabel(a, raw)} ${w.percent}%`, percent: w.percent };
      }
    }
  }
  return best === null ? null : { text: best.text, severity: severity(best.percent) };
}
