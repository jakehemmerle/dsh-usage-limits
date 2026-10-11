// Real dsh web + headless Chromium (Playwright), mock model, mock usage endpoints.
// U2/U3/U4/U8/U9/U11/U12 on the web ring and panel; generated action sequences.
//
//   E2E_RUNS=20 SEED=1 node --test test/e2e/web.e2e.test.js
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import fc from 'fast-check';
import { chromium } from 'playwright';
import { startWeb, startTui, sleep } from '../rig/rig.mjs';
import { expectedHeadline, expectedLine, lineWindows, windowLabel, severity } from '../oracle/line.mjs';
import { ACCOUNTS } from './support/scenario.mjs';
import { startCase, observedAccounts, secretsOf, awaitRequest, reachable, fcOptions, MARGIN } from './support/e2e.mjs';

const SHOTS = process.env.SHOTS ?? '/tmp/dsh-usage-limits-shots';
const TRIGGER = 'button.usage-limits__trigger';
const MIN = 60_000;
const at = (minutes) => (minutes === null ? null : Date.now() + minutes * MIN + 30_000);
const ok = (windows) => ({ kind: 'ok', windows: windows.map((w) => ({ ...w, resetsAt: at(w.in ?? null) })) });

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); });

function configured(c) {
  return ACCOUNTS.filter((a) => (a.proxy ? c.state.proxyKey : c.state.grants[a.id] !== 'absent'));
}

/** What the trigger must read: headline text, `Usage`, or null (meter hidden). */
function expectedTrigger(c, now) {
  const headline = expectedHeadline(observedAccounts(c), now);
  if (headline !== null) return headline;
  return configured(c).length > 0 ? { text: 'Usage', severity: 'normal' } : null;
}

async function readTrigger(page) {
  const trigger = page.locator(TRIGGER);
  if ((await trigger.count()) === 0) return null;
  return { text: (await trigger.innerText()).trim(), className: await trigger.getAttribute('class') };
}

async function readPanel(page) {
  return page.locator('.usage-limits__panel').evaluate((panel) => [...panel.querySelectorAll('.usage-limits__provider')].map((section) => ({
    name: section.querySelector('.usage-limits__name')?.textContent ?? '',
    note: section.querySelector('.usage-limits__note')?.textContent ?? null,
    rows: [...section.querySelectorAll('.usage-limits__row')].map((row) => ({
      label: row.querySelector('.usage-limits__row-head span')?.textContent ?? '',
      percent: row.querySelector('.usage-limits__percent')?.textContent ?? '',
      critical: row.querySelector('.usage-limits__bar-fill')?.className.includes('--critical') ?? false,
      warning: row.querySelector('.usage-limits__bar-fill')?.className.includes('--warning') ?? false,
    })),
  })));
}

function panelMatches(panel, c, now) {
  const observed = observedAccounts(c);
  const names = panel.map((s) => s.name);
  const want = ACCOUNTS.map((a) => a.name);
  if (JSON.stringify(names) !== JSON.stringify(want)) return `sections ${JSON.stringify(names)}`;
  for (const section of panel) {
    const account = ACCOUNTS.find((a) => a.name === section.name);
    const data = observed.find((o) => o.id === account.id);
    if (!configured(c).includes(account)) {
      if (!/Not signed in/.test(section.note ?? '')) return `${section.name}: expected signed out`;
      continue;
    }
    if (!data) {
      if (section.rows.length !== 0) return `${section.name}: rows without data`;
      continue;
    }
    if (data.stale !== /^From /.test(section.note ?? '')) return `${section.name}: stale note ${section.note}`;
    const rows = data.windows.map((w) => {
      const passed = w.resetsAt !== null && w.resetsAt <= now;
      const p = passed ? 0 : w.percent;
      return { label: windowLabel(account, w), percent: `${p}%`, critical: severity(p) === 'critical', warning: severity(p) === 'warning' };
    });
    if (JSON.stringify(section.rows) !== JSON.stringify(rows)) return `${section.name}: rows ${JSON.stringify(section.rows)} != ${JSON.stringify(rows)}`;
  }
  return null;
}

async function assertNoSecrets(page, web, c) {
  const html = await page.content();
  const body = await (await web.fetch('/api/usage-limits')).text();
  for (const secret of secretsOf(c)) {
    assert.ok(!html.includes(secret), 'U8: secret in the DOM');
    assert.ok(!body.includes(secret), 'U8: secret in the route body');
  }
}

