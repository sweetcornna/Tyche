# Tyche

Tyche is a clean-room, public-ready financial-agent foundation for BTC and ETH. Claude Code orchestrates weekly strategic analysis and daily tactical analysis; deterministic Node.js scripts own all exchange-facing validation, sizing, plan sealing, and lifecycle truth.

详细中文项目规划、当前验证状态及后续验收路线见 [项目规划](docs/PROJECT_PLAN.md)。

## Safety boundary

- **Gate Spot is dry-run only.** Tyche can read public Spot data and can optionally read a production Spot account for dry-run sizing. No Spot order-mutation operation exists in this repository.
- **Gate and Binance USDT-M testnet execution is available.** The venue-explicit module can plan and submit automatically only when an ignored local configuration selects `automatic_testnet`; Gate's original manual TTY path remains available.
- **Production execution is unsupported.** There is no production USDT-M mutation host, credential set, or command path.
- **Execution is fail-closed.** The local Pi cluster defaults to shadow mode and never starts a testnet executor; any testnet venue must be selected explicitly and run in its own process.
- **Derivatives are high risk.** Testnet behavior does not establish production safety, profitability, liquidity, or protection against liquidation.

## Requirements

- Node.js 22.19 or newer
- Claude Code for the included agents, skills, and workflows
- Exact pinned CCXT dependency for credential-free multi-exchange public data

## Setup

```sh
npm install --ignore-scripts
cp config/tyche.json config/tyche.local.json
npm run check
npm test
npm run test:e2e
npm run selftest
```

## Local Pi cluster and analysis cockpit

The optional safe UI lives in `apps/web` and is served by the loopback-only
control plane after the production bundle is built:

```sh
npm run web:build
npm run control:check
npm run control:test
node scripts/tyche-control-plane.mjs --port 8788
```

The service binds only to `127.0.0.1` and serves the built `apps/web/dist` from
the same origin. By default it prints a fresh, one-time bootstrap token at startup.
For persistent local login, put your chosen token in the ignored project file
`config/control-plane.token` and set its permissions to `0600`. It must be a real
private file containing 6–256 URL-safe letters, digits, underscores or hyphens,
with at most one final newline. The full script reads this fixed project path at
startup regardless of the working directory; an existing invalid or unreadable
file blocks startup. A valid file selects a reusable token across logouts,
session expiry and service restarts. Remove it and restart to restore the random
one-time mode. Each login still issues fresh random session and CSRF credentials
with a 15-minute lifetime; relogin revokes the session replaced in that browser.
Cookies are separated by the bound local port. Refreshing or opening another tab
restores the current session through a protected read without consuming the login
token or extending its lifetime. If another login, logout or expiry changes that
session, the page stops pending actions and offers recovery or login. Unsubmitted
endpoint/key pairs and chat text remain together in page memory for review; no
write is retried automatically, and recovery loads the current server settings.
The standalone package CLI retains random one-time login.
Programmatic `startControlPlaneChild` callers may instead supply explicit
`bootstrapToken` / `reusableBootstrapToken` options; these take precedence over
the local file and undergo the core's strict validation.

The cockpit receives
sanitized status, cycle, DAG, paper, venue, plan-summary, and bounded event
projections. It never stores provider or exchange keys and never receives raw
account data, private history, plans, ledgers, or fills. Testnet actions remain
behind the fixed executor sockets, exact arm phrases, and exact plan-hash
confirmation. See [apps/web/UPSTREAM.md](apps/web/UPSTREAM.md) for the fixed
`xing-shuyin/pi-web-ui` reference commit and the intentionally deleted surface
area.

After signing in with the bootstrap token, fill in only the model API endpoint
and API key. Tell the main Agent what you want to explore with BTC/ETH. It asks
one or two focused questions, remembers collected preferences and partial
settings, and can arrange a complete **Paper simulation starting point** when
you say you are unsure or delegate the choices. Inferred capital is explicitly
virtual and risk choices are labeled assumptions, not real balances, a claim
of optimality or a profit promise. There are no hidden hardcoded capital presets.

When you ask for configuration, the server validates the complete selected
candidate and applies it automatically. No strategy application button or
eleven-field Paper form is needed; model selection also has an optional manual panel. Explanations alone do not apply changes.
The read-only summary shows applied, pending or failed status from the server.
Then select **运行 workflow** for one analysis → deterministic plan → Paper
cycle. If setup is incomplete, the action asks the main Agent to help complete
it. Date and ISO week use the current UTC day at launch; repeat runs reuse the
account and connection. Decimal bps retain precision (1 bps = 0.01%).

