/**
 * Web host half: `GET /api/usage-limits` → UsageReport (SPEC.md). A thin route over the shared
 * core (lib/source.js): every request refreshes whichever accounts their throttle allows, then
 * answers with the redacted report. The browser half (client.js) polls this route.
 */
import { accountsOf, timingOf } from './lib/accounts.js';
import { createUsageSource } from './lib/source.js';

export { DEFAULT_MIN_INTERVAL_MS, MIN_INTERVAL_FLOOR_MS, UPSTREAM_TIMEOUT_MS, DEFAULT_PROXY_KEY_ENV } from './lib/accounts.js';
export const ROUTE_PATH = '/api/usage-limits';
export const inject = ['connection', 'credentials'];

/**
 * Build the plugin around injectable seams. DSH loads the module-level `apply`, bound to the real
 * fetch and clock; tests build their own.
 * @param deps - `{ fetch, now, timeoutMs?, env? }`; `env()` returns the variables holding a proxy key.
 */
export function createPlugin(deps) {
  const env = deps.env ?? (() => process.env);

  function apply(ctx, config = {}) {
    const timing = timingOf(config);
    const source = createUsageSource(accountsOf(config), {
      fetch: deps.fetch,
      now: deps.now,
      env,
      timeoutMs: deps.timeoutMs ?? timing.timeoutMs,
      readRecord: (key) => ctx.credentials.readRecord(key),
    });

    ctx.effect(() => () => source.dispose(new Error('usage-limits plugin disposed')), 'usage-limits: in-flight upstream requests');

    ctx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      // `?refresh=1` is accepted but every read already refetches once the throttle allows it.
      fetch: async () => {
        let report;
        try {
          report = await source.report();
        } catch {
          report = source.fallback();
        }
        return new Response(JSON.stringify(report), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      },
    });
  }

  return { inject, apply };
}

export const { apply } = createPlugin({
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
});