/** Refresh (open the panel = ?refresh=1, or reload) until trigger and panel equal the spec. */
async function expectWeb(c, page, web, where, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const now = Date.now();
    const want = expectedTrigger(c, now);
    const got = await readTrigger(page);
    if (want === null) {
      if (got === null) return;
      last = `trigger ${JSON.stringify(got)} but expected hidden`;
      await page.reload();
      await sleep(400);
      continue;
    }
    if (got === null) {
      last = 'no trigger';
      await page.reload();
      await sleep(600);
      continue;
    }
    await page.locator(TRIGGER).click();
    await page.locator('.usage-limits__panel').waitFor({ state: 'visible', timeout: 5000 });
    await sleep(350);
    const after = await readTrigger(page);
    const panel = await readPanel(page);
    const cls = want.severity === 'normal' ? null : `usage-limits--${want.severity}`;
    const classOk = cls === null ? !/usage-limits--(warning|critical)/.test(after.className) : after.className.includes(cls);
    const panelProblem = panelMatches(panel, c, Date.now());
    await page.keyboard.press('Escape');
    if (after.text === want.text && classOk && panelProblem === null) {
      await assertNoSecrets(page, web, c);
      return;
    }
    last = `trigger ${JSON.stringify(after)} want ${JSON.stringify(want)}; panel: ${panelProblem}`;
    await sleep(250);
  }
  throw new Error(`${where}: ${last}`);
}

async function open(c, { viewport = { width: 1280, height: 860 }, colorScheme = 'dark' } = {}) {
  const web = await startWeb(c.profile);
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  try {
    await page.goto(web.url);
    await page.waitForLoadState('networkidle').catch(() => {});
    // U5 liveness: the page's first report requests every reachable account (the log oracle alone
    // would accept a plugin that never fetches).
    for (const account of ACCOUNTS.filter((a) => reachable(c, a))) {
      assert.ok(await awaitRequest(c, account.id, 0, 10000), `U5: ${account.id} was never requested after the page loaded`);
    }
  } catch (error) {
    await context.close();
    await web.stop();
    c.profile.dispose();
    await c.close();
    throw error;
  }
  return { web, context, page, errors };
}

test('ring and panel: proxy accounts first, 50/80 thresholds, line-window headline; light, dark and touch layouts', async () => {
  mkdirSync(SHOTS, { recursive: true });
  const c = await startCase({
    kind: 'web',
    grants: { anthropic: 'valid', 'openai-codex': 'absent' },
    responses: {
      'providerproxy/anthropic': ok([{ span: 18000, scoped: false, percent: 1, in: 149 }, { span: 604800, scoped: false, percent: 29, in: 7000 }, { span: 604800, scoped: true, name: 'Fable', percent: 97, in: 7000 }]),
      'providerproxy/openai-codex': ok([{ span: 604800, scoped: false, percent: 52, in: 4000 }]),
      anthropic: ok([{ span: 18000, scoped: false, percent: 12, in: 51 }]),
    },
  });
  const before = c.credentialsBytes();
  const { web, context, page, errors } = await open(c);
  try {
    await expectWeb(c, page, web, 'dark desktop');
    assert.equal((await readTrigger(page)).text, 'Codex (proxy) 7d 52%');
    await page.locator(TRIGGER).click();
    await page.screenshot({ path: `${SHOTS}/panel-dark.png` });
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator(TRIGGER).click();
    await page.screenshot({ path: `${SHOTS}/panel-light.png` });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expectWeb(c, page, web, 'phone width');
    await page.screenshot({ path: `${SHOTS}/phone.png` });
    assert.deepEqual(errors, []);
    assert.equal(c.credentialsBytes(), before, 'U12');
  } finally {
    await context.close();
    await web.stop();
    c.profile.dispose();
    await c.close();
  }
});

