// Harness baseline, independent of the feature: real dst shows a probe status view in chat (and on
// the Launchpad only with launchpad-status.patch), colours survive capture, env and credentials
// reach dsh, the mock upstream answers through the web route, and everything cleans up.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { startMockLlm } from '../rig/mock-llm.mjs';
import { makeProfile, startTui, startWeb } from '../rig/rig.mjs';
import { startMockUpstream } from './support/mock-upstream.mjs';
import { ROOT } from './support/e2e.mjs';

const PROBE = `${ROOT}test/e2e/support/probe-status.mjs`;
const patched = existsSync(process.env.DSH_TUI_DIR ?? '/nonexistent')
  && readFileSync(join(process.env.DSH_TUI_DIR, 'lib/types/screens/Launchpad.js'), 'utf8').includes('dsh-usage-limits launchpad-status');

test('harness: dst loads a probe view; it shows in chat with its colour, on the Launchpad only when patched', async () => {
  const mock = await startMockLlm({ script: () => ({ text: 'turn finished' }) });
  const p = makeProfile({ kind: 'tui', mock, plugins: [{ id: 'probe-status', name: PROBE, config: {} }], env: { PROBE_ENV: 'forwarded' } });
  const tui = startTui(p, { cols: 140, rows: 40 });
  try {
    assert.match((await p.dumpConfig()).stdout, /probe-status/);
    await tui.waitFor(/Mock Alpha|mock-alpha/, { timeout: 60000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(/PROBE-STATUS-VIEW/.test(tui.capture()), patched, `Launchpad shows the probe: ${patched}`);
    await tui.submit('hello', { until: () => mock.turns().length > 0 });
    await tui.waitFor(/turn finished/);
    await tui.waitFor(/PROBE-STATUS-VIEW/);
    const ansi = tui.captureAnsi().split('\n').find((r) => r.includes('PROBE-STATUS-VIEW'));
    assert.match(ansi, /\x1b\[38;5;130m/, 'tmux keeps the 256-colour index');
  } finally {
    await tui.kill();
    p.dispose();
    await mock.close();
  }
});

test('harness: the web route reaches the mock upstream with the forwarded proxy key', async () => {
  const mock = await startMockLlm();
  const upstream = await startMockUpstream({ proxyKey: 'pp-harness-key-123456' });
  upstream.set('providerproxy/anthropic', { kind: 'ok', windows: [{ span: 18000, scoped: false, percent: 7, resetsAt: Date.now() + 3600_000 }] });
  const p = makeProfile({
    kind: 'web', mock,
    plugins: [{ id: 'usage-limits', name: `${ROOT}index.js`, config: { proxy: { baseURL: upstream.proxyBaseURL, apiKeyEnv: 'USAGE_TEST_PROXY_KEY' } } }],
    env: { USAGE_TEST_PROXY_KEY: 'pp-harness-key-123456', PROVIDERPROXY_API_KEY: 'unused' },
    credentials: {},
  });
  const web = await startWeb(p);
  try {
    const report = await (await web.fetch('/api/usage-limits')).json();
    const claude = report.providers.find((x) => x.provider === 'providerproxy/anthropic');
    assert.equal(claude.status, 'ok');
    assert.equal(upstream.requestsFor('providerproxy/anthropic')[0].authorization, 'Bearer pp-harness-key-123456');
    assert.equal((await fetch(`${web.origin}/api/usage-limits`)).status, 401, 'route needs the session cookie');
    assert.ok(existsSync(p.credentialsFile));
  } finally {
    await web.stop();
    p.dispose();
    await upstream.close();
    await mock.close();
  }
});
