// U1/U2 parity: Jake's own omp line (`cmux-usage bars`, copied verbatim into test/oracle/) and
// the plugin's tier-0 line must agree on text, colours and bold names for the accounts omp knows
// (Claude and Codex direct sign-ins). The script reads `omp usage --json`; a stub prints a file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import fc from 'fast-check';
import { renderLine } from '../lib/line.js';
import { v2Report } from './support/v2.js';

const SCRIPT = new URL('./oracle/cmux-usage', import.meta.url).pathname;
const STUB = new URL('./oracle/omp-stub', import.meta.url).pathname;
const RUNS = Number(process.env.CMUX_RUNS ?? 60);
const MIN = 60_000;

function ompJson(entries, now) {
  const reports = [];
  for (const e of entries) {
    const provider = e.id;
    const limits = e.windows.map((w) => ({
      id: provider === 'anthropic' ? `anthropic:${w.short}` : `openai-codex:${w.short === '5h' ? 'primary' : 'secondary'}`,
      window: { id: w.short, resetsAt: w.resetsAt },
      amount: { usedFraction: w.percent / 100, unit: 'percent' },
      scope: { provider, windowId: w.short, shared: true },
    }));
    reports.push({ provider, fetchedAt: now, limits });
  }
  return { reports };
}

function runScript(json) {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-oracle-'));
  try {
    const file = join(dir, 'usage.json');
    writeFileSync(file, JSON.stringify(json));
    try {
      return execFileSync(SCRIPT, ['bars'], { env: { ...process.env, OMP_BIN: STUB, OMP_STUB_JSON: file }, encoding: 'utf8' }).replace(/\n$/, '');
    } catch (error) {
      if (error.status === 1) return null;
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Script output → { text, colours: [{ text, colour }], bold: [names] }. */
function parseAnsi(out) {
  const colours = [];
  const bold = [];
  let text = '';
  let state = null;
  let buffer = '';
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  const flush = () => {
    if (state === 'bold') bold.push(buffer);
    else if (state?.startsWith('38;5;')) colours.push({ text: buffer, colour: Number(state.slice(5)) });
    buffer = '';
  };
  for (let m = re.exec(out); m !== null; m = re.exec(out)) {
    const chunk = out.slice(last, m.index);
    text += chunk;
    buffer += chunk;
    last = re.lastIndex;
    flush();
    state = m[1] === '0' ? null : m[1] === '1' ? 'bold' : m[1];
  }
  text += out.slice(last);
  return { text, colours, bold };
}

const COLOUR = { normal: 28, warning: 130, critical: 160 };

const windowArb = (short, now) => fc.record({
  short: fc.constant(short),
  percent: fc.integer({ min: 0, max: 100 }),
  // Whole minutes plus 30 s, so the script's second-resolution clock reads the same minute.
  resetsAt: fc.integer({ min: 1, max: 9 * 1440 }).map((m) => now + m * MIN + 30_000),
});

test('U1/U2: tier 0 equals Jake\'s cmux-usage bars output (text, colours, bold names)', () => {
  const now = Date.now();
  const accountArb = (id) => fc.record({
    id: fc.constant(id),
    windows: fc.subarray([0, 1]).chain((which) => fc.tuple(...which.map((i) => windowArb(i === 0 ? '5h' : '7d', now)))),
  });
  fc.assert(fc.property(fc.subarray(['anthropic', 'openai-codex']).chain((ids) => fc.tuple(...ids.map(accountArb))), (entries) => {
    const script = runScript(ompJson(entries, now));
    const report = v2Report(entries.map((e) => ({
      id: e.id, status: 'ok',
      windows: e.windows.map((w) => ({ span: w.short === '5h' ? 18000 : 604800, scoped: false, percent: w.percent, resetsAt: w.resetsAt })),
    })), now);
    const line = renderLine(report, { now, width: 1000 });
    if (script === null) {
      assert.equal(line, null);
      return;
    }
    const parsed = parseAnsi(script);
    assert.equal(line.text, parsed.text);
    assert.equal(line.tier, 0);
    assert.deepEqual(
      line.segments.filter((s) => s.style in COLOUR).map((s) => ({ text: s.text, colour: COLOUR[s.style] })),
      parsed.colours.map((c) => ({ text: c.text, colour: c.colour })),
    );
    assert.deepEqual(line.segments.filter((s) => s.style === 'name').map((s) => s.text), parsed.bold);
  }), { numRuns: RUNS, seed: process.env.SEED === undefined ? undefined : Number(process.env.SEED) });
});