The default manual workflow uses the ignored `config/tyche.local.json`, creating
it from the committed locked template when needed. An explicitly selected
custom startup configuration stays selected and is never rewritten by the page;
missing limits in that custom file require correction there. Existing Paper
accounts, configured limits and configuration digests are checked and never
reset or silently replaced. The standalone `@tyche/control-plane` package CLI
is only a projection shell; use the script above for the complete workflow.

The conversation workspace has a fixed Agent list on the left, the main chat
in the center, and connection settings, read-only configuration and run details
on the right. The main Agent can adjust semantic strategy, six role model/effort
choices and the light/dark theme through the same conversation. A bounded
durable session draft preserves earlier answers beyond the eight-message model
history window. Each configuration response explicitly selects its application
scope, so an independent theme/model change does not initialize a pending Paper
draft. Only a complete, validated Paper candidate can create the simulation.

Every role initially uses Astra. Orchestration (including the main conversation),
BTC/ETH analysis and synthesis use `high`; preflight uses `medium`, and review
uses `xhigh`. The default pool contains only Astra with these three efforts.
Luna, Sol, Terra, 5.5 and 5.4 Mini remain available in the known-model directory
for explicit addition to your pool.

Open **模型分配** to declare up to twelve available model IDs and each
model's nonempty subset of `medium`, `high`, `xhigh`. You can also describe a pool
in chat. Custom IDs are user declarations about the same API gateway, not verified
capabilities. Known SDK metadata is retained, and conflicting effort declarations
are rejected as a whole instead of silently lowering an effort. Custom context
and pricing stay unknown: the SDK's zero context sentinel means no known limit,
while 16,384 tokens is only this application's output budget. For custom models, text-only is the
application input restriction, not a claim about all model capabilities.

The connection panel offers **OpenAI Responses** (the default), **OpenAI Chat
Completions**, and **Anthropic Messages**. Select the protocol explicitly, then
enter a domain, base URL, or that protocol's complete operation URL. Tyche adds
HTTPS to a bare domain, adds `/v1` to an OpenAI root address, removes a matching
`/responses`, `/chat/completions`, or `/v1/messages` suffix, and removes the standard
Anthropic `/v1` suffix. Explicit gateway prefixes such as `/gateway/v2` are retained.
The panel shows the normalized base URL. Encodings, dot segments, credentials,
queries, fragments and nonexplicit HTTP loopback spellings remain rejected.
Changing the address or protocol clears a previously typed key and requires a key
for the new connection; equivalent normalized addresses can reuse a saved key.

Leaving a completed connection field, or sending the first message, automatically
reads the provider's standard models list. **重新检测模型** retries discovery.
OpenAI uses one `GET /models` relative to its base URL; Anthropic uses one
`GET /v1/models`. The request is limited to ten seconds, 256 KiB and 200 entries.
Anthropic `has_more` is displayed as **仅当前页，目录不完整**; absent IDs on that
page do not establish unavailability. No upstream pagination URL is followed.
Errors and empty lists leave previous settings intact, with a manual model-pool
path available. Reading a directory verifies neither inference nor every effort.

The session-only catalog lasts five minutes and is bound to the protocol,
normalized endpoint and credential identity. It exposes bounded model IDs and
fixed capability provenance to the main Agent, never descriptions, URLs or keys.
Provider listing, local host/SDK effort support and user-declared support remain
separate. Unknown custom efforts must be explicitly saved in the model panel;
chat can retain proposals as untrusted drafts but cannot grant itself new effort
capabilities. Saving a declaration updates matching catalog entries immediately,
without renewing their expiry or making a different connection's catalog active.
Declarations remain bound to the confirmed protocol, endpoint and credential after
the directory expires. Agent pool/effort selections do not change those declarations
or narrow SDK capabilities. The model panel captures its declaration target when
you edit; a changed or expired target requires explicit reconfirmation before saving.

In automatic mode, discovery prepares at most twelve candidates: retain usable
current declarations first, then use the fixed local capability order. Existing
narrower efforts stay narrow. The rule and number of eligible models left outside
the pool are shown. A gateway without Astra but with a known supported model can
start the first chat without a hand-entered pool; bootstrap prefers high, then
medium, then xhigh within the selected declaration. This prepares conversation;
only the main Agent's complete six-role output establishes an allocation. Unknown-
only catalogs preserve the old connection and require an explicit usable model
and effort before connection. Manual pools, bootstrap and roles are preserved.

