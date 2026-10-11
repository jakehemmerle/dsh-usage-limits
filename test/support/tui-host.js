// Host-runtime harness for the dst half: the plugin runs inside dsh-TUI's real TuiStatusRuntime
// (a cordis root, exactly as a cordis.patch.yml row inserts it), and its registered status view is
// rendered by dsh-TUI's own ink into a headless xterm, as Chat renders it above the prompt
// (same pointer-only kit: Box, Text, Image, useTerminalSize).
//
// Host packages resolve from test/.host (scripts/link-host.mjs): the dsh install's @deepseek-ai
// scope and the dsh-TUI package the profile mounts (DSH_TUI_DIR overrides).
process.env.FORCE_COLOR ??= '2';
import { PassThrough, Writable } from 'node:stream';
import xterm from '@xterm/headless';
import { createTuiPlugin, VIEW_KEY } from '../../tui.js';
import { bodyFor, accountById } from '../e2e/support/scenario.mjs';

const HOST = new URL('../.host/node_modules/', import.meta.url);
const TUI = new URL('@deepseek-harness-tui/dsh-tui/', HOST);
export const cordis = await import(new URL('@deepseek-ai/cordis/lib/index.js', HOST).href);
export const status = await import(new URL('lib/types/dsh-adapter/status.js', TUI).href);
const ui = await import(new URL('lib/types/ui.js', TUI).href);
const React = (await import(new URL('node_modules/react/index.js', TUI).href)).default;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const PROXY = 'http://proxy.test/v1';
export const UPSTREAM = { anthropic: 'http://up.test/api/oauth/usage', 'openai-codex': 'http://up.test/backend-api/wham/usage' };
export const PROXY_KEY = 'pp-test-key-0123456789';
export const TOKENS = { anthropic: 'sk-ant-oat-test-0123456789', 'openai-codex': 'eyJ-codex-test-0123456789' };

/** In-process stand-in for the four usage endpoints (same encodings as the e2e mock). */
export function fakeUpstream(clock) {
  const responses = new Map();
  const calls = [];
  const routes = {
    [`${PROXY}/usage/claude`]: 'providerproxy/anthropic',
    [`${PROXY}/usage/chatgpt`]: 'providerproxy/openai-codex',
    [UPSTREAM.anthropic]: 'anthropic',
    [UPSTREAM['openai-codex']]: 'openai-codex',
  };
  const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  async function fetch(input, init) {
    const request = new Request(input, init);
    const account = routes[request.url];
    calls.push({ account, url: request.url, authorization: request.headers.get('authorization'), at: clock.now() });
    await new Promise((resolve) => setImmediate(resolve));
    if (account === undefined) throw new TypeError(`unexpected upstream ${request.url}`);
    const r = responses.get(account) ?? { kind: 'status', status: 503 };
    if (r.kind === 'ok') return json(200, bodyFor(account, r.windows, clock.now()));
    if (r.kind === 'malformed') return json(200, r.body);
    if (r.kind === 'throw') throw new TypeError('fetch failed');
    return json(r.status, { error: { message: r.message ?? `Upstream failed (${r.status})` } });
  }
  return { fetch, calls, set: (account, r) => responses.set(account, r), callsFor: (a) => calls.filter((c) => c.account === a) };
}

export function makeClock(start) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; }, set: (v) => { value = v; } };
}

/** Fake setInterval/clearInterval: `fire(ms)` runs every live interval registered with that period. */
export function fakeIntervals() {
  const live = new Map();
  let next = 1;
  return {
    setInterval: (fn, ms) => { const id = next++; live.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { live.delete(id); },
    periods: () => [...live.values()].map((t) => t.ms).sort((a, b) => a - b),
    fire(ms) { for (const t of [...live.values()]) if (t.ms === ms) t.fn(); },
    get size() { return live.size; },
  };
}

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode() { return this; }
  ref() { return this; }
  unref() { return this; }
}

/**
 * Boot the plugin. `records` (or null for no credentials service) are DSH sign-in records.
 * Returns frame helpers over a `cols`-wide headless terminal.
 */
