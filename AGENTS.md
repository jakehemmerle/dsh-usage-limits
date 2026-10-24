# Agent instructions

- Work is tracked in the workspace Beads instance (`nx`, `~/ws/.beads`), label `project:dsh`.
  In the `~/ws/code/personal/<repo>` clone `bd` resolves there through `.beads/redirect`
  (written by `ws sync`); this repo has no Beads database of its own.
- Ralph-loop state and gotchas: [RALPH.md](RALPH.md). Product spec: [SPEC.md](SPEC.md). Evidence and
  traceability: [TESTING.md](TESTING.md). Releases: [RELEASING.md](RELEASING.md).
- Enter the environment with `nix develop`; fast suites: `npm test` (or `nix flake check`); real clients:
  `nix run .#e2e`.
- Tests never touch `~/.dsh`, `~/.dsh-tui`, port 3080 or the user's tmux server (`test/rig/rig.mjs`).