Anthropic Messages accepts only native adaptive Claude models from the pinned
SDK and efforts transmitted unchanged. Unknown aliases, GPT models, budget-only
thinking models, OAuth and fallback models remain unsupported. Provider capability
flags can narrow SDK support but never expand it. Neither chat nor failure changes
the selected protocol. While connected, every candidate model and effort must
support that protocol; clear the connection before preparing an incompatible pool.
Fixed diagnostics omit upstream errors and credential values.

In **自动** mode, select **主 Agent 分配** or ask for an allocation in chat. The
main model returns six model/effort pairs and a short reason for each; only valid
complete output clears pending allocation. Every pool change in automatic mode
marks it pending, even when the previous selections remain valid. The page keeps
the previous choices visible without treating them as a new allocation. No
allocation request is added automatically to each workflow cycle.

In **手动** mode, choose and save all six role pairs. Chat cannot overwrite those
choices; strategy and theme can still be discussed independently. Removing a
referenced model or effort blocks new workflows until corrected. Pool updates
remove only incompatible role drafts and preserve unrelated Paper/strategy
drafts. Pool, mode, bootstrap and submitted role settings commit together through
the same authenticated endpoint. The displayed source distinguishes fixed defaults,
user settings and a real main-Agent allocation; gateway compatibility remains
unverified until independently demonstrated with the user's API service.

Discussion has no tools or raw account access. Paper initialization exposes only
eleven safe parameter values, readiness and missing fields to the main Agent.
Existing accounts and saved risk limits cannot be overwritten by conversation.
Independent strategy/model/theme changes can continue while Paper is blocked.
Strategies, models, preferences, drafts, theme and discussion are session-memory
only and disappear on logout, expiry or restart; an initialized Paper account
remains on disk. Fixed DAG, events and results remain in run details. Testnet
status is read-only here; independent testnet API/CLI gates remain unchanged.
Conversation never arms an executor or starts a scheduler. A new strategy or
model never bypasses same-cycle receipt reuse or forces a second simulated fill.

Astra uses an explicit custom Responses definition because the pinned Pi
catalog does not contain it. Its 272,000-token context and text/image input
metadata were verified from the local host catalog. The 16,384-token session
output budget is an application request ceiling, not a claim about the model's
maximum output. Astra pricing is unavailable; SDK-required zero placeholders
are not displayed as prices or cost estimates. The user's API gateway must
support the requested model and effort; local metadata alone does not prove
that gateway support. Existing models retain their pinned SDK metadata.

After allocation, the main Agent uses the orchestrator's effective model and effort. Settings
remain session-local. Each cycle freezes the pool capabilities, mode and both complete role mappings; job and
result identity checks, retries and persisted provenance include the actual
model and effort plus the pool digest; receipts retain the pool metadata source. Configuration changes never bypass receipt reuse or grant
additional tools, roles or trading permissions.

The runnable local cluster keeps the scheduler/control plane and the optional
testnet executor in separate processes. The cluster service owns no exchange
credentials, binds only to `127.0.0.1`, and uses fixed state/socket locations
under `data/runtime/`. Start the processes in this order when deliberately
using one testnet venue (choose Gate or Binance, never both):

```sh
# 1. Build the optional cockpit once.
npm run web:build

# 2. Optional: start exactly one independently configured executor.
npm run executor -- start --venue gate --socket data/runtime/gate.sock --config config/tyche.local.json

# 3. Start the scheduler/Pi service; shadow is the default and never executes.
npm run cluster -- start --provider fixture --model fixture --mode shadow --config config/tyche.local.json
```

For a primary testnet run, use `--mode primary --testnet-venue gate` (or
`binance`) only after the selected executor is independently armed. The cluster
does one fixed-venue `plan`, then `status`, and sends a scheduled execute only
when the executor reports armed. Shadow, unarmed, RED, ambiguous, and weekly
dependency failures stop before execution; there is no retry or venue failover.
The control plane's manual cycle endpoint runs one Pi/paper cycle only and can
never trigger scheduled execution. `npm run cluster -- status` shows the
sanitized runtime summary.

The committed configuration is locked and has no invented capital limits. Edit only the ignored local configuration. Gate's existing reviewed path uses `gate.submission_mode=manual_testnet`; the automatic module requires `automatic_testnet` in the selected `gate` or `binance` block, `usdm.environment=testnet`, and positive user-supplied limits plus leverage from 1 through 3. Keep the committed file locked.

