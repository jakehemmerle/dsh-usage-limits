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

### Green

- `npm test` (`NUM_RUNS=300 HOST_RUNS=60 CMUX_RUNS=30`, patched dsh-TUI): 74/74.
- Defects the suites found while going green, each now a named regression that fails first:
  - **Width**: dsh-TUI hands status views the content width inside its page margin; the plugin had
    subtracted another 4 columns, so a 146-cell line dropped a tier at 150 columns.
  - **Launchpad input collapse** (first `launchpad-status` cut): the status row was not in the Launchpad's
    row budget, so flexbox squeezed the input card to zero height and typing never echoed. The patch
    budgets the rows; the install check renders the real Launchpad chrome at 38 rows.
  - **Duplicate 5h windows** (web campaign seed 11): the headline counted a second shared 5h window that the
    dst line never shows. Only an account's first shared 5h and 7d windows are line windows
    (`proxy.test.js` regression).
  - **Narrow Launchpad** (release campaign seeds 101–404): at about 60 columns the stock 0.14.0 Launchpad
    already collapses its input row (its tips and corners wrap past the row budget), and the usage line
    also displaced the parameter row. The status block now yields first and the input card never shrinks
    (`regression (release campaign seeds 101-404)` in `tui.e2e`, and nix-config's install check at 60/72
    columns, both failing on the previous build).
  - Harness: U12 compares parsed `llm-pi-ai/*` records (dsh web adds its own record and re-renders the
    YAML); web cases enter a session (dsh web 0.2.1-alpha.2 mounts the composer dock only there).

### Release campaign (patched dsh-TUI `krwd30f1…`, identical `lib/` to the installed `aghgnwnr…`)

| Surface | Seeds | Cases | Result |
|---|---|---|---|
| dst (real dsh-TUI in tmux) | 101, 202, 303, 404, 505 | 100 (20 per seed, 1–12 actions) | all pass |
| dsh web (Playwright) | 101, 202, 303, 404, 505 | 100 (20 per seed, 1–12 actions) | all pass |

dst transition coverage over the 100 cases: set 194 (ok 120, status 24, malformed 28, hang 22), grant 101
(valid 29, expired 32, absent 40), submit 111, busy turn 44, restart 59, resize 85, idle 53; line shown
after 506 steps (Launchpad 247, chat 259) and hidden after 141 (Launchpad 74, chat 67).

Web transition coverage over the 100 cases: set 297 (ok 189, status 30, malformed 35, hang 43), grant 151
(valid 62, expired 43, absent 46), reload 79, viewport 67 (390/820/1280 px), idle 74; after each step the
trigger showed a headline 580 times, `Usage` 72 times and was hidden 16 times.

### Mutations (isolated copy; each planted alone, then restored)

| Mutant | Killed by |
|---|---|
| M1 critical at > 80 instead of ≥ 80 | contract and client thresholds; real dst "Launchpad then chat", "narrow terminals" |
| M2 5h and 7d swapped on the line | host-runtime U1/U2, line properties, cmux differential; real dst "/model", "Launchpad then chat", "narrow terminals" |
| M3 poll interval not cleared on unload | host-runtime U10, smoke |
| M4 a failed refresh wipes good data | host-runtime U4/U6, route and proxy properties; real dst "failure keeps data stale" |
| M5 web trigger shows the long label | client tests; real web "ring and panel", U11 |
| M6 countdown tick requests a refresh | survived at first (the throttle hid it); host-runtime U5 now fires a tick after every interval has elapsed and kills it |

Caught 6/6 after strengthening U5.

### Installed artifact (work Mac; first nix-config `5e9f96d`, generation 40, rollback 39)

- `pkgs/dsh-usage-limits` → `/nix/store/w4lbz9c1…-dsh-usage-limits-0.2.0`, byte-identical to this repo's
  runtime files; dst links `/nix/store/aghgnwnr…-dsh-tui-0.14.0` (launchpad-status applied).
- Real dst e2e examples with `PLUGIN_DIR` = the installed store path and the dst profile's dsh-TUI: all
  pass, including the 60-column regression.