export async function bootTui({ config, records = null, cols = 160, clock, upstream, intervals, env = { PROVIDERPROXY_API_KEY: PROXY_KEY }, before } = {}) {
  const warnings = [];
  const root = new cordis.Context();
  root.on('internal/warning', (...args) => warnings.push(args.map(String).join(' ')));
  await root.plugin(status.TuiStatusRuntime);
  if (records !== null) {
    class Credentials extends cordis.Service {
      constructor(ctx) { super(ctx, 'credentials'); }
      async readRecord(key) { return records[key]; }
    }
    await root.plugin(Credentials);
  }
  if (before) await before(root);
  const plugin = createTuiPlugin({ fetch: upstream.fetch, now: clock.now, setInterval: intervals.setInterval, clearInterval: intervals.clearInterval, env: () => env });
  const fiber = root.plugin(plugin, config);
  await fiber;
  await sleep(0);
  const store = status.getHostStatusStore(root.get('tuiStatus'));

  const term = new xterm.Terminal({ cols, rows: 4, scrollback: 0, allowProposedApi: true });
  class Out extends Writable {
    columns = cols; rows = 4; isTTY = true;
    _write(chunk, _enc, cb) { term.write(String(chunk), cb); }
  }
  class Err extends Writable { isTTY = true; _write(_c, _e, cb) { cb(); } }
  const stdout = new Out();
  const kit = Object.freeze({ Box: ui.Box, Text: ui.Text, Image: ui.Image, useTerminalSize: ui.useTerminalSize });
  function Root() {
    const subscribe = React.useCallback((l) => store.subscribe(l), []);
    const views = React.useSyncExternalStore(subscribe, () => store.getViewSnapshot());
    const entries = React.useSyncExternalStore(subscribe, () => store.getSnapshot());
    return React.createElement(ui.ThemeProvider, { theme: 'dark' },
      React.createElement(ui.Box, { flexDirection: 'column' },
        ...views.map((view) => React.createElement(ui.Box, { key: view.key, flexDirection: 'column', flexShrink: 0, maxHeight: view.maxRows, overflow: 'hidden' },
          React.createElement(view.component, { React, ui: kit }))),
        entries.length > 0 ? React.createElement(ui.Text, { dimColor: true, wrap: 'truncate' }, entries.map((e) => e.text).join(' · ')) : null,
        React.createElement(ui.Text, null, '<<end>>')));
  }
  const app = await ui.render(React.createElement(Root), { stdout, stdin: new FakeStdin(), stderr: new Err(), exitOnCtrlC: false, patchConsole: false });

  const row = (y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '';
  /** The status line: every row above the <<end>> marker, joined (one row expected). */
  const line = () => {
    const rows = [];
    for (let y = 0; y < 4; y += 1) {
      const text = row(y);
      if (text.startsWith('<<end>>')) break;
      rows.push(text);
    }
    return rows;
  };
  /** Cells of row y as { ch, fg } where fg is a 256-colour index or null. */
  const cells = (y = 0) => {
    const l = term.buffer.active.getLine(y);
    const out = [];
    if (!l) return out;
    for (let x = 0; x < cols; x += 1) {
      const c = l.getCell(x);
      if (!c || c.getWidth() === 0) continue;
      out.push({ ch: c.getChars() || ' ', fg: c.isFgPalette() ? c.getFgColor() : null, bold: c.isBold() !== 0, dim: c.isDim() !== 0 });
    }
    return out;
  };
  async function quiet() {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    await sleep(30);
  }
  async function until(predicate, max = 2000) {
    const deadline = Date.now() + max;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(5);
    }
    throw new Error(`frame never satisfied predicate:\n${line().join('\n')}`);
  }
  return {
    root, fiber, store, warnings, line, cells, quiet, until, term,
    viewKeys: () => store.getViewSnapshot().map((v) => v.key),
    textEntries: () => store.getSnapshot(),
    resize(c) { term.resize(c, 4); stdout.columns = c; stdout.emit('resize'); },
    async unload() { await fiber.dispose?.(); await sleep(0); },
    async unmount() { app.unmount(); },
  };
}

export const KEY = VIEW_KEY;
export { accountById };
