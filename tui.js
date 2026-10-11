/**
 * dst (dsh-TUI) half: one coloured status line above the prompt (SPEC.md "dst line").
 *
 * Registers a one-row rich status view (`ctx.tuiStatus.registerView`) whose component renders
 * lib/line.js segments with dsh-TUI's own Text. Data comes from the shared core (lib/source.js):
 * a refresh now, then every 60 s (each account still throttled by its own policy); a 30 s tick
 * re-renders countdowns without a request. With nix-config's launchpad-status patch the same view
 * also shows on the Launchpad. Rendering never fetches.
 */
import { accountsOf, timingOf } from './lib/accounts.js';
import { renderLine } from './lib/line.js';
import { createUsageSource } from './lib/source.js';

export const name = 'dsh-usage-limits-tui';
export const inject = ['tuiStatus'];
export const VIEW_KEY = 'usage-limits';
/** dsh-TUI's default page margin (`normal`: 2 columns each side), for the plain-text fallback only. */
const PAGE_MARGIN_COLUMNS = 4;
const FALLBACK_COLUMNS = 204;

const STYLE = {
  name: { bold: true },
  plain: {},
  dim: { dimColor: true },
  normal: { color: 'ansi256(28)' },
  warning: { color: 'ansi256(130)' },
  critical: { color: 'ansi256(160)' },
};

/** The latest report and the clock the line is drawn at; a tiny external store for the view. */
function createLineStore(now) {
  let snapshot = { report: null, now: now() };
  const listeners = new Set();
  return {
    get: () => snapshot,
    set(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createView(store) {
  return function UsageLine({ React, ui }) {
    const snap = React.useSyncExternalStore(store.subscribe, store.get, store.get);
    // dsh-TUI hands status views the content width: terminal columns minus its page margin (and a
    // split side panel), the same on the Launchpad and in chat.
    const { columns } = ui.useTerminalSize();
    const line = snap.report === null ? null : renderLine(snap.report, { now: snap.now, width: columns });
    if (line === null) return null;
    return React.createElement(ui.Box, { flexDirection: 'row', flexShrink: 0 },
      React.createElement(ui.Text, { wrap: 'truncate' },
        ...line.segments.map((segment, i) => React.createElement(ui.Text, { key: i, ...STYLE[segment.style] }, segment.text))));
  };
}

/**
 * @param deps - `{ fetch, now, setInterval?, clearInterval?, env? }`; tests inject a fake clock and timers.
 */
export function createTuiPlugin(deps) {
  const env = deps.env ?? (() => process.env);
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stop = deps.clearInterval ?? ((id) => clearInterval(id));

  function apply(ctx, config = {}) {
    const timing = timingOf(config);
    let credentials = null;
    const source = createUsageSource(accountsOf(config), {
      fetch: deps.fetch,
      now: deps.now,
      env,
      timeoutMs: timing.timeoutMs,
      readRecord: async (key) => (credentials === null ? undefined : credentials.readRecord(key)),
    });
    const store = createLineStore(deps.now);

    // Rich view first; if the host refuses it (row budget, key taken), plain status text instead.
    const disposeView = ctx.tuiStatus.registerView({ key: VIEW_KEY, maxRows: 1, component: createView(store) });
    if (disposeView === undefined) {
      store.subscribe(() => {
        const { report, now } = store.get();
        const columns = (process.stdout.columns || FALLBACK_COLUMNS) - PAGE_MARGIN_COLUMNS;
        const line = report === null ? null : renderLine(report, { now, width: columns });
        ctx.tuiStatus.set(VIEW_KEY, line === null ? undefined : line.text);
      });
    }

    let running = null;
    let again = false;
    function refresh() {
      if (source.disposed) return undefined;
      if (running !== null) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          try {
            const report = await source.report();
            if (!source.disposed) store.set({ report, now: deps.now() });
          } catch {
            // Keep the last line; the next poll retries.
          }
        } while (again && !source.disposed);
        running = null;
      })();
      return running;
    }

    // DSH's own sign-ins: optional; read them once the service is there, and refresh right away.
    ctx.inject(['credentials'], (inner) => {
      credentials = inner.get?.('credentials') ?? inner.credentials;
      refresh();
      inner.effect(() => () => { credentials = null; }, 'usage-limits: DSH sign-ins');
    });

    const poll = every(() => { refresh(); }, timing.pollMs);
    const tick = every(() => { store.set({ ...store.get(), now: deps.now() }); }, timing.tickMs);
    ctx.effect(() => () => {
      stop(poll);
      stop(tick);
      source.dispose(new Error('usage-limits plugin disposed'));
    }, 'usage-limits: poller, countdown tick and in-flight requests');

    refresh();
  }

  return { name, inject, apply };
}

export const { apply } = createTuiPlugin({
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
});
