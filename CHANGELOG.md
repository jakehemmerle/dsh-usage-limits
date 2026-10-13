# Changelog

Releases follow Semantic Versioning 2.0.0; while the fleet's DSH is a prerelease
(`0.2.1-alpha.2`), the plugin version carries the matching `-alpha.N` channel (RELEASING.md).
Every entry cites the versions the full suites ran against and the shas of its red→fix pairs.

## 0.2.3-alpha.1 (2026-10-12)

First release cut under the new-dsh-plugin SemVer procedure. **PATCH-level**: the Anthropic
percentage fix is the only runtime change; everything else is test system and documentation.
Runtime commit at release: `b20d7e1` (lib/ last touched by `506fd48`/`8c10538`-equivalent state).

**Fixed**
- U13: Anthropic legacy utilization is a percentage, never a fraction — 0.9 shows 1 %, never
  90 %; 1.0 shows 1 % (red `0dc5019` → fix `506fd48`, bead `usage-b1`).

**Test system (no runtime change; the October 2026 Ralph loop, Jake's program)**
- Budget honesty (`usage-b2`): every fast property now derives its case count from `NUM_RUNS`
  through `test/support/fc.js` (cost/floor), enforced by the new `test/budget.test.js` gate —
  red `711751f` → fix `bd46b70`. Fast suites: 91/91 at `NUM_RUNS=1000` afterwards.
- Traceability honesty (`usage-b3`): `test/traceability.test.js` now fails on any TESTING.md
  test-file citation that does not exist; the U4/U5 timeout/backoff/late-discard behaviours the
  transfer table had attributed to a never-committed file are real generated properties in
  `test/source.properties.test.js` — red `c15b62b` → fix `b20d7e1`. Fast suites: 94/94 at
  `NUM_RUNS=1000` afterwards.
- Rig, flake and real-client suites from the same loop: vendored rig (`a6415ed`, provenance
  gate), flake.nix with checks and an e2e app (`21ee2c0`, `809feeb`), first-run workspace
  harness fix (`1437b21`), traceability gate + mutation campaign M7/M8 (`67ff8d7`), landing on
  94 fast tests with `usage-b1/b2/b3` red→fix pairs documented here.

**Release gate (dsh 0.2.1-alpha.2, dsh-TUI 0.14.0 + launchpad-status, node 24.21.0)**
- **Fast suites**: `NUM_RUNS=1000 SEED=7 npm test` - 94/94 pass, fail 0, skipped 0.
- **dst release campaign**: seeds 101, 202, 303, 404, 505 x 20 generated cases = **100 cases**;
  7/7 tests pass on every seed (5/5 seeds rc=0); transition coverage regenerates the historical
  release campaign's counters exactly (set 194: ok 120, status 24, malformed 28, hang 22;
  grant 101: valid 29, expired 32, absent 40; submit 111; busy 44; restart 59; resize 85;
  idle 53; line shown 506 steps / hidden 141).
- **dsh web release campaign**: same seeds and budget = **100 cases**; 3/3 tests pass on every
  seed (5/5 rc=0); coverage: set 297 (ok 189, status 30, malformed 35, hang 43), grant 151
  (valid 62, expired 43, absent 46), reload 79, viewport 67, idle 74; trigger headline 580 /
  Usage 72 / hidden 16.
- Replay: same `SEED` + `E2E_RUNS` regenerate every case; `FC_PATH` shrinks a failure.
- `nix flake check` (package, fast suite in the sandbox at `NUM_RUNS=1000`, patched dsh-tui
  install check) run green on the release state; versions above.

## 0.2.2 (2026-10-11)

Deployed to every DSH host via nix-config `2db2ca1` (before this repo had tags; see TESTING.md's
deployment table and installed-artifact checks).

- ProviderProxy conversations of the usage route now wait 35 s (the proxy allows its own upstream
  30 s and caches nothing for a caller that gave up); direct sign-in endpoints keep 10 s
  (`8c10538`; mock-timer regressions for both bounds). Found live on the personal Mac.
- Post-rollout fixes and deployment table (`f1a2198`).

## 0.2.1 (2026-10-11)

- The web headline breaks 5h/7d ties toward 5h, matching the dst line and SPEC (`66413bf`;
  regression `14adb44` + headline contract).

## 0.2.0 (2026-10-11)

The 0.2.0 line made dst a first-class surface so both clients show the same accounts:

- Spec red first: `ab3b6db` pins the dst line/U-tests while `tui.js`/`lib/line.js` were stubs.
- Shared usage core and report v2 aligned with omp (`c5a3391`); dst usage line above the prompt
  (`d3420bf`); Launchpad `launchpad-status` patch source + smoke suite (`421176f`); the
  Launchpad status row takes precedence over the input card (`9bc1586`); oracle width fixes
  (`59a6705`); U5 countdown-tick guard (`2f8f3d1`); 60-column Launchpad regression (`f07bc68`);
  installed-build e2e (`e161ccc`); green/release-campaign/mutation evidence (`f050c86`).

## 0.1.0 (2026-10-06)

- Initial web-only version: the ring meter + panel over the conversation composer dock, backed by
  ProviderProxy subscriptions and DSH's stored sign-ins (`b03737f`, `93f308e`).
