# dsh-usage-limits: product and technical specification

Version 0.2.1 (October 11, 2026). Supersedes the web-only behaviour of 0.1.0 where noted.

## 1. Product

### Problem

Jake's omp setup shows one line under the editor with his Claude and Codex plan usage
(`~/.omp/agent/extensions/cmux-usage.ts` → `~/.config/cmux/usage/cmux-usage bars` →
`omp usage --json`):

```
Claude 5h ████░░░░ 52% ↻51m 7d ██████░░ 80% ↻2d12h   Codex 7d ██░░░░░░ 28% ↻3d2h
```

DSH has no such line in the terminal client (`dst`, the dsh-TUI profile). The web client has a
ring meter (this package, 0.1.0). Both DSH clients route Claude and Codex through ProviderProxy, whose
accounts are not omp's: omp reads its own sign-ins, so its numbers describe other subscriptions.

### Outcome

The same Claude/Codex plan-usage information, in omp's line format, in `dst`, fed by the accounts
DSH actually uses:

- ProviderProxy's server-held subscriptions (`GET <proxy>/usage/claude`, `GET <proxy>/usage/chatgpt`).
- DSH's own stored sign-ins (`llm-pi-ai/anthropic`, `llm-pi-ai/openai-codex`) when present.

The web ring keeps its form but shows the same accounts, windows and colour thresholds.

### Decisions (Jake, October 11, 2026)

| Question | Decision |
|---|---|
| Accounts | ProviderProxy accounts **and** DSH's own sign-ins, labelled as the web meter labels them |
| `dst` placement | One coloured line above the prompt, in chat **and** on the Launchpad (first screen) |
| Web | Keep the ring and panel; align accounts, windows and thresholds with `dst` |

### Non-goals

A `/usage` command or details scene in `dst`; refreshing, writing or logging any token; a cache
shared between processes; plan names or scoped (per-model) windows on the `dst` line; changing
Jake's omp extension.

### Accounts and labels

Accounts appear in this order; an account that is not configured is omitted everywhere.

| Account id | Name | Short name | Source |
|---|---|---|---|
| `providerproxy/anthropic` | `Claude (proxy)` | `Claude·px` | ProviderProxy `usage/claude`, bearer = proxy client key |
| `providerproxy/openai-codex` | `Codex (proxy)` | `Codex·px` | ProviderProxy `usage/chatgpt` |
| `anthropic` | `Claude` | `Claude` | DSH sign-in `llm-pi-ai/anthropic` → Anthropic OAuth usage |
| `openai-codex` | `Codex` | `Codex` | DSH sign-in `llm-pi-ai/openai-codex` → ChatGPT `wham/usage` |

The proxy accounts exist only when the row configures `proxy.baseURL`; their credential is the
environment variable named by `proxy.apiKeyEnv` (default `PROVIDERPROXY_API_KEY`).

### Windows

Each usage window has a percent (integer 0–100), an optional reset time, a **span** (window length
in seconds, or unknown) and a **scope** (shared, or a named model/limit). An account's **line
windows** are its first shared window with a span of 18,000 s (`5h`) and its first shared window with
a span of 604,800 s (`7d`); a later shared window of the same span (which no current payload carries)
is shown only in the web panel. The report marks exactly these windows with `short`. Spans come from
the payload: Claude `session`/`five_hour` = 5h, `weekly_all`/`seven_day` = 7d, `weekly_scoped`
and `seven_day_<model>` are scoped; Codex windows carry `limit_window_seconds`, and
`additional_rate_limits` and the spend limit are scoped. A window whose reset time has passed shows
0% with no reset time until new data arrives.

