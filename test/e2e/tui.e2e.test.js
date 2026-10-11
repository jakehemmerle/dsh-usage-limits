// Real dst (dsh-TUI) in a private tmux socket, real dsh host, mock model, mock usage endpoints.
// U1/U2/U3/U4/U6/U7/U8/U9/U12 on the actual terminal; generated action sequences (fast-check)
// check the spec line after every step, on the Launchpad and in chat.
//
//   DSH_TUI_DIR=<patched dsh-tui> E2E_RUNS=20 SEED=1 node --test test/e2e/tui.e2e.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { startTui, sleep } from '../rig/rig.mjs';
import { expectedLine, COLOUR } from '../oracle/line.mjs';
import { ACCOUNTS } from './support/scenario.mjs';
import { startCase, observedAccounts, secretsOf, awaitRequest, reachable, fcOptions, MARGIN } from './support/e2e.mjs';

const USAGE_ROW = /(Claude|Codex)( \(proxy\)|·px)? (5h|7d) /;
const LAUNCHPAD = /Mock (Alpha|Beta)|mock-(alpha|beta)/;

/** Runs of a row whose 256-colour foreground is a severity colour, from tmux `capture-pane -e`. */
function colouredRuns(ansiRow) {
  const runs = [];
  let fg = null;
  let current = null;
  const re = /\x1b\[([0-9;:]*)m/g;
  let last = 0;
  // A space never breaks a run: renderers skip unchanged blank cells, so their colour is unobservable.
  const take = (text) => {
    for (const ch of text) {
      if (ch === ' ' && current) { current.text += ' '; continue; }
      if (fg !== null && Object.values(COLOUR).includes(fg)) {
        if (current && current.fg === fg) current.text += ch;
        else { current = { text: ch, fg }; runs.push(current); }
      } else current = null;
    }
  };
  for (let m = re.exec(ansiRow); m !== null; m = re.exec(ansiRow)) {
    take(ansiRow.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === '' ? [0] : m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0 || code === 39) fg = null;
      else if (code === 38 && codes[i + 1] === 5) { fg = codes[i + 2]; i += 2; }
      else if (code >= 30 && code <= 37) fg = code - 30;
      else if (code >= 90 && code <= 97) fg = code - 90 + 8;
    }
  }
  take(ansiRow.slice(last));
  return runs.map((r) => ({ text: r.text.trim(), fg: r.fg })).filter((r) => r.text.length > 0);
}

function assertSafe(screen, c) {
  for (const secret of secretsOf(c)) assert.ok(!screen.includes(secret), 'a secret reached the screen');
}

/** Wait until the screen shows exactly the spec line for the observed state (or none). */
async function expectScreen(c, tui, cols, where, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let screen = '';
  let want = null;
  while (Date.now() < deadline) {
    want = expectedLine(observedAccounts(c), Date.now(), cols - MARGIN);
    screen = tui.capture();
    assertSafe(screen, c);
    const rows = screen.split('\n');
    if (want === null) {
      if (!rows.some((r) => USAGE_ROW.test(r))) return null;
    } else {
      const index = rows.findIndex((r) => r.trim() === want.text);
      if (index >= 0) {
        const ansi = tui.captureAnsi().split('\n')[index] ?? '';
        const runs = colouredRuns(ansi);
        const expected = want.cells.map((cell) => ({ text: cell.text, fg: COLOUR[cell.severity] }));
        if (JSON.stringify(runs) === JSON.stringify(expected)) return index;
      }
    }
    await sleep(150);
  }
  throw new Error(`${where}: expected ${want === null ? 'no usage line' : JSON.stringify(want.text)}\n--- screen ---\n${screen}`);
}

async function boot(c, cols) {
  c.markStart();
  const tui = startTui(c.profile, { cols, rows: 40 });
  try {
    await tui.waitFor(LAUNCHPAD, { timeout: 60000 });
    await assertInitialRequests(c);
  } catch (error) {
    // The caller never receives this TUI, so it must not outlive the failure (it would keep node alive).
    await tui.kill();
    c.profile.dispose();
    await c.close();
    throw error;
  }
  return tui;
}

/** U5 liveness: every reachable account is requested as soon as the plugin loads (the log oracle alone would accept a plugin that never fetches). */
async function assertInitialRequests(c) {
  for (const account of ACCOUNTS.filter((a) => reachable(c, a))) {
    assert.ok(await awaitRequest(c, account.id, c.epoch, 10000), `U5: ${account.id} was never requested after start`);
  }
}

