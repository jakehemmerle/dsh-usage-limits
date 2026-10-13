// Budget gate (usage-b2): every fast property must derive its case count from NUM_RUNS, so the
// release budget in TESTING.md is real rather than shaped by hard-coded literals. NUM_RUNS comes
// from test/support/fc.js (fcOpts divides it by cost with a floor) and test/support/v2.js
// re-exports it. Real-client campaigns read E2E_RUNS instead and live under test/e2e/, which this
// gate deliberately does not scan. Also rejects a run-count environment variable whose default
// never references NUM_RUNS (HOST_RUNS/CMUX_RUNS style overrides must wrap a NUM_RUNS-derived
// budget, not replace it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GATE = 'budget.test.js';

const hardcodedRuns = new RegExp('numRuns' + String.raw`\\s*:` + String.raw`\\s*` + String.raw`\\d`);

test('every fast property derives its run count from NUM_RUNS (usage-b2)', () => {
  const offenders = [];
  for (const name of readdirSync(here)) {
    if (!name.endsWith('.test.js') || name === GATE) continue;
    const text = readFileSync(join(here, name), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (hardcodedRuns.test(line)) offenders.push(name + ':' + (i + 1) + ' hard-codes numRuns (' + line.trim() + ')');
    });
    const hasRunsEnv = /process\.env\.\w*RUNS\b/.test(text);
    if (hasRunsEnv && !text.includes('NUM_RUNS')) {
      offenders.push(name + ' drives a run-count env without deriving it from NUM_RUNS');
    }
  }
  assert.deepEqual(offenders, [], 'fast-suite budgets must scale with NUM_RUNS:\n' + offenders.join('\n'));
});
