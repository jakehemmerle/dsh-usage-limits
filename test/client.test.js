import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mountHost, fixture, reply, signedInRecords, NOW0, ANTHROPIC_KEY, CODEX_KEY } from './support/host.js';

const nodeRequire = createRequire(import.meta.url);
const LOADER_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
]);
const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/**
 * Evaluate client.js the way the Web shell does: a classic script calling
 * `window.__ModuleLoader__.load`, whose factory only gets the loader's `require`.
 */
function loadClient(browserFetch, timers = {}) {
  const loaded = [];
  const sandbox = {
    __ModuleLoader__: { load: (definition) => loaded.push(definition) },
    fetch: browserFetch,
    setInterval: timers.setInterval ?? (() => 0),
    clearInterval: timers.clearInterval ?? (() => {}),
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });
  assert.equal(loaded.length, 1);
  const [definition] = loaded;
  const required = [];
  const module = definition.factory((id) => {
    required.push(id);
    if (!LOADER_MODULES.has(id)) throw new Error(`module loader cannot resolve ${id}`);
    return nodeRequire(id);
  });
  return { definition, module, required };
}

function fakeClientCtx() {
  const registrations = [];
  const disposers = [];
  return {
    registrations,
    dispose: () => disposers.splice(0).forEach((d) => d()),
    slots: {
      inject(owner, install) {
        assert.equal(owner, 'conversation.composer.dock');
        const dispose = install();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
    effect(execute) {
      const dispose = execute();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => dispose?.();
    },
  };
}

/** The browser's document-relative `fetch("api/...")`, answered by the real Host route. */
function browserFetchOver(host) {
  const calls = [];
  const fetch = async (input) => {
    calls.push(String(input));
    const response = await host.route.fetch(new Request(new URL(String(input), 'http://127.0.0.1:3080/')));
    return response;
  };
  return { fetch, calls };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function triggerOf(markup) {
  const match = /<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/s.exec(markup);
  assert.ok(match, `no trigger button in ${markup}`);
  return { className: match[1], text: match[2].replace(/<[^>]+>/g, '').trim(), tag: match[0] };
}

async function renderDock(host) {
  const browser = browserFetchOver(host);
  const { definition, module, required } = loadClient(browser.fetch);
  const ctx = fakeClientCtx();
  module.apply(ctx);
  await settle();
  const [registration] = ctx.registrations;
  return { markup: renderToStaticMarkup(React.createElement(registration.component, {})), registration, browser, definition, module, required, ctx };
}

test('client: registers one dock entry beside the context meter and requires only loader modules', async () => {
  const { registration, definition, module, required } = await renderDock(mountHost());
  assert.equal(definition.id, '@local/dsh-usage-limits');
  assert.deepEqual([...module.inject], ['slots']);
  assert.deepEqual(
    { name: registration.options.name, id: registration.options.id, order: registration.options.order },
    { name: 'conversation.composer.dock', id: 'usage-limits', order: 10 },
  );
  assert.ok(required.every((id) => LOADER_MODULES.has(id)));
});

test('client: the fixture-derived report renders the trigger "Claude 8%"', async () => {
  const { markup, browser } = await renderDock(mountHost());
  const trigger = triggerOf(markup);
  assert.equal(trigger.text, 'Claude 8%');
  assert.match(trigger.tag, /aria-haspopup="dialog"/);
  assert.match(trigger.tag, /aria-label="[^"]*Claude 5-hour 8%[^"]*Codex Weekly 0%[^"]*"/);
  assert.doesNotMatch(trigger.className, /--(warning|critical)/);
  assert.ok(browser.calls.every((url) => url.startsWith('api/usage-limits')));
});

test('client: Codex at 91% headlines as "Codex 91%" with the critical class', async () => {
  const codex = JSON.parse(fixture('codex-wham-usage.json'));
  codex.rate_limit.primary_window.used_percent = 91;
  const host = mountHost({
    upstream: {
      anthropic: () => reply(200, fixture('anthropic-oauth-usage.json')),
      'openai-codex': () => reply(200, JSON.stringify(codex)),
    },
  });
  const trigger = triggerOf((await renderDock(host)).markup);
  assert.equal(trigger.text, 'Codex 91%');
  assert.match(trigger.className, /usage-limits--critical/);
});

test('client: renders nothing until the first report arrives', async () => {
  const { module } = loadClient(() => new Promise(() => {}));
  const ctx = fakeClientCtx();
  module.apply(ctx);
  await settle();
  assert.equal(renderToStaticMarkup(React.createElement(ctx.registrations[0].component, {})), '');
});

test('client: renders nothing when every provider is signed out', async () => {
  const records = signedInRecords();
  delete records[ANTHROPIC_KEY];
  delete records[CODEX_KEY];
  const { markup } = await renderDock(mountHost({ records }));
  assert.equal(markup, '');
});

test('client: the popover lists every window with relative resets, absolute titles, and freshness', async () => {
  const host = mountHost();
  const report = (await host.get()).body;
  const { module } = loadClient(async () => reply(200, '{}'));
  const markup = renderToStaticMarkup(React.createElement(module.UsagePanel, { report, now: NOW0 }));
  assert.match(markup, /role="dialog"/);
  for (const expected of ['Claude', 'Codex', 'Weekly (Fable)', 'resets in 4h 0m', 'resets in 6d 23h', 'resets in 6d 2h', 'Updated just now']) {
    assert.ok(markup.includes(expected), `missing ${expected}`);
  }
  assert.ok(markup.includes(`title="${new Date(1791313200219).toLocaleString()}"`));
  const later = renderToStaticMarkup(React.createElement(module.UsagePanel, { report, now: NOW0 + 7 * 60_000 }));
  assert.ok(later.includes('Updated 7m ago'));
});

test('client: one shared store polls every 60 s while any trigger is mounted and refreshes on open', async () => {
  const intervals = [];
  const cleared = [];
  const browserCalls = [];
  const { module } = loadClient(async (url) => {
    browserCalls.push(String(url));
    return reply(200, '{}');
  }, {
    setInterval: (fn, ms) => { intervals.push(ms); return intervals.length; },
    clearInterval: (id) => cleared.push(id),
  });
  const store = module.createUsageStore();
  const releaseA = store.retain();
  const releaseB = store.retain();
  assert.deepEqual(intervals, [60_000]);
  await settle();
  assert.equal(browserCalls.filter((u) => u === 'api/usage-limits').length, 1);
  releaseA();
  assert.deepEqual(cleared, []);
  releaseB();
  assert.deepEqual(cleared, [1]);
  store.refresh();
  await settle();
  assert.ok(browserCalls.includes('api/usage-limits?refresh=1'));
});
