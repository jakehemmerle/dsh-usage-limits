// Shared e2e case harness: one isolated profile (rig), mock model, mock usage upstream and
// synthetic DSH sign-ins per generated case; an observation model that derives, from the mock's
// request log alone, what the spec says each client should show.
import { fileURLToPath } from 'node:url';
import { startMockLlm } from '../../rig/mock-llm.mjs';
import { makeProfile } from '../../rig/rig.mjs';
import { startMockUpstream } from './mock-upstream.mjs';
import { ACCOUNTS, grant, representable } from './scenario.mjs';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** Where the plugin entries load from: the repo, or an installed build (PLUGIN_DIR=/nix/store/…-dsh-usage-limits-0.2.0/). */
export const PLUGIN_DIR = process.env.PLUGIN_DIR ? `${process.env.PLUGIN_DIR.replace(/\/+$/, '')}/` : ROOT;
export const PROXY_ENV = 'USAGE_TEST_PROXY_KEY';
export const TIMING = { pollMs: 700, tickMs: 500, floorMs: 300, timeoutMs: 1500, maxBackoffMs: 1500 };
/** dsh-TUI's default page margin (`normal`: 2 columns each side): W = columns - 4 in a real dst. */
export const MARGIN = 4;

let serial = 0;

/**
 * A fresh case. `proxyKey`: whether the proxy key variable is set. `grants`: per local account
 * 'valid' | 'expired' | 'absent'. `responses`: initial mock answers per account.
 */
export async function startCase({ kind, proxyKey = true, grants = {}, responses = {}, entry } = {}) {
  serial += 1;
  const tag = `${process.pid}${serial}`;
  const secrets = {
    proxy: `pp-e2e-key-${tag}-ZZ9`,
    anthropic: `sk-ant-oat-e2e-${tag}-QQ7`,
    'openai-codex': `eyJ-e2e-codex-${tag}-WW3`,
  };
  const mock = await startMockLlm({ script: () => ({ text: 'turn finished' }) });
  const upstream = await startMockUpstream({ proxyKey: secrets.proxy, tokens: { anthropic: secrets.anthropic, 'openai-codex': secrets['openai-codex'] } });
  for (const [account, response] of Object.entries(responses)) upstream.set(account, response);
  const state = { proxyKey, grants: { anthropic: 'absent', 'openai-codex': 'absent', ...grants } };
  const records = () => recordsFor(state.grants, secrets);
  const profile = makeProfile({
    kind,
    mock,
    plugins: [{
      id: 'usage-limits',
      name: `${PLUGIN_DIR}${entry ?? (kind === 'tui' ? 'tui.js' : 'index.js')}`,
      // Production uses 300000 / 60000 (checked with a fake clock in tui.host.test.js); the real
      // clients here run on short intervals so a generated case finishes in seconds.
      config: {
        minIntervalMs: 400,
        proxy: { baseURL: upstream.proxyBaseURL, apiKeyEnv: PROXY_ENV, minIntervalMs: 400 },
        testing: { upstream: upstream.upstream, ...TIMING },
      },
    }],
    env: {
      // A value here stops the managed launcher from loading Jake's real ProviderProxy token.
      PROVIDERPROXY_API_KEY: 'unused-by-the-usage-tests',
      ...(proxyKey ? { [PROXY_ENV]: secrets.proxy } : {}),
    },
    credentials: records(),
    // The managed web profile acknowledges the preview notice the same way (home/dsh.nix).
    rows: kind === 'web' ? [{ id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general', config: { welcomeNoticeVersion: '2026-09-28.1' } }] : [],
  });
  const handle = {
    mock, upstream, profile, state, secrets,
    /** Requests before this time belong to an earlier (killed) process. */
    epoch: Date.now(),
    markStart() { this.epoch = Date.now(); },
    /** The credentials file exactly as the test last wrote it (the plugin must never change it). */
    lastCredentials: null,
    setGrant(account, value) {
      state.grants[account] = value;
      profile.setCredentials(records());
      this.lastCredentials = readCredentials(profile.credentialsFile);
    },
    credentialsBytes() { return readCredentials(profile.credentialsFile); },
    closed: false,
    async close() {
      if (this.closed) return;
      this.closed = true;
      await upstream.close();
      await mock.close();
    },
  };
  handle.lastCredentials = readCredentials(profile.credentialsFile);
  return handle;
}

function recordsFor(grants, secrets) {
  const out = {};
  for (const account of ACCOUNTS.filter((a) => !a.proxy)) {
    const value = grants[account.id];
    if (value === 'absent') continue;
    const expires = value === 'expired' ? Date.now() - 3600_000 : Date.now() + 8 * 3600_000;
    out[account.recordKey] = grant(account.id, { access: secrets[account.id], expires });
  }
  return out;
}

import { readFileSync } from 'node:fs';
/**
 * The DSH sign-in records (`llm-pi-ai/*`) in a credentials file, parsed, as a stable JSON string.
 * dsh itself adds other records (dsh web's browser session) and re-renders the YAML layout, so U12
 * compares these values, not the file's bytes. Each record is a flow map, which is valid JSON.
 */
function readCredentials(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const records = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^  (llm-pi-ai\/[\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let body = m[2];
    for (let j = i + 1; j < lines.length && /^\s{3,}/.test(lines[j]); j += 1) body += lines[j];
    records[m[1]] = JSON.parse(body);
  }
  return JSON.stringify(Object.keys(records).sort().map((k) => [k, records[k]]));
}

/** Whether the plugin can reach this account right now. */
export function reachable(c, account) {
  if (account.proxy) return c.state.proxyKey;
  return c.state.grants[account.id] === 'valid';
}

/** Accounts the spec says are shown (data-bearing), from the mock's request log. */
export function observedAccounts(c) {
  return ACCOUNTS.flatMap((account) => {
    const configured = account.proxy ? c.state.proxyKey : c.state.grants[account.id] !== 'absent';
    if (!configured) return [];
    const log = c.upstream.requestsFor(account.id, c.epoch);
    const lastOk = [...log].reverse().find((r) => r.outcome === 'ok');
    if (!lastOk) return [];
    const last = log[log.length - 1];
    const stale = last.outcome !== 'ok' || (!account.proxy && c.state.grants[account.id] === 'expired');
    return [{ ...account, stale, windows: representable(account.id, lastOk.windows) }];
  });
}

/** Every secret a case holds (tokens, refresh tokens, proxy key). */
export function secretsOf(c) {
  return [c.secrets.proxy, c.secrets.anthropic, `${c.secrets.anthropic}-refresh`, c.secrets['openai-codex'], `${c.secrets['openai-codex']}-refresh`];
}

/** Wait until the mock has answered a request for `account` after `since`. */
export async function awaitRequest(c, account, since, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (c.upstream.requestsFor(account, since).length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export function fcOptions(defaultRuns) {
  const seed = process.env.SEED === undefined ? Date.now() % 2147483647 : Number(process.env.SEED);
  const runs = Number(process.env.E2E_RUNS ?? defaultRuns);
  return { seed, numRuns: runs, endOnFailure: true, verbose: 2, ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}) };
}
