import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertReport } from './support/contract.js';
import { mountHost, NOW0 } from './support/host.js';

test('fixtures: the recorded Anthropic and Codex payloads produce these exact windows', async () => {
  const host = mountHost();
  const { status, body } = await host.get();
  assert.equal(status, 200);
  assertReport(body);
  assert.deepEqual(body, {
    generatedAt: NOW0,
    providers: [
      {
        provider: 'anthropic',
        name: 'Claude',
        status: 'ok',
        plan: null,
        fetchedAt: NOW0,
        windows: [
          { id: 'session', label: '5-hour', percent: 8, resetsAt: 1791313200219, severity: 'normal' },
          { id: 'weekly_all', label: 'Weekly', percent: 2, resetsAt: 1791900000219, severity: 'normal' },
          { id: 'weekly_scoped:fable', label: 'Weekly (Fable)', percent: 0, resetsAt: 1791900000000, severity: 'normal' },
        ],
      },
      {
        provider: 'openai-codex',
        name: 'Codex',
        status: 'ok',
        plan: 'self_serve_business_prolite',
        fetchedAt: NOW0,
        windows: [
          { id: 'rate:604800', label: 'Weekly', percent: 0, resetsAt: 1791825776000, severity: 'normal' },
        ],
      },
    ],
    headline: { provider: 'anthropic', name: 'Claude', label: '5-hour', percent: 8, severity: 'normal' },
  });
});

test('fixtures: the Anthropic legacy windows yield the same session and weekly readings when limits[] is absent', async () => {
  const { readFileSync } = await import('node:fs');
  const payload = JSON.parse(readFileSync(new URL('./fixtures/anthropic-oauth-usage.json', import.meta.url), 'utf8'));
  delete payload.limits;
  const host = mountHost({
    upstream: {
      anthropic: () => new Response(JSON.stringify(payload), { status: 200 }),
      'openai-codex': () => new Response('{}', { status: 200 }),
    },
  });
  const { body } = await host.get();
  assert.deepEqual(body.providers[0].windows, [
    { id: 'five_hour', label: '5-hour', percent: 8, resetsAt: 1791313200219, severity: 'normal' },
    { id: 'seven_day', label: 'Weekly', percent: 2, resetsAt: 1791900000219, severity: 'normal' },
  ]);
});
