// Harness probe: the smallest dsh-TUI status view. Proves the rig, host status seam, colour
// capture and Launchpad/chat placement independently of dsh-usage-limits.
export const name = 'probe-status';
export const inject = ['tuiStatus'];

export function apply(ctx, config = {}) {
  ctx.tuiStatus.registerView({
    key: 'probe-status',
    maxRows: 1,
    component: ({ React, ui }) => React.createElement(ui.Text, { color: 'ansi256(130)' }, config.text ?? 'PROBE-STATUS-VIEW'),
  });
}
