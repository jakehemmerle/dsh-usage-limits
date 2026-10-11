# Agent instructions

- Work state lives in **beads** (`bd`, prefix `usage`): `bd ready`, `bd show <id>`, `bd close <id> --reason "<evidence>"`.
  `export.auto` is on; run `bd export` before committing so `.beads/issues.jsonl` is current. Commit the JSONL,
  never the Dolt database.
- Ralph-loop state and gotchas: [RALPH.md](RALPH.md). Product spec: [SPEC.md](SPEC.md). Evidence and
  traceability: [TESTING.md](TESTING.md). Releases: [RELEASING.md](RELEASING.md).
- Enter the environment with `nix develop`; fast suites: `npm test` (or `nix flake check`); real clients:
  `nix run .#e2e`.
- Tests never touch `~/.dsh`, `~/.dsh-tui`, port 3080 or the user's tmux server (`test/rig/rig.mjs`).
