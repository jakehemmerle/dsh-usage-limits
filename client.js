window.__ModuleLoader__.load({
  id: '@local/dsh-usage-limits',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;

    const ROUTE = 'api/usage-limits';
    const POLL_MS = 60_000;
    const RADIUS = 5.5;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
    const P = 'usage-limits';
    const CSS = [
      `.${P}{flex:none;display:inline-flex}`,
      `.${P}__trigger{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}`,
      `.${P}__trigger:hover,.${P}__trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}`,
      `.${P}__track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:2px}`,
      `.${P}__fill{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:2px;stroke-linecap:round}`,
      `.${P}__trigger.${P}--warning,.${P}__trigger.${P}--warning:hover{color:var(--dsw-alias-state-warn-primary)}`,
      `.${P}__trigger.${P}--critical,.${P}__trigger.${P}--critical:hover{color:var(--dsw-alias-state-error-primary)}`,
      `.${P}--warning .${P}__fill{stroke:var(--dsw-alias-state-warn-primary)}`,
      `.${P}--critical .${P}__fill{stroke:var(--dsw-alias-state-error-primary)}`,
      `.${P}__panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(288px,100vw - 24px);max-height:calc(100vh - 24px);overflow-y:auto;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;position:fixed}`,
      `.${P}__provider+.${P}__provider{margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}`,
      `.${P}__header{align-items:baseline;gap:6px;display:flex}`,
      `.${P}__name{color:var(--dsw-alias-label-primary);font-weight:500}`,
      `.${P}__plan{color:var(--dsw-alias-label-tertiary);margin-left:auto}`,
      `.${P}__note{color:var(--dsw-alias-label-tertiary)}`,
      `.${P}__row{margin-top:8px}`,
      `.${P}__row-head{justify-content:space-between;align-items:center;gap:12px;display:flex}`,
      `.${P}__percent{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:500}`,
      `.${P}__bar{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:4px;margin:4px 0 2px;overflow:hidden}`,
      `.${P}__bar-fill{background:var(--dsw-alias-label-tertiary);border-radius:999px;min-width:2px;height:100%}`,
      `.${P}__bar-fill.${P}--warning{background:var(--dsw-alias-state-warn-primary)}`,
      `.${P}__bar-fill.${P}--critical{background:var(--dsw-alias-state-error-primary)}`,
      `.${P}__reset{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}`,
      `.${P}__footer{color:var(--dsw-alias-label-tertiary);margin-top:12px}`,
    ].join('');

    // The server renderer warns on useLayoutEffect; placement only matters with a DOM.
    const useClientLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;

    function createUsageStore() {
      let snapshot = { report: null };
      let pending = null;
      let retained = 0;
      let timer = null;
      let disposed = false;
      const listeners = new Set();

      function publish(report) {
        snapshot = { report };
        for (const listener of listeners) listener();
      }

      function load(refresh = false) {
        if (disposed || (pending !== null && !refresh)) return pending;
        const run = (async () => {
          try {
            const response = await fetch(refresh ? `${ROUTE}?refresh=1` : ROUTE, { headers: { accept: 'application/json' } });
            if (!response.ok) return;
            const report = await response.json();
            if (!disposed && report !== null && typeof report === 'object' && Array.isArray(report.providers)) publish(report);
          } catch {
            // Keep the last report; the next poll retries.
          } finally {
            if (pending === run) pending = null;
          }
        })();
        pending = run;
        return run;
      }

      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        load,
        refresh: () => load(true),
        retain() {
          retained += 1;
          if (retained === 1 && !disposed) {
            load();
            timer = setInterval(() => load(), POLL_MS);
          }
          let released = false;
          return () => {
            if (released) return;
            released = true;
            retained -= 1;
            if (retained === 0 && timer !== null) {
              clearInterval(timer);
              timer = null;
            }
          };
        },
        dispose() {
          disposed = true;
          if (timer !== null) clearInterval(timer);
          timer = null;
          listeners.clear();
        },
      };
    }

    function severityClass(severity) {
      return severity === 'warning' || severity === 'critical' ? ` ${P}--${severity}` : '';
    }

    function formatResetIn(ms) {
      if (ms <= 0) return 'resets now';
      const minutes = Math.floor(ms / 60_000);
      if (minutes < 1) return 'resets in <1m';
      if (minutes < 60) return `resets in ${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
      return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
    }

    function formatAgo(ms) {
      const minutes = Math.floor(Math.max(0, ms) / 60_000);
      if (minutes < 1) return 'just now';
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
    }

    function humanPlan(plan) {
      if (typeof plan !== 'string' || plan.length === 0) return null;
      const words = plan.replace(/[_-]+/g, ' ').trim();
      return words.charAt(0).toUpperCase() + words.slice(1);
    }

    function hasData(entry) {
      return entry.status === 'ok' || entry.status === 'stale';
    }

    function providerTop(entry) {
      if (!hasData(entry)) return null;
      return entry.windows.reduce((best, w) => (best === null || w.percent > best.percent ? w : best), null);
    }

    function summary(report) {
      return report.providers.map((entry) => {
        if (entry.status === 'signed-out') return `${entry.name} signed out`;
        if (entry.status === 'error') return `${entry.name} unavailable`;
        const top = providerTop(entry);
        return `${entry.name} ${top.label} ${top.percent}%`;
      }).join(', ');
    }

    function noteFor(entry, now) {
      if (entry.status === 'signed-out') return `Not signed in. Sign in to ${entry.name} in DSH to see plan usage.`;
      if (entry.status === 'error') return entry.reason;
      if (entry.status === 'stale') return `From ${formatAgo(now - entry.fetchedAt)}. ${entry.reason}`;
      return null;
    }

    function WindowRow({ window: w, now }) {
      return h('div', { className: `${P}__row` },
        h('div', { className: `${P}__row-head` },
          h('span', null, w.label),
          h('span', { className: `${P}__percent` }, `${w.percent}%`)),
        h('div', { className: `${P}__bar`, 'aria-hidden': true },
          h('div', { className: `${P}__bar-fill${severityClass(w.severity)}`, style: { width: `${w.percent}%` } })),
        w.resetsAt === null
          ? null
          : h('div', { className: `${P}__reset`, title: new Date(w.resetsAt).toLocaleString() }, formatResetIn(w.resetsAt - now)));
    }

    function UsagePanel({ report, now, panelRef, style }) {
      const fetched = report.providers.filter(hasData).map((entry) => entry.fetchedAt);
      const updated = fetched.length > 0 ? Math.max(...fetched) : report.generatedAt;
      return h('div', { ref: panelRef, className: `${P}__panel`, style, role: 'dialog', 'aria-label': 'Plan usage limits' },
        report.providers.map((entry) => {
          const plan = hasData(entry) ? humanPlan(entry.plan) : null;
          const note = noteFor(entry, now);
          return h('section', { key: entry.provider, className: `${P}__provider` },
            h('div', { className: `${P}__header` },
              h('span', { className: `${P}__name` }, entry.name),
              plan === null ? null : h('span', { className: `${P}__plan` }, plan)),
            note === null ? null : h('div', { className: `${P}__note` }, note),
            hasData(entry) ? entry.windows.map((w) => h(WindowRow, { key: w.id, window: w, now })) : null);
        }),
        h('div', { className: `${P}__footer` }, `Updated ${formatAgo(now - updated)}`));
    }

    function placeAbove(anchor, panel) {
      const margin = 12;
      const gap = 8;
      const a = anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const maxLeft = Math.max(margin, window.innerWidth - margin - width);
      const left = Math.min(Math.max(a.right - width, margin), maxLeft);
      let top = a.top - gap - height;
      if (top < margin) top = Math.max(margin, Math.min(a.bottom + gap, window.innerHeight - margin - height));
      return { left, top };
    }

    function createMeter(store) {
      return function UsageLimitsMeter() {
        const { report } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
        const [open, setOpen] = useState(false);
        const [position, setPosition] = useState(null);
        const rootRef = useRef(null);
        const panelRef = useRef(null);
        const visible = report !== null && report.providers.some((entry) => entry.status !== 'signed-out');

        useEffect(() => store.retain(), []);

        useEffect(() => {
          if (open) store.refresh();
        }, [open]);

        useEffect(() => {
          if (!visible && open) setOpen(false);
        }, [visible, open]);

        useEffect(() => {
          if (!open) return undefined;
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
          };
          const onPointerDown = (event) => {
            const target = event.target;
            if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
          };
          document.addEventListener('keydown', onKeyDown);
          document.addEventListener('pointerdown', onPointerDown, true);
          return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('pointerdown', onPointerDown, true);
          };
        }, [open]);

        useClientLayoutEffect(() => {
          if (!open) {
            setPosition(null);
            return undefined;
          }
          const update = () => {
            if (rootRef.current !== null && panelRef.current !== null) setPosition(placeAbove(rootRef.current, panelRef.current));
          };
          update();
          window.addEventListener('resize', update);
          window.addEventListener('scroll', update, true);
          return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
          };
        }, [open, report]);

        if (!visible) return null;
        const headline = report.headline;
        const percent = headline === null ? 0 : headline.percent;
        const label = `Plan usage: ${summary(report)}`;
        return h('span', { ref: rootRef, className: P },
          h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          h('button', {
            type: 'button',
            className: `${P}__trigger${headline === null ? '' : severityClass(headline.severity)}`,
            'aria-label': label,
            title: open ? undefined : label,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
          h('svg', { viewBox: '0 0 14 14', width: '14', height: '14', 'aria-hidden': true },
            h('circle', { className: `${P}__track`, cx: '7', cy: '7', r: RADIUS }),
            h('circle', {
              className: `${P}__fill`, cx: '7', cy: '7', r: RADIUS,
              strokeDasharray: `${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`,
              transform: 'rotate(-90 7 7)',
            })),
          h('span', null, headline === null ? 'Usage' : `${headline.name} ${headline.percent}%`)),
          open
            ? ReactDOM.createPortal(
              h(UsagePanel, { report, now: Date.now(), panelRef, style: position ?? { visibility: 'hidden', left: 0, top: 0 } }),
              document.body,
            )
            : null);
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const store = createUsageStore();
        ctx.effect(() => {
          store.load();
          return () => store.dispose();
        }, 'usage-limits: shared usage store');
        const Meter = createMeter(store);
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'usage-limits',
          order: 10,
        }, Meter));
      },
      createUsageStore,
      UsagePanel,
    };
  },
});