### Live checks on the work Mac (real profile and accounts)

- dsh web (restarted on the new build): the route returns all four accounts. Through cua-driver's typed
  browser tools (driver-owned isolated Chrome, CDP capture): the composer dock reads `Claude 7d 100%` in
  the critical colour; the panel lists Claude (proxy) 5-hour 3%, Weekly 39%, Fable 0%; Codex (proxy,
  Promax) Weekly 0%; Claude 5-hour 0%, Weekly 100% (red bar), Fable 3%; Codex Weekly 7%; resets shown.
- dst (real `dst`, real HOME, private tmux socket): the Launchpad shows
  `Claude (proxy) 5h ░░░░░░░░ 3% ↻3h38m 7d ███░░░░░ 39% ↻4d23h   Codex (proxy) 7d ░░░░░░░░ 0% ↻6d9h   Claude 5h ░░░░░░░░ 0% 7d ████████ 100% ↻1d18h   Codex 7d █░░░░░░░ 7% ↻6d21h`
  at 200 columns (100% in colour 160, the rest 28) and tier 3 at 120 columns.
- cua-driver on Terminal: blocked; the Mac's screen was locked (capture black, no AX windows).
- Found on the way: the user agenix secrets in `$TMPDIR/agenix.d/2` had been purged by macOS's temp
  cleaner, so a newly started dsh had no `PROVIDERPROXY_API_KEY` and the proxy accounts read signed
  out; re-running `org.nix-community.home.activate-agenix` restored them (generation 3).

### Found after the first rollout (each a failing regression first)

- **Headline tie** (web repeat loop, run 1, seed 951): when a payload listed the weekly window before the
  5-hour one at equal percents, the web headline said 7d while the dst line's tie-break (and SPEC) says
  5h. The contract helper had copied the same order. Fixed in 0.2.1 (`proxy.test.js` regression).
- **Proxy timeout** (live, personal Mac, right after activation): `Codex (proxy)` read
  `timed out after 10 s`. ProviderProxy gives its upstream 30 s and caches nothing for a caller that gave
  up, so a slow ChatGPT usage call could keep timing out. ProviderProxy requests now wait 35 s; direct
  sign-in endpoints keep 10 s (0.2.2; mock-timer regressions for both).
- **Harness**: the probe test decided "patched" from `DSH_TUI_DIR` only and failed on the installed dst
  profile (deterministic, all five runs); it now reads the dsh-TUI the rig mounts. One web-loop run saw
  `--dump-config` print nothing once (not reproduced; the assertion now reports exit status and stderr).

### Deployment (dsh-usage-limits `8c10538` = 0.2.2, nix-config `2db2ca1`)

| Host | Revision | Rows (web / dst) | Launchpad patch | Live check |
|---|---|---|---|---|
| work (work Mac) | `2db2ca1`, HM generation 42 (rollback 41) | 0.2.2 / 0.2.2 | yes | dsh-web restarted: 4 accounts ok, headline `Claude 7d 100%`; real dst Launchpad line (above); installed-artifact e2e |
| mbp | `2db2ca1` | 0.2.2 / 0.2.2 | yes | dsh-web restarted (idle): proxy accounts ok, headline `Claude (proxy) 7d 39%` |
| fw13 | `2db2ca1` | 0.2.2 / 0.2.2 | yes | dsh-web restarted (idle): same; 0 failed units |
| gpu | `2db2ca1` (provisioning guard used; inactive after, timestamps unchanged) | 0.2.2 / 0.2.2 | yes | 0 failed units; dsh-web not restarted (sessions active), still serving 0.1.0 until its next restart; dst shows dsh-TUI's first-run guide (never run there) |

### Repeat runs on the installed 0.2.2 (`/nix/store/rj75p6g7…-dsh-usage-limits-0.2.2`, installed dst dsh-TUI)

Five consecutive runs of each real-client file (examples plus a 3-case campaign, seeds 1301–1305 for dst
and 1401–1405 for web): dst 9/9 every run, web 3/3 every run.