const MIN = 60_000;
const at = (minutes) => (minutes === null ? null : Date.now() + minutes * MIN + 30_000);
const ok = (windows) => ({ kind: 'ok', windows: windows.map((w) => ({ ...w, resetsAt: at(w.in ?? null) })) });

test('Launchpad then chat: the line is above the prompt on both screens, and stays through a busy turn', async () => {
  const c = await startCase({
    kind: 'tui',
    grants: { anthropic: 'valid', 'openai-codex': 'absent' },
    responses: {
      'providerproxy/anthropic': ok([{ span: 18000, scoped: false, percent: 1, in: 149 }, { span: 604800, scoped: false, percent: 29, in: 5 * 1440 + 360 }]),
      'providerproxy/openai-codex': ok([{ span: 604800, scoped: false, percent: 12, in: 3 * 1440 + 660 }]),
      anthropic: ok([{ span: 18000, scoped: false, percent: 52, in: 51 }, { span: 604800, scoped: false, percent: 80, in: 2 * 1440 + 720 }, { span: 604800, scoped: true, name: 'Fable', percent: 3, in: 3000 }]),
    },
  });
  const before = c.credentialsBytes();
  const tui = await boot(c, 220);
  try {
    const row = await expectScreen(c, tui, 220, 'Launchpad');
    const screen = tui.capture().split('\n');
    const prompt = screen.findIndex((r) => /╭/.test(r) && screen.indexOf(r) > row);
    assert.ok(prompt > row, 'the line sits above the Launchpad input card');
    await tui.submit('hello there', { until: () => c.mock.turns().length > 0 });
    await tui.waitFor(/turn finished/);
    await expectScreen(c, tui, 220, 'chat');
    c.mock.hold(true);
    await tui.submit('a slow one', { until: () => c.mock.turns().length > 1 });
    await expectScreen(c, tui, 220, 'busy turn');
    c.mock.hold(false);
    await sleep(500);
    await expectScreen(c, tui, 220, 'after busy turn');
    assert.equal(c.credentialsBytes(), before, 'U12: sign-ins untouched');
  } finally {
    c.mock.hold(false);
    await tui.kill();
    c.profile.dispose();
    await c.close();
  }
});

test('/model switch and restart: the line survives the session fork and comes back after a restart', async () => {
  const c = await startCase({
    kind: 'tui',
    responses: { 'providerproxy/openai-codex': ok([{ span: 18000, scoped: false, percent: 64, in: 200 }, { span: 604800, scoped: false, percent: 85, in: 4000 }]) },
  });
  let tui = await boot(c, 160);
  try {
    await expectScreen(c, tui, 160, 'Launchpad');
    await tui.submit('first', { until: () => c.mock.turns().length > 0 });
    await tui.waitFor(/turn finished/);
    // dsh-TUI 0.14.0's built-in picker: providers (Recently used, DeepSeek, Mock), then models.
    tui.text('/model');
    await tui.waitFor(/\/model/);
    await sleep(300);
    tui.keys('Enter');
    await tui.waitFor(/Enter to view models/);
    for (let i = 0; i < 6 && !/❯ Mock/.test(tui.capture()); i += 1) {
      tui.keys('Down');
      await sleep(200);
    }
    assert.match(tui.capture(), /❯ Mock/);
    tui.keys('Enter');
    await tui.waitFor(/Mock Beta/);
    for (let i = 0; i < 4 && !/❯ .*Mock Beta/.test(tui.capture()); i += 1) {
      tui.keys('Down');
      await sleep(200);
    }
    tui.keys('Enter');
    await tui.waitFor(/mock-beta/);
    assert.equal(c.profile.readTui('model.json')?.model, 'mock-beta', 'the switch took effect');
    await expectScreen(c, tui, 160, 'after /model');
    await tui.kill();
    tui = await boot(c, 160);
    await expectScreen(c, tui, 160, 'after restart');
  } finally {
    await tui.kill();
    c.profile.dispose();
    await c.close();
  }
});

