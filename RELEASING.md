# Releasing dsh-usage-limits

This repo follows the new-dsh-plugin skill's `references/release.md`: Semantic Versioning 2.0.0
on DSH's own prerelease-channels scheme. Run every step; a failing or skipped required suite
blocks the release, and there is no bypass.

1. **Clean board.** `git pull --ff-only`, read `bd ready`/`bd list`; close or defer every open
   release-blocking bead.
2. **Complete gate** against the pinned DSH/dsh-TUI of `flake.lock`:
   1. `nix flake check` — package smoke, the fast suite in the sandbox at `NUM_RUNS=1000`, and
      the flake's dsh-tui build (launchpad-status patch applied, install check rendering the real
      Launchpad must pass at 60/72/200 columns).
   2. `NUM_RUNS=1000 npm test` on the host (47 fast files; `fail 0`, `skipped 0`, `FC_SEED`/`SEED`
      recorded, every property budget `NUM_RUNS`-derived per `test/budget.test.js`).
   3. **Real-client release campaigns** through `nix run .#e2e` (fresh isolated rig profile per
      case, private tmux socket/ports, mock model and mock usage endpoints):
      ```
      for seed in 101 202 303 404 505; do E2E_RUNS=20 SEED=$seed nix run .#e2e -- tui; done   # dst, real dsh-TUI
      for seed in 101 202 303 404 505; do E2E_RUNS=20 SEED=$seed nix run .#e2e -- web; done  # dsh web + headless Chromium
      ```
      Budget: ≥100 generated cases per surface over ≥5 recorded seeds (short and long sequences,
      invariants after every step). Every seed is replayable: same `SEED` + `E2E_RUNS`, shrink path
      via `FC_PATH`. Record per-seed results, transition coverage and versions in TESTING.md.
3. **SemVer bump.** `package.json` `version` (the flake derives the package version from it).
   - While DSH stays on a prerelease, keep the plugin on the matching channel: `-alpha.N` against a
     dsh alpha, `-rc.N` against a rc; drop the suffix only after full suites pass on a stable DSH.
   - PATCH = bug fix without new capability; MINOR = new capability; MINOR (SemVer allows) instead
     of MAJOR for incompatible changes while `0.x`.
   - Peer versions: this plugin imports **no** `@deepseek-ai/*` package at runtime — it mounts
     through `cordis.patch.yml` + `dsh.client.inject` and the `tuiStatus` seam, so it declares **no
     peerDependencies** (see package.json) and test/contract.test.js pins those seams instead.
     If a real import appears, pin it exactly to the DSH build the full suites passed against
     (never `^`/`~` against prereleases: npm and DSH disagree on prerelease range matching).
4. **CHANGELOG.md** entry: version, date, changes (each red→fix pair by commit sha), the exact
   dsh and dsh-TUI versions tested, the tested commit, and the gate evidence (seeds, counts, pass).
5. **Tag and push.** Commit `5.3 FLASH: release: vX.Y.Z`, create an annotated tag `vX.Y.Z` on that
   commit, push commit + tag (`git push origin main --follow-tags`).
6. **Consumers pin tags.** nix-config vendors `pkgs/dsh-usage-limits` with a revision-pinned input;
   installation and per-host verification follow the skill's rollout.md: local install, Jake's
   acceptance, then fleet sync (never let `sync-hosts.ts` pick unrelated newer main).

Released pairs recorded here (older pairs live in TESTING.md's installed-artifact history):

| plugin | released | dsh tested | dsh-TUI tested | commit |
|---|---|---|---|---|
| 0.2.2 | 2026-10-11 | 0.2.1-alpha.2 | 0.14.0 + launchpad-status | `8c10538` (deployed nix-config `2db2ca1`; predates tags) |
| 0.2.3-alpha.1 | 2026-10-12 | 0.2.1-alpha.2 | 0.14.0 + launchpad-status | see CHANGELOG |
