# Testing dsh-usage-limits

Product properties U1–U12 are defined in [SPEC.md](SPEC.md). Every applicable property runs through
the real clients: a real `dst` (dsh-TUI) process in a private tmux socket and a real `dsh web` in
headless Chromium (Playwright), both against a mock model and a mock usage upstream. Faster layers
supplement them.

## Reference tests transferred from omp

Pinned omp `4ef97c8` (`packages/coding-agent/test`, `packages/ai/test`) and Jake's
`~/.config/cmux/usage/cmux-usage` (October 5, 2026). The omp tests drive components with in-memory
settings and fake usage providers; none spawns a terminal or a provider endpoint. The DSH tests below
add those boundaries.

| Product property | Reference test | What it proves / bypasses | DSH test |
|---|---|---|---|
| U1 format, U2 colours | `cmux-usage bars` (`bar`, `dur`, `ansi`) | The exact line Jake used; no product tests of its own | `test/oracle.cmux.test.js`: the real script (stub `omp`) vs the plugin's line on generated reports; tier 0 text and colour codes equal |
| U2 | `status-line-usage.test.ts` "uses a distinct error color at the eighty-percent threshold" | Theme colour choice in a rendered segment; no terminal | `test/tui.host.test.js` severity at 49/50/79/80; e2e SGR check |
| U1, U3 | "maps non-canonical window ids onto subscription windows by reported span", "prefers canonical window ids over a conflicting reported span", "ignores non-canonical windows without a reported span" | Normalizer mapping | `test/line.properties.test.js` span → 5h/7d; spanless and scoped windows never on the line |
| U3 | "hides null usage", "hides usage without visible windows", "renders five-hour usage without seven-day usage" | Segment visibility | Host-runtime + e2e: hidden with no data; 5h-only account |
| U5 | `status-line-usage-refresh.test.ts` "does not invoke usage fetching synchronously on the render path" | Fetch scheduling in the component | Host-runtime: renders and ticks cause no fetch; e2e request counts during resize/idle |
| U4, U5 | "backs off after the startup timeout when usage fetching hangs", "applies late usage reports that resolve after the startup timeout", "discards a timed-out report after a newer refresh applies" | Timeout/back-off/late-result ordering with fake timers | `test/source.properties.test.js` (fc.commands, fake clock): hung fetch times out, back-off, no stale overwrite |
| U3 | `openai-codex-usage.test.ts` "emits primary + secondary limits", "surfaces additional_rate_limits" | Payload parsing | Fixture tests: 5h+7d Codex on the line; additional limits only in the panel |
| U4 | `auth-storage-usage-cache.test.ts` "serves last-good value through a failure cycle", "caches null on a cold failure for the backoff window, then retries", "waits a minute before re-polling Claude usage after a 429", "shares an in-flight failure across … concurrent usage consumers" | Cache policy with an in-memory store | Existing `throttle`/`route` properties extended to proxy accounts; e2e failure → stale → recovery |
| U4 | `claude-usage-endpoint.test.ts` "falls back when … 200 with an SPA index page / empty body" | Endpoint fallback | Generated malformed 200 bodies never replace good data (fast + e2e) |

## Layers and commands

| Layer | Files | Command |
|---|---|---|
| Fast properties and examples (pure + plugin-level with fake I/O) | `test/*.test.js` | `npm test` |
| Host runtime: plugin in dsh-TUI's real `TuiStatusRuntime`, rendered by dsh-TUI's ink into `@xterm/headless` | `test/tui.host.test.js` | `npm test` (links host packages via `scripts/link-host.mjs`) |
| Contract: host seams, exports, payload fixtures | `test/contract.test.js` | `npm test` |
| Real `dst` e2e and generated campaign | `test/e2e/tui.e2e.test.js` | `npm run test:e2e:tui` |
| Real web e2e and generated campaign | `test/e2e/web.e2e.test.js` | `npm run test:e2e:web` |

Environment: `DSH_TUI_DIR` selects the dsh-TUI build (the patched build for Launchpad tests);
`NUM_RUNS`, `E2E_RUNS` and `SEED` control fast-check budgets; failures print seed and path.

## Budgets

- Fast properties: 1,000 runs each (`NUM_RUNS`).
- Real-client campaigns: 100 generated cases per surface over 5 recorded seeds (20 each), sequences
  of 1–12 actions; each case uses a fresh isolated profile. Iteration uses `E2E_RUNS=3`.
- Flake check: each e2e file 5 times in a row at the iteration budget.
- Mutations: at least 3 planted bugs across shared core, TUI adapter and web adapter; each must fail a
  real-client or host-runtime property.

## Evidence

### Harness baseline (October 11, 2026; dsh 0.2.1-alpha.2, dsh-TUI 0.14.0 from nix-config `44c9969`, unpatched)

- Skill rig self-test: 9/9.
- Host runtime: a probe status view (`test/e2e/support/probe-status.mjs`) mounted in the real
  `TuiStatusRuntime` renders in the xterm frame with foreground 130.
- Real `dst`: the probe row is in `--dump-config`; it shows in chat with SGR `38;5;130` preserved by
  `capture-pane -e`, and does **not** show on the unpatched Launchpad.
- Real web: the 0.1.0 route reaches the mock upstream with the forwarded proxy key; without the session
  cookie the route answers 401.
- Found while proving the harness: ink and tmux leave unchanged blank cells uncoloured, so colour runs
  treat spaces as neutral; a boot failure leaked its tmux server and kept node alive, so `boot()` now
  cleans up before rethrowing.

### Red (spec and tests committed before the implementation; `tui.js` and `lib/line.js` were loadable stubs)

- `npm test` (`NUM_RUNS=100 HOST_RUNS=20 CMUX_RUNS=10`): 67 tests, 38 pass, 29 fail. Failing: every
  `line.properties` property and the omp example (no line), the cmux differential (no line), the v2
  report contract (fixtures, route, throttle, proxy order, 60 s proxy interval), the client headline and
  50/80 classes, every `tui.host` property (`frame never satisfied predicate`), and the Launchpad
  contract (unpatched dsh-TUI).
- `tui.e2e` (`E2E_RUNS=1 SEED=1`): 6/6 fail. Two examples first passed, because the request-log oracle
  read a plugin that never fetched as correctly hidden; `boot()` now asserts every reachable account
  is requested after start (U5 liveness), and both fail.
- `web.e2e` (`E2E_RUNS=1 SEED=1`): 3/3 fail (headline text, thresholds, account order, U11).