test('narrow terminals: the line degrades by tier and never wraps or overflows', async () => {
  const c = await startCase({
    kind: 'tui',
    grants: { anthropic: 'valid', 'openai-codex': 'valid' },
    responses: Object.fromEntries(ACCOUNTS.map((a, i) => [a.id, ok([{ span: 18000, scoped: false, percent: 20 * i + 5, in: 30 + i }, { span: 604800, scoped: false, percent: 90 - 10 * i, in: 3000 + i }])])),
  });
  const tui = await boot(c, 200);
  try {
    for (const cols of [200, 150, 120, 100, 80, 60, 40, 30]) {
      tui.resize(cols);
      await expectScreen(c, tui, cols, `${cols} columns`);
    }
  } finally {
    await tui.kill();
    c.profile.dispose();
    await c.close();
  }
});

test('failure keeps data stale, recovery clears it; an echoed secret never shows', async () => {
  const c = await startCase({
    kind: 'tui',
    responses: { 'providerproxy/anthropic': ok([{ span: 18000, scoped: false, percent: 33, in: 100 }]) },
  });
  const tui = await boot(c, 160);
  try {
    await expectScreen(c, tui, 160, 'fresh');
    let since = Date.now();
    c.upstream.set('providerproxy/anthropic', { kind: 'status', status: 503, message: 'The selected upstream requires sign-in.' });
    assert.ok(await awaitRequest(c, 'providerproxy/anthropic', since));
    const row = await expectScreen(c, tui, 160, 'stale');
    assert.match(tui.capture().split('\n')[row], / stale$/);
    since = Date.now();
    c.upstream.set('providerproxy/anthropic', { kind: 'echo', secret: c.secrets.proxy, windows: [{ span: 18000, scoped: false, percent: 70, resetsAt: at(90) }, { span: 604800, scoped: true, name: 'Fable', percent: 1, resetsAt: null }] });
    assert.ok(await awaitRequest(c, 'providerproxy/anthropic', since));
    await expectScreen(c, tui, 160, 'recovered');
  } finally {
    await tui.kill();
    c.profile.dispose();
    await c.close();
  }
});

test('hidden until data: no line while nothing is configured or every account fails', async () => {
  const c = await startCase({
    kind: 'tui',
    proxyKey: false,
    grants: { anthropic: 'expired' },
    responses: { anthropic: ok([{ span: 18000, scoped: false, percent: 50, in: 60 }]) },
  });
  const tui = await boot(c, 160);
  try {
    await sleep(2500);
    await expectScreen(c, tui, 160, 'nothing usable', 3000);
    assert.equal(c.upstream.requests.length, 0, 'no key, expired sign-in: no request');
    c.setGrant('anthropic', 'valid');
    assert.ok(await awaitRequest(c, 'anthropic', 0));
    await expectScreen(c, tui, 160, 'sign-in refreshed');
  } finally {
    await tui.kill();
    c.profile.dispose();
    await c.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Generated campaign: random starting states and action sequences; the screen must equal the
// spec line after every action, on whichever screen (Launchpad or chat) the sequence is on.

const windowArb = fc.record({
  span: fc.constantFrom(18000, 18000, 604800, 604800, 86400),
  scoped: fc.constantFrom(false, false, false, true),
  name: fc.constantFrom('Fable', 'Opus', 'codex-spark'),
  percent: fc.integer({ min: 0, max: 100 }),
  in: fc.option(fc.integer({ min: 1, max: 9 * 1440 }), { nil: null }),
});
const responseArb = fc.oneof(
  { weight: 5, arbitrary: fc.array(windowArb, { minLength: 1, maxLength: 3 }).map((w) => ({ kind: 'ok', windows: w })) },
  { weight: 1, arbitrary: fc.constantFrom(401, 429, 500, 503).map((status) => ({ kind: 'status', status })) },
  { weight: 1, arbitrary: fc.constantFrom('<html>', '{}', 'null').map((body) => ({ kind: 'malformed', body })) },
  { weight: 1, arbitrary: fc.constant({ kind: 'hang' }) },
);
const materialize = (r) => (r.kind === 'ok' ? { kind: 'ok', windows: r.windows.map((w) => ({ ...w, resetsAt: at(w.in) })) } : r);
const actionArb = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('set'), account: fc.constantFrom(...ACCOUNTS.map((a) => a.id)), response: responseArb }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('grant'), account: fc.constantFrom('anthropic', 'openai-codex'), value: fc.constantFrom('valid', 'expired', 'absent') }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('resize'), cols: fc.integer({ min: 40, max: 220 }) }) },
  { weight: 2, arbitrary: fc.constant({ t: 'submit' }) },
  { weight: 1, arbitrary: fc.constant({ t: 'busy' }) },
  { weight: 1, arbitrary: fc.constant({ t: 'restart' }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('idle'), ms: fc.integer({ min: 800, max: 2500 }) }) },
);
const caseArb = fc.record({
  proxyKey: fc.constantFrom(true, true, true, false),
  grants: fc.record({ anthropic: fc.constantFrom('valid', 'expired', 'absent'), 'openai-codex': fc.constantFrom('valid', 'expired', 'absent') }),
  responses: fc.record(Object.fromEntries(ACCOUNTS.map((a) => [a.id, responseArb]))),
  cols: fc.integer({ min: 60, max: 220 }),
  actions: fc.array(actionArb, { minLength: 1, maxLength: 12 }),
});

