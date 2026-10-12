// Install check for launchpad-status.patch (dsh-usage-limits): the Launchpad renders plugin status
// contributions (rich views and text entries) above its input card, a crashing view is contained,
// and Chat hands its status contributions to the Launchpad. Renders the real patched Launchpad
// through dsh-TUI's own ink. DSH_TUI_TYPES = <patched dsh-tui>/lib/types.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const types = process.env.DSH_TUI_TYPES;
assert.ok(types, 'Set DSH_TUI_TYPES to the patched dsh-tui lib/types directory');
const ui = await import(pathToFileURL(join(types, 'ui.js')).href);
const { Launchpad } = await import(pathToFileURL(join(types, 'screens/Launchpad.js')).href);
const React = (await import(pathToFileURL(join(types, '../../node_modules/react/index.js')).href)).default;

const kit = Object.freeze({ Box: ui.Box, Text: ui.Text, Image: ui.Image, useTerminalSize: ui.useTerminalSize });
const view = (key, component) => ({ key, maxRows: 1, registrationId: 1, component });
// The chrome a real dst Launchpad draws (whale art, big title, parameter row, four action chips,
// cwd and a three-kernel corner): it is what made the layout tight enough to squeeze the card.
const REAL_CHROME = {
  whale: true, permission: 'danger-full-access', preset: 'standard', cwd: '/private/tmp/work', tuiVersion: '0.14.0',
  actions: [
    { id: 'sessions', labelKey: 'launchpad-action-sessions-workspace' }, { id: 'settings', labelKey: 'launchpad-action-settings' },
    { id: 'backend', labelKey: 'launchpad-action-backend', values: { kernel: 'DSH' } }, { id: 'help', labelKey: 'launchpad-action-help' },
  ],
  kernels: [
    { id: 'dsh', label: 'DSH · dsh-core v0.2.1-alpha.2', current: true },
    { id: 'claude', label: 'Claude · Not installed · Enter to install', current: false },
    { id: 'codex', label: 'Codex · codex-cli v0.160.1 · Not signed in', current: false },
  ],
  onOpenWorkspace() {}, onKernelPick() {}, onAction() {},
};
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

async function renderLaunchpad(extra, { rows = 40, columns = 120 } = {}) {
  let out = '';
  const height = rows;
  const width = columns;
  class Out extends Writable { columns = width; rows = height; isTTY = true; _write(c, _e, cb) { out += String(c); cb(); } }
  class In extends PassThrough { isTTY = true; setRawMode() { return this; } ref() { return this; } unref() { return this; } }
  const errors = [];
  const app = await ui.render(React.createElement(ui.ThemeProvider, { theme: 'dark' }, React.createElement(Launchpad, {
    query: '', cursorOffset: 0, focusIndex: -1, isTerminalFocused: true, actions: [], firstRun: false, starred: false,
    model: 'mock-alpha', effort: 'medium', commands: [], statusViewUi: kit,
    onStatusViewError: (key, error) => errors.push([key, String(error)]),
    onSubmit() {}, onChange() {}, onFocusChange() {}, onCycleEffort() {}, onParamPick() {}, onCommandPick() {},
    ...extra,
  })), { stdout: new Out(), stdin: new In(), stderr: new Out(), exitOnCtrlC: false, patchConsole: false });
  await new Promise((resolve) => setTimeout(resolve, 300));
  app.unmount();
  return { text: strip(out), errors };
}

test('a status view and a text entry render above the Launchpad input card', async () => {
  const probe = view('probe', ({ React: R, ui: k }) => R.createElement(k.Text, null, 'PROBE-ON-LAUNCHPAD'));
  const { text } = await renderLaunchpad({ statusViews: [probe], statusEntries: [{ key: 'x', text: 'TEXT-ENTRY' }] });
  const probeAt = text.indexOf('PROBE-ON-LAUNCHPAD');
  const entryAt = text.indexOf('TEXT-ENTRY');
  const cardAt = text.indexOf('╭');
  assert.ok(probeAt >= 0, 'view rendered');
  assert.ok(entryAt > probeAt, 'text entries follow the views');
  assert.ok(cardAt > entryAt, 'both sit above the input card');
});

test('without contributions the Launchpad renders as before', async () => {
  const { text } = await renderLaunchpad({});
  assert.ok(text.includes('╭'), 'input card rendered');
});

test('a crashing view is contained by the status error boundary', async () => {
  const broken = view('broken', () => { throw new Error('boom'); });
  const fine = view('fine', ({ React: R, ui: k }) => R.createElement(k.Text, null, 'STILL-HERE'));
  const { text, errors } = await renderLaunchpad({ statusViews: [broken, fine] });
  assert.ok(text.includes('STILL-HERE'));
  assert.ok(text.includes('╭'));
  assert.equal(errors[0]?.[0], 'broken');
});

test('the input row survives: the layout budgets the status rows instead of squeezing the card', async () => {
  const probe = view('probe', ({ React: R, ui: k }) => R.createElement(k.Text, null, 'PROBE-ON-LAUNCHPAD'));
  for (const rows of [38, 30, 24]) {
    // The whale art and big title, as a real dst Launchpad draws them, make the layout tight.
    const { text } = await renderLaunchpad({ query: 'TYPED-QUERY', statusViews: [probe], ...REAL_CHROME }, { rows });
    assert.ok(text.includes('PROBE-ON-LAUNCHPAD'), `${rows} rows: view rendered`);
    assert.ok(text.includes('TYPED-QUERY'), `${rows} rows: the typed query is visible in the input card`);
  }
});

test('narrow terminals: the input row and parameter row survive, with and without a status line', async () => {
  const probe = view('probe', ({ React: R, ui: k }) => R.createElement(k.Text, null, 'PROBE'));
  for (const columns of [60, 72]) {
    for (const statusViews of [[], [probe]]) {
      const { text } = await renderLaunchpad({ query: 'TYPED-QUERY', statusViews, ...REAL_CHROME }, { rows: 38, columns });
      const where = `${columns} columns, ${statusViews.length} views`;
      assert.ok(text.includes('TYPED-QUERY'), `${where}: input row`);
      assert.ok(text.includes('mock-alpha'), `${where}: parameter row`);
    }
  }
});

test('Chat hands its status contributions to the Launchpad', async () => {
  const chat = await readFile(join(types, 'screens/Chat.js'), 'utf8');
  assert.match(chat, /_jsx\(Launchpad, \{ statusEntries: statusEntries, statusViews: statusViews, statusViewUi: STATUS_VIEW_UI, onStatusViewError:/);
});
