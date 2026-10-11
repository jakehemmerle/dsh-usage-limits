// UsageReport v2 built from SPEC.md for tests (independent of lib/report.js).
import fc from 'fast-check';
import { ACCOUNTS, FIVE_HOURS, SEVEN_DAYS, representable } from '../e2e/support/scenario.mjs';
import { severity, windowLabel } from '../oracle/line.mjs';

export const NUM_RUNS = Number(process.env.NUM_RUNS ?? 1000);
export const T0 = Date.parse('2026-10-11T16:00:00Z');

function slug(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function shortOf(w) {
  if (w.scoped) return null;
  if (w.span === FIVE_HOURS) return '5h';
  if (w.span === SEVEN_DAYS) return '7d';
  return null;
}

/** One report window per SPEC (reset passed at report time → 0%, no reset). */
export function v2Window(account, w, now) {
  const passed = w.resetsAt !== null && w.resetsAt <= now;
  const percent = passed ? 0 : w.percent;
  const label = windowLabel(account, w);
  return { id: slug(label), label, percent, resetsAt: passed ? null : w.resetsAt, severity: severity(percent), span: w.span, short: shortOf(w) };
}

/**
 * entries: [{ id, status: 'ok'|'stale'|'error'|'signed-out', windows, plan? }] in any order;
 * returns the report the plugin should serve (accounts in SPEC order).
 */
export function v2Report(entries, now) {
  const providers = [];
  for (const account of ACCOUNTS) {
    const e = entries.find((x) => x.id === account.id);
    if (!e) continue;
    const head = { provider: account.id, name: account.name };
    if (e.status === 'signed-out') { providers.push({ ...head, status: 'signed-out' }); continue; }
    if (e.status === 'error') { providers.push({ ...head, status: 'error', reason: 'Could not reach the usage endpoint' }); continue; }
    const seen = new Set();
    const windows = representable(account.id, e.windows).map((w) => v2Window(account, w, now)).map((w) => {
      let id = w.id;
      for (let n = 2; seen.has(id); n += 1) id = `${w.id}-${n}`;
      seen.add(id);
      return { ...w, id };
    });
    const data = { plan: e.plan ?? null, windows, fetchedAt: now - 1000 };
    const seenShort = new Set();
    for (const w of windows) {
      if (w.short === null) continue;
      if (seenShort.has(w.short)) w.short = null;
      else seenShort.add(w.short);
    }
    providers.push(e.status === 'stale' ? { ...head, status: 'stale', reason: 'Usage endpoint unavailable (HTTP 503)', ...data } : { ...head, status: 'ok', ...data });
  }
  return { generatedAt: now, providers };
}

/** The oracle's account view of a report's entries (data-bearing only). */
export function oracleAccounts(entries) {
  return ACCOUNTS.flatMap((account) => {
    const e = entries.find((x) => x.id === account.id);
    if (!e || (e.status !== 'ok' && e.status !== 'stale')) return [];
    return [{ ...account, stale: e.status === 'stale', windows: representable(account.id, e.windows) }];
  });
}

const SPANS = [FIVE_HOURS, SEVEN_DAYS, 86400, 3600, 1800, 2592000];

export function windowArb(now) {
  return fc.record({
    span: fc.constantFrom(...SPANS, FIVE_HOURS, SEVEN_DAYS),
    scoped: fc.boolean(),
    name: fc.constantFrom('Fable', 'Opus', 'codex-spark', 'GPT-5.3-Codex-Spark'),
    percent: fc.integer({ min: 0, max: 100 }),
    resetsAt: fc.option(fc.integer({ min: now - 3 * 3600_000, max: now + 9 * 86400_000 }), { nil: null }),
  });
}

export function entriesArb(now) {
  return fc.uniqueArray(
    fc.record({
      id: fc.constantFrom(...ACCOUNTS.map((a) => a.id)),
      status: fc.constantFrom('ok', 'ok', 'stale', 'error', 'signed-out'),
      windows: fc.array(windowArb(now), { maxLength: 5 }),
    }),
    { selector: (e) => e.id, maxLength: 4 },
  );
}
