/** Placeholder dst half: loads, but shows nothing yet (see SPEC.md). */
export const name = 'dsh-usage-limits-tui';
export const inject = ['tuiStatus'];
export const VIEW_KEY = 'usage-limits';

export function createTuiPlugin() {
  return { name, inject, apply() {} };
}

export const { apply } = createTuiPlugin();
