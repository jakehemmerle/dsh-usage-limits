# Ralph loop state (dsh-usage-limits)

Loop: 3 rounds requested by Jake via the Team Lead (October 11, 2026). Work items are beads (`bd ready`,
epic `usage-epic`, steps `usage-s1`..`usage-s9`, bugs `usage-b*`). Every commit starts with `5.3 FLASH: `.

## Round protocol

1. `git pull --ff-only`; read this file; `bd ready` / `bd list`.
2. Work the highest-value ready beads to done with evidence (sha, command, result).
3. `bd export`, commit (only own paths), push. Bugs: red commit (failing test alone) then fix commit.
4. Budgets: fast properties >=1000 cases; real clients >=25 generated sequences per surface per round
   (round 3 release: >=100 per surface over >=3 seeds).
5. Report to the lead.

## Pinned versions

- dsh `0.2.1-alpha.2` (nix-dsh `f0ca0d745df8cbe99bad91d59153dbd690ae6660`, as in nix-config flake.lock).
- dsh-TUI `0.14.0` (nix-config `pkgs/dsh-tui.nix`) + `launchpad-status.patch`.
- nixpkgs-tools `b6c8664de9b6cc07fe5666a29f91884ba81197c4` (beads 1.3.0).

## Round 1 log

- usage-s1 source reconcile: runtime files, smoke test, fixtures and the Launchpad patch at `f1a2198` are
  byte-identical to nix-config `6a7e613` `pkgs/dsh-usage-limits/` and `pkgs/dsh-tui/launchpad-status.patch`
  (cmp). No sync needed.
- Baseline `NUM_RUNS=100 npm test`: 77/77 pass (host links: system dsh 0.2.1-alpha.2, fleet dsh-TUI 0.14.0).

- usage-b1 U13 red/fix: red 0dc5019 (normalize.properties fails 4/4, seed 521531315, NUM_RUNS=1000;
  re-verified in a worktree before the fix), fix 728c570 (toPercent drops the fraction scaling; route
  test corrected). Full fast suite 85/85 green, fail 0 skipped 0, NUM_RUNS=1000 (host links: system dsh
  0.2.1-alpha.2, fleet dsh-TUI 0.14.0).
- usage-s4 rig vendoring a6415ed: test/rig/upstream = nix-config 2d658d4 byte-identical (diff), rig.mjs =
  upstream + rig.local.patch, provenance test (drift, no ~/.agents, tmux -f /dev/null) green.
- usage-s2 SPEC audit: U1-U13 with oracles and surface columns; the README's "polls the route every
  minute" claim traced into SPEC's web section (client.js POLL_MS = 60_000).
- usage-s3 flake 21ee2c0: nix flake check all checks passed (package, fast 85/85 in sandbox at
  NUM_RUNS=1000, dsh-tui 0.14.0+launchpad-status with its own install check, devShell, e2e app).
- Round-1 e2e campaigns, E2E_RUNS=25 SEED=1 (dsh 0.2.1-alpha.2, flake-built dsh-TUI 0.14.0+launchpad-status
  /nix/store/vv97pr2y..., node 24.21.0, playwright npm 1.63.0 + nix browsers build 1243):
  dst tui.e2e 7/7 green (campaign 192.7 s); web web.e2e (result below).

## Round A log (resumed program, October 12, 2026)

- Real web e2e was blocked by dsh web's first-run flow: on a bare rig HOME, `xdg-user-dir DOCUMENTS`
  falls back to HOME itself and dsh refuses Documents == HOME, so the default workspace is never
  created and the hero shows the workspace chooser with no composer (open() timed out at
  composer.click). Fix in test/e2e/support/e2e.mjs: the rig profile now pins XDG_CONFIG_HOME inside
  the profile home with user-dirs.dirs pointing XDG_DOCUMENTS_DIR at <home>/Documents, so the default
  workspace lands in the disposable profile. Probes confirmed the composer renders and the suite's
  first two web tests went green.
- usage-s7: test/traceability.test.js (SPEC IDs U1..U13 must appear in TESTING.md's traceability
  table, rows must cite real test files, no .skip/.todo anywhere) + the table itself. Fast suite
  88/88 green, fail 0 skipped 0, NUM_RUNS=1000.
- usage-s8: mutants M7 (abort-listener cleanup removed in lib/source.js) and M8 (reset boundary
  <= -> < in lib/report.js) each killed by a named test (new test/source.leak.test.js; tui.host U6);
  lib/ restored byte-identical. Caught 8/8 cumulative (TESTING.md).
- Web campaign (E2E_RUNS=25 SEED=1, nix browsers 1243): result below.

## Gotchas

- `bd init` auto-commits and installs Codex/Claude/Cursor hooks plus `core.hooksPath`; those were removed
  (only AGENTS.md pointer kept). Do not re-run `bd init`.
- `bd create` refuses `--id` with `--parent`; use `--deps parent-child:usage-epic`.
- The nix build sandbox has no /usr/bin/env and no jq: the cmux-usage parity oracle needs
  `patchShebangs test/oracle/cmux-usage` and `pkgs.jq` in checks.fast's nativeBuildInputs.
- The ~/.cache/ms-playwright browsers (build 1248) belong to npm playwright 1.64; the repo pins 1.63.0
  (build 1243). Web e2e must set PLAYWRIGHT_BROWSERS_PATH to nixpkgs-tools' playwright-driver.browsers
  (the flake's e2e app exports it); a stale cache fails launch in milliseconds with "Executable
  doesn't exist".
- The edit tool in this harness intermittently rejects calls with "missing required property
  description"; scripted fs edits via node are the fallback.