Before starting paper automation, inspect every local prerequisite without making a network request:

```sh
npm run automation -- doctor --config config/tyche.local.json
```

Environment variables are read directly by Node; Tyche does not load `.env` files. `.env.example` lists only the optional read-only Spot account variables. Claude Code analysis and paper processes reject Gate and Binance testnet credentials before launching an agent. Inject `GATE_USDM_TESTNET_API_KEY`/`GATE_USDM_TESTNET_SECRET_KEY` or `BINANCE_USDM_TESTNET_API_KEY`/`BINANCE_USDM_TESTNET_SECRET_KEY` only into the separate testnet process. Never store their values in the project; an external secret manager with per-process injection is preferred.

## Multi-exchange public data

Tyche uses an exact pinned [CCXT](https://github.com/ccxt/ccxt) package to discover every exchange in its current registry. The adapter is limited to BTC/ETH public market discovery and fixed unified reads. It never accepts credentials, caller-controlled URLs, private methods, account reads, or trading methods. Gate remains authoritative for paper execution evidence; Gate and Binance use separate fixed-host native adapters for testnet execution.

List the current registry, collect all exchanges with the practical core channel set, or request every supported channel:

```sh
npm run market:all -- catalog
npm run market:all -- snapshot --date 2030-01-07 --iso-week 2030-W02 --channels core --out data/crypto_multi_exchange.json
npm run market:all -- snapshot --date 2030-01-07 --iso-week 2030-W02 --channels all --out data/crypto_multi_exchange.json
```

`core` collects ticker, order book, current funding, and open interest. `all` additionally collects 4-hour/daily candles, recent trades, funding history, and liquidations, so a full-registry run is substantially slower. Regional restrictions, maintenance, and unsupported symbols are isolated per exchange and produce a sealed `PARTIAL` snapshot rather than deleting successful sources. The full exchange records remain in `data/crypto_multi_exchange.json`; only aggregates, counts, provenance, and its hash are embedded into the canonical strategy snapshot. The normal automation entry point performs these steps after paper settlement:

```sh
npm run automation -- prepare --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json --exchanges all --channels core
```

## Analysis

Run the Claude Code skills:

- `/weekly-crypto` creates a weekly BTC/ETH anchor. Weekly output always contains zero execution candidates.
- `/daily-crypto` reads the current weekly anchor, analyzes current public data, and emits semantic daily candidates.
- `/auto-crypto` runs one credential-free USDT-M paper cycle: settle, snapshot, refresh weekly when required, analyze daily, select, plan, simulate, and report.
- `/perp-scan` focuses the daily analysis on USDT-M risk and setup quality without submitting.
- `/gate-trade` explains deterministic planning, status, reconciliation, and the manual testnet boundary.

Workflows require both `date` (`YYYY-MM-DD`) and `isoWeek` (`YYYY-Www`). Before a workflow starts, top-level deterministic code validates configuration and creates the public market snapshot. Workflow subagents have read-only tools and return structured data; the top-level caller persists the exact result through `scripts/agent-write.mjs`, renders the report, and may run only dry-run planning. Workflows use repository-relative paths, reject inherited USDT-M testnet credentials, and never create a signed client or execute an order.

## One-shot USDT-M paper automation

Create an ignored local configuration that remains `locked`/`dry-run`. Set positive `configured_leverage` (1–3), `risk_per_trade_bps`, `max_order_notional_usdt`, `daily_new_notional_cap_usdt`, and `max_managed_notional_usdt` under `gate.usdm`, then provide every paper capital and breaker value explicitly when using the CLI. The conversational UI may derive these simulation-only values after user delegation; the CLI has no paper-capital defaults:

```sh
npm run paper -- init \
  --initial-usdt <amount> \
  --daily-loss-bps <bps> \
  --max-drawdown-bps <bps> \
  --max-spread-bps <bps> \
  --max-entry-distance-bps <bps> \
  --trigger-slippage-bps <bps> \
  --config config/tyche.local.json
```

The automation entry point joins the safe unattended part of the pipeline without adding a timer or venue-submission path. `prepare` always settles existing paper positions before it collects and archives fresh public evidence. Follow its `anchor_action`, persist the required weekly/daily workflow documents, then apply the deterministic USDT-M paper plan:

```sh
npm run automation -- prepare --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json --exchanges all --channels core
# Run /weekly-crypto first if prepare returns REFRESH_WEEKLY, then /daily-crypto.
npm run automation -- plan --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json
```

`plan` accepts only fresh canonical daily output produced from the current `data/crypto_market.json` and a valid active paper account. It selects USDT-M candidates independently of model order, writes a sealed plan, watches the public book for the configured 30-second window, records simulated fills/protection only, and writes `outputs/automation-<date>.json` plus reports. The v2 receipt seals weekly, daily, market, policy, pre/post ledger, plan, and paper-receipt digests. A repeated call whose active ledger matches the sealed post-state reuses the cycle rather than simulating a second fill.

The kill switch, daily-loss limit, drawdown limit, spread limit, and entry-distance limit block new paper entries while settlement and managed exits/reductions continue. This command never invokes `execute`; venue `submitted` and `filled` are always zero. Paper fills are reported separately as `simulated_filled_contracts`.

Inspect, settle, report, or archive paper state with:

```sh
npm run paper -- status
npm run paper -- settle
npm run paper -- report
npm run paper -- archive --account-id <id> --confirm "ARCHIVE PAPER <id>"
```

Archive succeeds only when no paper position or active paper order remains.

## Automatic Gate/Binance testnet execution

The automatic module is venue-explicit and never broadcasts one signal to both exchanges. Configure one venue at a time in `config/tyche.local.json`, inject only that venue's testnet credentials into the command process, and run:

```sh
npm run trade:testnet -- plan --venue gate --source data/crypto_daily.json --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json
npm run trade:testnet -- cycle --venue gate --source data/crypto_daily.json --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json

npm run trade:testnet -- plan --venue binance --source data/crypto_daily.json --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json
npm run trade:testnet -- cycle --venue binance --source data/crypto_daily.json --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json
```

`plan` performs signed testnet account/rule reconciliation and writes a sealed venue-bound plan without submitting. `cycle` plans and then submits automatically if every gate remains green. The executor preserves atomic reservation, exact client identity, no-blind-retry recovery, fill proof, reduce-only stop/take-profit protection, per-venue ledger, sticky-red reconciliation, and kill switches (`data/gate_KILL` or `data/binance_KILL`). The production public REST interfaces remain available for market reads, but no production credential namespace or mutation route exists. See [docs/AUTOMATIC_TESTNET.md](docs/AUTOMATIC_TESTNET.md).

## Deterministic commands

Validate configuration and collect a public market snapshot:

```sh
node scripts/config.mjs check --config config/tyche.local.json
node scripts/crypto-market.mjs snapshot --date 2030-01-07 --iso-week 2030-W02 --multi-exchange data/crypto_multi_exchange.json --out data/crypto_market.json
```

Create dry-run plans from a daily analysis file:

```sh
node scripts/gate-trade.mjs plan --product spot --environment dry-run --source data/crypto_daily.json --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json
node scripts/gate-trade.mjs plan --product usdm --environment dry-run --source data/crypto_daily.json --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json
```

Inspect local lifecycle state or perform read-only USDT-M testnet reconciliation:

```sh
node scripts/gate-trade.mjs status
node scripts/gate-trade.mjs reconcile --product usdm --environment testnet --config config/tyche.local.json
```

`status` lists every unresolved red cause. Reconciliation observes them but clears none by default. To request cause-specific resolution after reviewing the exact identity evidence, add `--resolve-cause <cause-id>` (comma-separate multiple IDs). A green account snapshot, absence from a bounded open-order list, or a legacy receipt link cannot clear ambiguity.

Gate's original manual execute command is deliberately not documented here. After reviewing a sealed Gate manual-testnet plan, use the `/gate-trade` skill in a separate interactive credential-bearing terminal to obtain the exact per-plan procedure. Analysis agents and workflows are prohibited from running any executor.

## Runtime privacy

Public market snapshots may be read by analysis agents. Credentials, raw account payloads, plans, ledgers, fills, and private trading history must not enter prompts or external searches. The repository ignores runtime data, local configuration, plans, outputs, logs, caches, and Claude local settings.

See [docs/AUTOMATIC_TESTNET.md](docs/AUTOMATIC_TESTNET.md), [docs/MULTI_EXCHANGE_DATA.md](docs/MULTI_EXCHANGE_DATA.md), [docs/GATE_TRADING.md](docs/GATE_TRADING.md), [docs/NO_HALLUCINATION.md](docs/NO_HALLUCINATION.md), and [SECURITY.md](SECURITY.md) for the complete trust and failure model.
