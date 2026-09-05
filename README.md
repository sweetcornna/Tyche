# Tyche

Tyche is a clean-room, public-ready financial-agent foundation for BTC and ETH. Claude Code orchestrates weekly strategic analysis and daily tactical analysis; deterministic Node.js scripts own all exchange-facing validation, sizing, plan sealing, and lifecycle truth.

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

The service binds only to `127.0.0.1`, prints one one-time bootstrap token, and
serves the built `apps/web/dist` from the same origin. The cockpit receives
sanitized status, cycle, DAG, paper, venue, plan-summary, and bounded event
projections. It never stores provider or exchange keys and never receives raw
account data, private history, plans, ledgers, or fills. Testnet actions remain
behind the fixed executor sockets, exact arm phrases, and exact plan-hash
confirmation. See [apps/web/UPSTREAM.md](apps/web/UPSTREAM.md) for the fixed
`xing-shuyin/pi-web-ui` reference commit and the intentionally deleted surface
area.

After signing in with the one-time token, fill in the model API endpoint and
API key. On the first Paper run, enter the eleven explicit simulation-capital,
leverage, risk-limit and fill-constraint values on the page, then select
**运行 workflow**. The page validates input, saves the session connection,
creates or reuses the locked/dry-run Paper setup, and starts one complete
analysis → deterministic plan → Paper cycle. Date and ISO week use the current
UTC day at launch. No capital or risk defaults are supplied; bps inputs preserve
decimal precision (1 bps = 0.01%). Repeat runs reuse the account and connection.

The default manual workflow uses the ignored `config/tyche.local.json`, creating
it from the committed locked template when needed. An explicitly selected
custom startup configuration stays selected and is never rewritten by the page;
missing limits in that custom file require correction there. Existing Paper
accounts, configured limits and configuration digests are checked and never
reset or silently replaced. The standalone `@tyche/control-plane` package CLI
is only a projection shell; use the script above for the complete workflow.

The conversation workspace has a fixed Agent list on the left, the main Agent
chat in the center, and settings, strategy drafts and run details on the right.
It uses a neutral desktop-chat layout while retaining Tyche's identity. Open
**运行设置** for the model connection and first-run Paper inputs, or open the
strategy panel to paste a semantic BTC/ETH prompt. Discussion has no tools or account
access and does not apply changes. Select **应用策略** to snapshot the strategy
for the next unstarted analysis; all six weekly/daily roles retain their fixed
contracts. Existing same-cycle receipts still reuse their results, so applying
a prompt never forces a second simulated fill. Strategies and discussion are
session-memory only and disappear on logout, expiry or service restart. This
page runs one Paper cycle per click; it does not enable a scheduler or testnet
execution. Event logs, the fixed DAG and testnet controls are in run details
and advanced settings.

Ask the main Agent to change models for any of the six workflow roles. It
returns a model/effort suggestion; select **应用模型配置** to apply it separately
from a strategy change. Every role initially uses Astra. Orchestration (including
the main conversation), BTC/ETH analysis and synthesis use `high`; preflight
uses `medium`, and review uses `xhigh`. These are the only effort levels exposed.
Luna, Sol, Terra, 5.5 and 5.4 Mini remain available for explicit model changes.
The selected model must support the exact requested effort; Tyche rejects an
unsupported pairing instead of letting the SDK silently lower it.

Astra uses an explicit custom Responses definition because the pinned Pi
catalog does not contain it. Its 272,000-token context and text/image input
metadata were verified from the local host catalog. The 16,384-token session
output budget is an application request ceiling, not a claim about the model's
maximum output. Astra pricing is unavailable; SDK-required zero placeholders
are not displayed as prices or cost estimates. The user's API gateway must
support the requested model and effort; local metadata alone does not prove
that gateway support. Existing models retain their pinned SDK metadata.

The main Agent uses the orchestrator's effective model and effort. Settings
remain session-local. Each cycle freezes both complete role mappings; job and
result identity checks, retries and persisted provenance include the actual
model and effort. Configuration changes never bypass receipt reuse or grant
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

Create an ignored local configuration that remains `locked`/`dry-run`. Set positive `configured_leverage` (1–3), `risk_per_trade_bps`, `max_order_notional_usdt`, `daily_new_notional_cap_usdt`, and `max_managed_notional_usdt` under `gate.usdm`, then provide every paper capital and breaker value explicitly. There are no paper-capital defaults:

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