test('U11: the web headline and the dst line agree for the same accounts', async () => {
  const responses = {
    'providerproxy/anthropic': ok([{ span: 18000, scoped: false, percent: 44, in: 100 }, { span: 604800, scoped: false, percent: 81, in: 5000 }]),
    'providerproxy/openai-codex': ok([{ span: 604800, scoped: false, percent: 81, in: 4000 }]),
  };
  const w = await startCase({ kind: 'web', responses });
  const t = await startCase({ kind: 'tui', responses });
  const { web, context, page } = await open(w);
  w.markStart();
  t.markStart();
  const tui = startTui(t.profile, { cols: 200, rows: 40 });
  try {
    await expectWeb(w, page, web, 'web');
    await tui.waitFor(/Claude \(proxy\) 5h/);
    const line = expectedLine(observedAccounts(t), Date.now(), 200 - MARGIN);
    const row = tui.capture().split('\n').find((r) => r.trim() === line.text);
    assert.ok(row, `dst shows ${line.text}`);
    const trigger = await readTrigger(page);
    const percents = [...row.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
    assert.equal(trigger.text, 'Claude (proxy) 7d 81%', 'tie → earlier account');
    assert.equal(Math.max(...percents), 81);
    assert.match(trigger.className, /usage-limits--critical/);
    const headlineAccounts = observedAccounts(w).map((a) => [a.name, lineWindows(a, Date.now()).map((x) => `${x.short} ${x.percent}`)]);
    const lineAccounts = observedAccounts(t).map((a) => [a.name, lineWindows(a, Date.now()).map((x) => `${x.short} ${x.percent}`)]);
    assert.deepEqual(headlineAccounts, lineAccounts);
  } finally {
    await tui.kill();
    await context.close();
    await web.stop();
    w.profile.dispose();
    t.profile.dispose();
    await w.close();
    await t.close();
  }
});

// ---------------------------------------------------------------------------------------------

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
  { weight: 1, arbitrary: fc.constant({ t: 'reload' }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('viewport'), width: fc.constantFrom(390, 820, 1280) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('idle'), ms: fc.integer({ min: 500, max: 2000 }) }) },
);
const caseArb = fc.record({
  proxyKey: fc.constantFrom(true, true, true, false),
  grants: fc.record({ anthropic: fc.constantFrom('valid', 'expired', 'absent'), 'openai-codex': fc.constantFrom('valid', 'expired', 'absent') }),
  responses: fc.record(Object.fromEntries(ACCOUNTS.map((a) => [a.id, responseArb]))),
  actions: fc.array(actionArb, { minLength: 1, maxLength: 12 }),
});

const coverage = {};
const hit = (bucket) => { coverage[bucket] = (coverage[bucket] ?? 0) + 1; };

test('campaign: generated sequences keep the ring and panel equal to the spec after every step', { timeout: 6 * 3600_000 }, async () => {
  const options = fcOptions(3);
  console.log(`campaign seed=${options.seed} runs=${options.numRuns}`);
  await fc.assert(fc.asyncProperty(caseArb, async (k) => {
    const c = await startCase({ kind: 'web', proxyKey: k.proxyKey, grants: k.grants, responses: Object.fromEntries(Object.entries(k.responses).map(([a, r]) => [a, materialize(r)])) });
    const { web, context, page, errors } = await open(c);
    try {
      await expectWeb(c, page, web, 'start');
      for (const [i, a] of k.actions.entries()) {
        const where = `step ${i} ${JSON.stringify(a)}`;
        hit(a.t);
        if (a.t === 'set') {
          hit(`response:${a.response.kind}`);
          c.upstream.set(a.account, materialize(a.response));
        } else if (a.t === 'grant') {
          hit(`grant:${a.value}`);
          c.setGrant(a.account, a.value);
          await sleep(400);
        } else if (a.t === 'reload') {
          await page.reload();
        } else if (a.t === 'viewport') {
          await page.setViewportSize({ width: a.width, height: 844 });
        } else if (a.t === 'idle') {
          const since = Date.now();
          await sleep(a.ms);
          for (const account of ACCOUNTS) {
            const n = c.upstream.requestsFor(account.id, since).length;
            assert.ok(n <= 2, `U5: ${n} requests for ${account.id} while the page sat idle ${a.ms} ms`);
          }
        }
        if (a.t === 'set' || a.t === 'grant') {
          const account = ACCOUNTS.find((x) => x.id === a.account);
          const since = Date.now();
          if (reachable(c, account) && (await readTrigger(page)) !== null) {
            await page.locator(TRIGGER).click();
            await page.keyboard.press('Escape');
            await awaitRequest(c, a.account, since, 8000);
          }
        }
        await expectWeb(c, page, web, where);
        hit(`trigger:${(await readTrigger(page))?.text === 'Usage' ? 'usage' : (await readTrigger(page)) === null ? 'hidden' : 'headline'}`);
      }
      assert.equal(c.credentialsBytes(), c.lastCredentials, 'U12: sign-ins untouched');
      assert.deepEqual(errors, [], 'no page errors');
      const logs = c.profile.logs();
      for (const secret of secretsOf(c)) assert.ok(!logs.includes(secret), 'U8: a secret reached the logs');
    } finally {
      await context.close();
      await web.stop();
      c.profile.dispose();
      await c.close();
    }
  }), options);
  console.log(`coverage ${JSON.stringify(coverage)}`);
});
