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

## Gotchas

- `bd init` auto-commits and installs Codex/Claude/Cursor hooks plus `core.hooksPath`; those were removed
  (only AGENTS.md pointer kept). Do not re-run `bd init`.
- `bd create` refuses `--id` with `--parent`; use `--deps parent-child:usage-epic`.
