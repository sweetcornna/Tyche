# Automatic USDT-M testnet execution

Tyche can automatically place BTC/ETH USDT-M testnet orders on Gate or Binance. It cannot place production orders. Production REST hosts remain represented only for public market reads; mutation definitions, credential names, and executor environments are testnet-only.

## Enable one venue

Copy `config/tyche.json` to the ignored `config/tyche.local.json`. In exactly the venue you intend to run:

- set `enabled` and `usdm.enabled` to `true`;
- set `submission_mode` to `automatic_testnet`;
- set `usdm.environment` to `testnet`;
- explicitly provide `configured_leverage` from 1 through 3 and all four positive risk/notional limits.

No capital, leverage, risk, or notional default is supplied. Gate and Binance blocks are independent. The command requires `--venue gate` or `--venue binance`; it does not accept `all`.

Inject only the selected testnet credentials into the command process:

```text
Gate:    GATE_USDM_TESTNET_API_KEY / GATE_USDM_TESTNET_SECRET_KEY
Binance: BINANCE_USDM_TESTNET_API_KEY / BINANCE_USDM_TESTNET_SECRET_KEY
```

Do not write values into `.env`, configuration, prompts, logs, or committed files. Gate testnet uses `api-testnet.gateapi.io`; Binance USD-M testnet uses `testnet.binancefuture.com`. The public interfaces use Gate's production public API and Binance `fapi.binance.com`, but neither adapter exposes a production mutation.

## Commands

Create a signed-account, blocker-free sealed plan without submitting:

```sh
npm run trade:testnet -- plan --venue <gate|binance> --source data/crypto_daily.json --date <YYYY-MM-DD> --iso-week <YYYY-Www> --config config/tyche.local.json
```

Plan and execute in one explicit process:

```sh
npm run trade:testnet -- cycle --venue <gate|binance> --source data/crypto_daily.json --date <YYYY-MM-DD> --iso-week <YYYY-Www> --config config/tyche.local.json
```

Execute an already sealed, unexpired plan:

```sh
npm run trade:testnet -- execute --venue <gate|binance> --plan <plan.json> --config config/tyche.local.json
```

The plan is sealed to the venue, current daily/weekly/market evidence, account epoch, rules, quote, selection proof, and risk policy. The executor revalidates all of them before mutation.

## Lifecycle and failure behavior

Before a POST, the venue ledger atomically records an exact deterministic reservation. Timeouts, transport loss, HTTP 408, 429 after reservation, and server errors are never blindly retried. The executor queries the exact client identity; unresolved outcomes become sticky red and stop later submissions.

Filled entries require identifiable venue trades. Only the proven filled amount can create reduce-only stop-loss and take-profit protection. If protection cannot be proven active, Tyche attempts an exact-size reduce-only emergency close and remains red until evidence is reconciled.

The ledgers are `data/testnet/gate_order_ledger.json` and `data/testnet/binance_order_ledger.json`. `data/gate_KILL` and `data/binance_KILL` block new plans and every later submission for their venue; they do not cancel orders. Review venue state before removing a kill switch or resolving a sticky-red cause.
