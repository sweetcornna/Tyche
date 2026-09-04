# Tyche

Tyche is a clean-room, public-ready financial-agent foundation for BTC and ETH. Claude Code orchestrates weekly strategic analysis and daily tactical analysis; deterministic Node.js scripts own all exchange-facing validation, sizing, plan sealing, and lifecycle truth.

## Safety boundary

- **Gate Spot is dry-run only.** Tyche can read public Spot data and can optionally read a production Spot account for dry-run sizing. No Spot order-mutation operation exists in this repository.
- **Gate USDT-M is manual testnet only.** Planning is available in dry-run mode. Submission requires a separately reviewed plan and a human-entered confirmation in a real terminal.
- **Production execution is unsupported.** There is no production USDT-M mutation host, credential set, or command path.
- **No scheduler is included.** Analysis and any testnet action are initiated interactively.
- **Derivatives are high risk.** Testnet behavior does not establish production safety, profitability, liquidity, or protection against liquidation.

## Requirements

- Node.js 20 or newer
- Claude Code for the included agents, skills, and workflows
- No runtime npm dependencies

## Setup

```sh
npm install --package-lock-only --ignore-scripts
cp config/tyche.json config/tyche.local.json
npm run check
npm test
npm run selftest
```

The committed configuration is locked and has no invented capital limits. To create executable USDT-M testnet plans, edit only the ignored local configuration: set `gate.submission_mode` to `manual_testnet`, set `gate.usdm.environment` to `testnet`, and provide positive limits plus a leverage from 1 through 3. Keep the committed file locked.

Environment variables are read directly by Node; Tyche does not load `.env` files. `.env.example` lists only the optional read-only Spot account variables. Claude Code planning/workflow processes must not contain `GATE_USDM_TESTNET_API_KEY` or `GATE_USDM_TESTNET_SECRET_KEY`; both workflows reject them before launching an agent. Supply those testnet-only names, without storing their values in a project file, only to the separate human-invoked terminal process that performs signed testnet planning, reconciliation, or an explicitly confirmed submission. An external secret manager with per-process injection is preferred.

## Analysis

Run the Claude Code skills:

- `/weekly-crypto` creates a weekly BTC/ETH anchor. Weekly output always contains zero execution candidates.
- `/daily-crypto` reads the current weekly anchor, analyzes current public data, and emits semantic daily candidates.
- `/perp-scan` focuses the daily analysis on USDT-M risk and setup quality without submitting.
- `/gate-trade` explains deterministic planning, status, reconciliation, and the manual testnet boundary.

Workflows require both `date` (`YYYY-MM-DD`) and `isoWeek` (`YYYY-Www`). Before a workflow starts, top-level deterministic code validates configuration and creates the public market snapshot. Workflow subagents have read-only tools and return structured data; the top-level caller persists the exact result through `scripts/agent-write.mjs`, renders the report, and may run only dry-run planning. Workflows use repository-relative paths, reject inherited USDT-M testnet credentials, and never create a signed client or execute an order.

## Deterministic commands

Validate configuration and collect a public market snapshot:

```sh
node scripts/config.mjs check --config config/tyche.local.json
node scripts/crypto-market.mjs snapshot --date 2030-01-07 --iso-week 2030-W02 --out data/crypto_market.json
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

The execute command is deliberately not documented here. After reviewing a sealed testnet plan, use the `/gate-trade` skill in a separate interactive credential-bearing terminal to obtain the exact per-plan procedure. Agents and workflows are prohibited from running it.

## Runtime privacy

Public market snapshots may be read by analysis agents. Credentials, raw account payloads, plans, ledgers, fills, and private trading history must not enter prompts or external searches. The repository ignores runtime data, local configuration, plans, outputs, logs, caches, and Claude local settings.

See [docs/GATE_TRADING.md](docs/GATE_TRADING.md), [docs/NO_HALLUCINATION.md](docs/NO_HALLUCINATION.md), and [SECURITY.md](SECURITY.md) for the complete trust and failure model.
