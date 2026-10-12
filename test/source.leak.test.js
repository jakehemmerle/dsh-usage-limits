// U10 supplement (usage-s8 mutant killer): a settled or timed-out fetch must leave NO abort
// listener on the source's lifetime signal - the abort-listener cleanup mutant (removing
// signal.removeEventListener in lib/source.js) leaks one listener per fetch and must fail here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsOf } from '../lib/accounts.js';
import { createUsageSource } from '../lib/source.js';

const NOW = 1_700_000_000_000;

function instrument() {
  const net = new Map();
  const add = AbortSignal.prototype.addEventListener;
  const remove = AbortSignal.prototype.removeEventListener;
  AbortSignal.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'abort') {
      const c = net.get(this) ?? { added: 0, removed: 0 };
      c.added += 1;
      net.set(this, c);
    }
    return add.call(this, type, fn, opts);
  };
  AbortSignal.prototype.removeEventListener = function (type, fn) {
    if (type === 'abort') {
      const c = net.get(this) ?? { added: 0, removed: 0 };
      c.removed += 1;
      net.set(this, c);
    }
    return remove.call(this, type, fn);
  };
  return { net, restore() { AbortSignal.prototype.addEventListener = add; AbortSignal.prototype.removeEventListener = remove; } };
}

function makeSource(fetch, timeoutMs) {
  return createUsageSource(
    accountsOf({ proxy: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'K', minIntervalMs: 400 } }),
    { fetch, now: () => NOW, env: () => ({ K: 'proxy-key-e2e' }), readRecord: null, timeoutMs },
  );
}

test('U10: a settled report leaves no abort listener on the lifetime signal', async () => {
  const { net, restore } = instrument();
  try {
    let calls = 0;
    const source = makeSource(async () => {
      calls += 1;
      return { ok: true, text: async () => JSON.stringify({}) };
    }, 5000);
    await source.report();
    const proxyAccounts = accountsOf({ proxy: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'K', minIntervalMs: 400 } }).filter((a) => a.proxy).length;
    assert.ok(calls >= proxyAccounts, 'the proxy accounts should have fetched');
    for (const [signal, c] of net) {
      assert.equal(c.removed, c.added, 'leaked abort listener after a settled report');
      assert.ok(!signal.aborted);
    }
    source.dispose();
    assert.ok(source.disposed);
  } finally {
    restore();
  }
});

test('U10: a timed-out fetch also cleans up its abort listener', async () => {
  const { net, restore } = instrument();
  try {
    const source = makeSource(() => new Promise(() => {}), 30);
    await source.report();
    for (const [, c] of net) {
      assert.equal(c.removed, c.added, 'leaked abort listener after a timed-out report');
    }
    source.dispose();
    assert.ok(source.disposed);
  } finally {
    restore();
  }
});
