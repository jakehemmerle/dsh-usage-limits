// Contract: every host seam the plugin relies on, read from the installed dsh / dsh-TUI
// (test/.host, linked by scripts/link-host.mjs). A dsh or dsh-TUI bump that moves one of
// these fails here first, with the seam named.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const HOST = new URL('./.host/node_modules/', import.meta.url);
const TUI = new URL('@deepseek-harness-tui/dsh-tui/', HOST);
const read = (rel, base = TUI) => readFileSync(new URL(rel, base), 'utf8');

test('dsh-TUI: ./extensions exports TuiStatusRuntime and getHostStatusStore lives in status.js', async () => {
  const extensions = await import(new URL('lib/types/extensions.js', TUI).href);
  assert.equal(typeof extensions.TuiStatusRuntime, 'function');
  const status = await import(new URL('lib/types/dsh-adapter/status.js', TUI).href);
  assert.equal(typeof status.getHostStatusStore, 'function');
  const source = read('lib/types/dsh-adapter/status.js');
  assert.match(source, /registerView\(descriptor, identity\)/, 'registerView(descriptor, identity)');
  assert.match(source, /const MAX_VIEW_ROWS = 3;/);
  assert.match(source, /const KEY_PATTERN = \/\^\[a-z\]\[a-z0-9_-\]\*/, 'key pattern admits usage-limits');
  assert.match(source, /set\(key, text, identity\)/, 'set(key, text, identity) fallback');
});

test('dsh-TUI: Chat renders status views with the pointer-only kit { Box, Image, Text, useTerminalSize }', () => {
  const chat = read('lib/types/screens/Chat.js');
  assert.match(chat, /const STATUS_VIEW_UI = Object\.freeze\(\{\s*Box: StatusViewBox,\s*Image,\s*Text: StatusViewText,\s*useTerminalSize,\s*\}\);/);
  assert.match(chat, /statusViews\.map\(view =>/);
});

test('dsh-TUI: Text colours accept ansi256(n)', () => {
  const colorize = read('lib/types/ink/colorize.js');
  assert.match(colorize, /ANSI_REGEX = \/\^ansi256/);
});

test('dsh-TUI (patched): the Launchpad receives and renders status contributions (launchpad-status.patch)', () => {
  const launchpad = read('lib/types/screens/Launchpad.js');
  const chat = read('lib/types/screens/Chat.js');
  assert.match(launchpad, /dsh-usage-limits launchpad-status/, 'Launchpad.js carries the patch marker');
  assert.match(launchpad, /statusViews/, 'Launchpad takes statusViews');
  assert.match(chat, /statusViews: statusViews/, 'Chat passes its status views to the Launchpad');
});

test('dsh: credentials-local stores records in $DSH_HOME/.credentials.yaml and exposes readRecord', () => {
  const scope = new URL('@deepseek-ai/', HOST);
  const source = read('dsh-credentials-local/lib/index.js', scope);
  assert.match(source, /"\.credentials\.yaml"/);
  assert.match(source, /readRecord\(key\) \{/);
  assert.match(source, /if \(kind === "grant"\)/);
});

test('dsh: dsh-client-connection registers plugin fetch routes', () => {
  const scope = new URL('@deepseek-ai/', HOST);
  const source = read('dsh-client-connection/lib/index.js', scope);
  assert.match(source, /register\(/);
});

test('package: exports index, client and tui; the bundle patch inserts the web half', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'], './client.js');
  assert.equal(pkg.exports['./tui'], './tui.js');
  assert.ok(pkg.files.includes('tui.js'));
  assert.equal(pkg.dsh.client.platform, 'web');
});