const coverage = {};
const hit = (bucket) => { coverage[bucket] = (coverage[bucket] ?? 0) + 1; };

test('campaign: generated sequences keep the screen equal to the spec line after every step', { timeout: 6 * 3600_000 }, async () => {
  const options = fcOptions(3);
  console.log(`campaign seed=${options.seed} runs=${options.numRuns}`);
  await fc.assert(fc.asyncProperty(caseArb, async (k) => {
    const c = await startCase({ kind: 'tui', proxyKey: k.proxyKey, grants: k.grants, responses: Object.fromEntries(Object.entries(k.responses).map(([a, r]) => [a, materialize(r)])) });
    let cols = k.cols;
    let tui = await boot(c, cols);
    let screen = 'launchpad';
    let turns = 0;
    try {
      await expectScreen(c, tui, cols, `start (${screen})`);
      for (const [i, a] of k.actions.entries()) {
        const where = `step ${i} ${JSON.stringify(a)} (${screen})`;
        hit(`${a.t}:${screen}`);
        if (a.t === 'set') {
          const since = Date.now();
          c.upstream.set(a.account, materialize(a.response));
          hit(`response:${a.response.kind}`);
          const account = ACCOUNTS.find((x) => x.id === a.account);
          if (reachable(c, account)) await awaitRequest(c, a.account, since);
        } else if (a.t === 'grant') {
          const since = Date.now();
          c.setGrant(a.account, a.value);
          hit(`grant:${a.value}`);
          if (a.value === 'valid') await awaitRequest(c, a.account, since, 8000);
          else await sleep(1200);
        } else if (a.t === 'resize') {
          cols = a.cols;
          tui.resize(cols);
        } else if (a.t === 'submit') {
          await tui.submit(`prompt number ${i}`, { until: () => c.mock.turns().length > turns });
          turns = c.mock.turns().length;
          screen = 'chat';
          await tui.waitFor(/turn finished/);
        } else if (a.t === 'busy') {
          c.mock.hold(true);
          await tui.submit(`busy prompt ${i}`, { until: () => c.mock.turns().length > turns });
          turns = c.mock.turns().length;
          screen = 'chat';
          await expectScreen(c, tui, cols, `${where} while busy`);
          c.mock.hold(false);
          await sleep(600);
        } else if (a.t === 'restart') {
          await tui.kill();
          tui = await boot(c, cols);
          screen = 'launchpad';
          turns = c.mock.turns().length;
        } else if (a.t === 'idle') {
          const since = Date.now();
          await sleep(a.ms);
          for (const account of ACCOUNTS) {
            const n = c.upstream.requestsFor(account.id, since).length;
            assert.ok(n <= Math.ceil(a.ms / 700) + 2, `U5: ${n} requests for ${account.id} in ${a.ms} ms`);
          }
        }
        const row = await expectScreen(c, tui, cols, where);
        hit(row === null ? `hidden:${screen}` : `shown:${screen}`);
      }
      assert.equal(c.credentialsBytes(), c.lastCredentials, 'U12: sign-ins untouched');
      const logs = c.profile.logs();
      for (const secret of secretsOf(c)) assert.ok(!logs.includes(secret), 'U8: a secret reached the logs');
    } finally {
      c.mock.hold(false);
      await tui.kill();
      c.profile.dispose();
      await c.close();
    }
  }), options);
  console.log(`coverage ${JSON.stringify(coverage)}`);
});
