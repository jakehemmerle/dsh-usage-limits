// Shared fast-check budget and replay options for the fast suites.
//   NUM_RUNS  cases per property (default 1000; the skill's fast-property floor)
//   FC_SEED   replay seed (SEED is accepted as an alias); a random seed is drawn and printed otherwise
//   FC_PATH   shrink path to replay together with FC_SEED
// Every property prints "[fc] <name> seed=<n> runs=<n>" so a failing run can be replayed.
import fc from 'fast-check';

const raw = process.env.FC_SEED ?? process.env.SEED;
export const SEED = raw === undefined ? (Date.now() ^ (process.pid << 8)) % 2147483647 : Number(raw);
export const NUM_RUNS = Number(process.env.NUM_RUNS ?? 1000);

/**
 * Options for one property. `cost` divides the run budget for properties that do real I/O per case
 * (never below `floor`); pass `{ cost: 1 }` for pure properties.
 */
export function fcOpts(name, { cost = 1, floor = 1, ...rest } = {}) {
  const numRuns = Math.max(floor, Math.round(NUM_RUNS / cost));
  console.log(`[fc] ${name} seed=${SEED} runs=${numRuns}${process.env.FC_PATH ? ` path=${process.env.FC_PATH}` : ''}`);
  return { numRuns, seed: SEED, verbose: 1, ...(process.env.FC_PATH ? { path: process.env.FC_PATH } : {}), ...rest };
}

export { fc };