**Severity** of a percent p: `critical` when p ≥ 80, `warning` when 50 ≤ p < 80, else `normal`
(omp's thresholds; the web ring previously used 75/90).

### `dst` line

The line is the plugin's status view, one row, rendered by dsh-TUI above the prompt in chat and,
with nix-config's `launchpad-status` patch, centred above the Launchpad's input card.

An account is **shown** when it has data (fresh or stale) and at least one line window. The line is
**hidden** (renders nothing) when no account is shown, including before the first data arrives.
Unknown or failed accounts are never rendered as 0%.

Formats, for available width W = the content width dsh-TUI gives the status area: terminal columns
minus its page margin (2 columns each side at the default `normal` margin, so W = columns − 4) and
minus a split side panel. The first tier whose plain-text width is ≤ W is used:

| Tier | Account | Window | Separator between accounts |
|---|---|---|---|
| 0 | full name | `<5h|7d> <8-cell bar> <p>% ↻<reset>` | 3 spaces |
| 1 | full name | `<5h|7d> <4-cell bar> <p>% ↻<reset>` | 3 spaces |
| 2 | full name | `<5h|7d> <p>% ↻<reset>` | 3 spaces |
| 3 | full name | `<5h|7d> <p>%` | 2 spaces |
| 4 | short name | `<5h|7d> <p>%` | 2 spaces |
| 5 | only the fullest line window: `<short name> <5h|7d> <p>%` | | |

- An account is `<name> <window>[ <window>]`, 5h before 7d; a window without a reset time omits
  ` ↻<reset>`.
- Bar of c cells: f = ⌊(p·c + 50)/100⌋ filled `█`, then c − f `░` (omp's rounding).
- Reset text, for d = reset − now in ms and m = ⌊d/60000⌋: m < 60 → `<m>m`; m < 600 →
  `<⌊m/60⌋>h<m mod 60>m`; m < 1440 → `<⌊m/60⌋>h`; else `<⌊m/1440⌋>d<⌊(m mod 1440)/60⌋>h`
  (omp's `dur`).
- In tiers 0–3 a stale account ends with ` stale`.
- Tier 5 picks the highest percent; ties go to the earlier account, then 5h before 7d.
- If even tier 5 is wider than W, it is cut to W cells; W ≤ 0 renders nothing.
- Colours: account name bold; bar and percent in the severity colour (`normal` 256-colour 28
  green, `warning` 130 amber, `critical` 160 red, omp's palette); ` ↻<reset>` and ` stale` dim.

**Timing.** Data is requested immediately on load and then every 60 s; each ProviderProxy account
reaches the proxy at most once per 60 s (the proxy caches upstream for 60 s), each direct sign-in at
most once per `minIntervalMs` (default 5 min, floor 1 min), with exponential back-off after failures.
Reset countdowns re-render every 30 s without a request. Rendering never starts a request.

**Lifecycle.** The line survives busy turns, `/model` switches and session changes (it is
process-wide, not per session); a restart starts empty and shows data once fetched. Unloading the
plugin removes the line, stops its timers and cancels in-flight requests.

### Web ring and panel

- The trigger shows the **headline**: the fullest line window over shown accounts (ties as tier 5), or, when
  no account has a line window, the fullest window of any kind. Its text is `<name> <5h|7d|window label> <p>%`;
  the ring and text take the headline's severity colour. No configured account → the meter is hidden;
  configured accounts without data → the trigger reads `Usage` so the panel can explain the error (as 0.1.0).
- The panel lists every configured account in the order above with its plan, every window (line and
  scoped), reset times and a stale/error note, as in 0.1.0.

### Failure behaviour (both clients)

A failed refresh (network error, timeout, HTTP error, 429, invalid JSON, or a 200 without parseable
windows) never replaces good data: the account keeps its last data and is marked stale with a reason.
An account with no good data yet is an error (panel note; hidden on the line). A ProviderProxy error
body's `error.message` (≤ 200 chars) is shown as the reason. Expired or rejected sign-ins wait for DSH
to refresh them. No token, refresh token or proxy key may appear in any rendered output, route body
or log, even if an upstream echoes it.

### Acceptance properties

| ID | Property | Independent oracle | Web test | TUI test |
|---|---|---|---|---|
| U1 | The line equals the format above for the shown accounts, tier and time | `test/oracle/line.mjs` (test-only re-implementation from this spec) and, for tier 0, Jake's own `cmux-usage bars` script fed the same data | — (no line on web) | Real `dst`: screen row equals oracle text; host-runtime xterm frame |
| U2 | Colour of every bar/percent equals its severity colour; web ring class equals headline severity | Oracle severity from the 50/80 rule | Playwright: trigger class, panel bar classes | `capture-pane -e` SGR 38;5;28/130/160 per percent |
| U3 | An account is shown iff configured and has data with a line window; none → hidden; never a fake 0% | Mock scenario model | Panel sections and trigger presence | Line presence and account names |
| U4 | Failure never replaces good data; marked stale; later success clears it | Mock scenario history | Panel note `stale` and old values | ` stale` suffix and old values |
| U5 | Upstream requests per account ≤ 1 per interval (+1 initial), none caused by rendering or ticks | Mock request log vs elapsed time | Route request counts | Mock request counts during idle and resize |
| U6 | Countdowns decrease with time without new requests; past reset → 0%, no countdown | Wall clock vs fixture reset times | Panel reset text | Line reset text |
| U7 | The line never exceeds W cells; for W ≥ 20 it is never cut | Cell width of the captured row | — | Resize sequences; host-runtime widths 1–300 |
| U8 | No secret in screen, route body, DOM or logs | Generated secrets echoed by the mock | DOM + route body + logs | Screen capture + logs |
| U9 | The line is present on the Launchpad and in chat, through busy turns, `/model` and restart | Scenario model | Fresh and reloaded page | Launchpad, after submit, held turn, restart |
| U10 | Unload removes the line, timers and requests | Request log after unload | — (page reload covers web client) | Host-runtime unload; no requests after |
| U11 | Web headline and `dst` line agree (same accounts, windows, percents, severities) | Oracle applied to one scenario | Trigger text | Line text |
| U12 | Stored sign-ins are never modified | Credentials file bytes before/after | Same | Same |

## 2. Technical

### Versions (start of work)

| Component | Version / revision |
|---|---|
| dsh | `0.2.1-alpha.2` (temporary alpha exception; npm `latest` `0.2.0-rc.2`), store `dyw9n626…` |
| dsh-TUI | `0.14.0` built from nix-config `44c9969` (store `7d9fzxvg…`) plus `launchpad-status.patch` |
| ProviderProxy | `243bcb1` (`GET /v1/usage/{claude,chatgpt}`, 60 s server cache, identity fields removed) |
| omp (parity reference) | `4ef97c8` (18.8.0); cmux-usage script as of October 5, 2026 |
| This package | base `267eb9a` |

### Layout

```
lib/normalize.js  payload → raw windows {label, percent, resetsAt, span, scoped}
lib/machine.js    per-account fetch state reducer (unchanged)
lib/report.js     states → UsageReport (severity 50/80, short, span, headline over line windows)
lib/accounts.js   config → ordered account list (proxy first), timing policy
lib/source.js     shared core: credentials, throttled fetches, in-flight sharing, redaction → report
lib/line.js       report + now + width → styled segments (tiers 0–5)
index.js          web host half: GET /api/usage-limits (inject connection, credentials)
client.js         web client: ring + panel (slot conversation.composer.dock)
tui.js            dst half: inject tuiStatus; credentials optional; registerView key `usage-limits`
```

### Host seams (evidence: installed source)

- Web: `ctx.connection.fetch.register` (dsh-client-connection), slot `conversation.composer.dock`.
- Both: `ctx.credentials.readRecord('llm-pi-ai/<provider>')` (dsh-credentials-local, file
  `$DSH_HOME/.credentials.yaml`, `records.<key>.kind: grant`). Read only.
- `dst`: `ctx.tuiStatus.registerView({ key, maxRows: 1, component })` (dsh-TUI
  `lib/types/dsh-adapter/status.js`). The component receives `{ React, ui: { Box, Text, Image,
  useTerminalSize } }`; `Text` accepts `color: 'ansi256(n)'`, `bold`, `dimColor`. Chat renders views
  above the prompt while no preview is active. If `registerView` is refused, the plugin falls back to
  `ctx.tuiStatus.set('usage-limits', plainText)` (host renders it dim, uncoloured); the text is the
  line for W = (stdout columns, or 204) − 4 (the default page margin).
- Launchpad: dsh-TUI 0.14.0 renders no status contributions there. nix-config
  `pkgs/dsh-tui/launchpad-status.patch` passes Chat's status entries and views to `Launchpad` and renders
  them, inside the same error boundary, in a full-width centred row above the input card. Its build
  test fails the Nix build if a dsh-TUI bump breaks it. Source copy: `patches/` in this repo.

### Configuration (row `usage-limits`, both profiles)

```yaml
minIntervalMs: 300000        # direct sign-ins; floor 60000
proxy:
  baseURL: http://gpu.tail47033e.ts.net:4000/v1
  apiKeyEnv: PROVIDERPROXY_API_KEY
  minIntervalMs: 60000       # floor 60000
testing:                     # test-only; nix-config never sets it (asserted)
  upstream: { anthropic: <url>, openai-codex: <url> }
  pollMs: <ms>
  tickMs: <ms>
  floorMs: <ms>              # replaces the 60 s floors
```

### State

No persisted state. Per process: one fetch state per account (`lib/machine.js`), the last report, a
clock tick. Restart and multiple processes therefore need no merge policy; each process polls
independently within the limits above.

### External boundaries in tests

Model: the skill's `mock-llm.mjs`. Usage endpoints: `test/e2e/support/mock-upstream.mjs`, one HTTP
server serving `/v1/usage/claude`, `/v1/usage/chatgpt`, `/api/oauth/usage` and `/backend-api/wham/usage`
from a mutable scenario, logging method, path and authorization. Local sign-ins: synthetic grants
written to the rig profile's `.credentials.yaml`. The proxy key is a synthetic value in the environment,
which also stops the managed launcher from loading the real token.

### Packaging and deployment

nix-config vendors `index.js`, `client.js`, `tui.js`, `lib/`, `package.json`, `cordis.patch.yml` into
`pkgs/dsh-usage-limits`, runs the dependency-free suites in `checkPhase`, and inserts the
`usage-limits` row in both the web patch (`index.js`) and the dsh-tui patch (`tui.js`) with the same
`minIntervalMs` and `proxy` config. `tests/test_dsh_profiles.py` asserts both rows on `jake`, `work`,
`gpu`, `fw13` and that `testing` is absent. Install on the work Mac first, verify with cua-driver in
Terminal (`dst` Launchpad + chat) and the browser (after a coordinated `dsh-web` restart), then sync
all hosts (Jake's instruction of October 11 replaces the separate hands-on acceptance step).
Rollback: the previous Home Manager / NixOS generation.
