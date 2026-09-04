# Gate trading design

## Scope

Tyche accepts only `BTC_USDT` and `ETH_USDT`.

| Product | Reads | Planning | Mutation |
|---|---|---|---|
| Spot | Public production market data; optional signed read-only production account context | Dry-run only | None |
| USDT-M | Public production market data; signed testnet account and order state | Automated paper or venue-bound testnet plan | Gate manual or Gate/Binance automatic testnet only |

A production mutation environment is not represented in configuration, credentials, transport routing, or execution commands.

Supplemental cross-venue analysis uses the exact pinned CCXT registry through `scripts/multi-exchange-market.mjs`. This layer is public and read-only, covers only BTC/ETH Spot and linear USDT-settled perpetual markets, and cannot provide account or execution context. Full records are stored separately; the Gate strategy snapshot receives only sealed aggregates and provenance. Cross-venue prices can inform analysis, but Gate-specific rules, order book, mark candles, risk tiers, and funding evidence remain authoritative for paper simulation and testnet revalidation.

## Trust and interface contract

The analysis boundary emits `crypto_execution_candidate/v1`. A candidate can contain only:

- asset, product, symbol, semantic position intent, and limit-order style;
- entry, stop, target, or a reduction fraction;
- evidence references, source time, anchor week, anchor freshness, and a signal identifier.

Candidates cannot contain quantity, amount, notional, contract count, leverage, client identity, `reduce_only`, an HTTP method, a host, a path, a signature, or execution status. Extra fields fail validation rather than being ignored.

The deterministic boundary performs the following steps:

1. Validate committed/local configuration recursively and reject secret-shaped fields, arbitrary network locations, static account values, unsupported assets, products, and environments.
2. Validate daily schema, timestamp, weekly-anchor relationship, asset/symbol identity, intent, and price geometry.
3. Fetch current fixed-host market rules and quote evidence.
4. Read product-local account context only when enabled and required.
5. Reconstruct bot-managed exposure from identifiable ledger fills, not from an agent claim.
6. Compute risk-based quantity, apply user-defined limits, and quantize to current venue rules.
7. Derive client identity and `reduce_only`, seal the complete plan, and write it atomically.
8. At execution, re-validate the plan and re-fetch account, rules, quote, and reconciliation evidence before any mutation.
9. Reserve the exact intent in the append-only ledger before submission.
10. Record only exchange-proven lifecycle transitions and identifiable fills.

### Planning-process capability boundary

Claude Code workflows are public/read-only analysis processes. Before their first `agent()` call they reject non-empty Gate or Binance USDT-M testnet credentials. Custom workflow agents have `Read` only, return structured data, and cannot run shell commands or write files. The top-level caller creates the public snapshot, persists the exact returned document through deterministic validation, renders reports, and may invoke only dry-run planning.

USDT-M testnet credentials belong only to a separate venue-executor process for signed testnet planning, reconciliation, or submission. Supply them per process, preferably from an external secret manager; do not put values in a project env file. Export visibility inside JavaScript is not treated as a security boundary. Credential absence from analysis and paper processes is the enforced boundary.

## Weekly and daily semantics

Weekly strategy files always contain `execution_candidates: []`. They provide the active strategic anchor only.

A daily entry requires an active canonical `data/crypto_strategy.json` anchor whose `iso_week` matches the requested week, whose timestamp is within the configured weekly window, whose BTC/ETH blocks exist, and whose execution-candidate array is empty. The planner reads this file itself; it does not trust the daily agent-authored `anchor_fresh` boolean. A stale, corrupt, missing, or wrong-week anchor cannot create risk. It may still permit a managed `REDUCE_*` or `EXIT_*` candidate so an old anchor cannot trap an existing position.

Spot supports `ENTER_LONG`, `REDUCE_LONG`, `EXIT_LONG`, and `NO_TRADE`. Spot short entry is rejected. A Spot entry additionally requires the weekly asset `spot_bias` to be `long`.

USDT-M supports long and short entries and direction-specific reductions/exits. Entry direction must match the weekly asset `usdm_bias`; `neutral` or `reduce` does not authorize new risk. Entry geometry must have positive prices, the stop on the losing side, the target on the profitable side, and R:R of at least 1.5.

## Funding and limits

Each product reads only its own account:

- Spot uses production Spot `USDT.available` only and only when `account_read_enabled` is true.
- USDT-M uses testnet USDT futures `available` only.

There is no transfer operation and no fallback from one wallet to another. Raw account responses stay in memory. Persisted projections include only scope, freshness, sanitized available capital, and deterministic epoch identifiers.

The committed configuration is `locked` and leaves execution limits unset. This is intentional: a public template must not invent risk limits. `manual_testnet` and `automatic_testnet` are valid only when every required limit is a positive user-supplied value and configured leverage is an integer from 1 through 3.

Risk quantity is bounded by all of the following:

- account-derived risk capital multiplied by risk-per-trade basis points;
- stop distance;
- per-order notional limit;
- remaining daily new-notional limit;
- remaining managed-notional limit;
- product-local available funds, with leverage affecting margin efficiency but never multiplying the risk budget;
- current minimum/maximum amount and contract rules.

Multiple candidates consume projected daily, managed, and available capacity in order; they do not each receive a fresh copy of the full account. Immediately before submission, current ledger reservations and managed exposure are checked again. The reservation lock repeats the daily-cap check atomically so concurrent processes cannot both spend the same remaining daily allowance.

For USDT-M automation, deterministic selection ignores model ordering. Exits and reductions precede entries; one symbol cannot hold both directions or reverse in the same cycle; existing exposure cannot be increased; and BTC/ETH together are capped at two positions. Competing entries are ranked by R:R descending, entry-to-mark distance ascending, signal ID, then symbol. The exact decision and every rejection are sealed as `selection_proof` and the manual testnet planner re-runs the same selector.

## Sealed plans

The planner canonicalizes the complete plan, sets creation and expiry times, derives a deterministic plan ID, and hashes the plan with SHA-256. Entry plans include digests of the canonical weekly anchor, canonical market snapshot, and every deterministic execution control: risk limits, minimum R:R, freshness windows, plan lifetime, poll timing, submission mode, leverage, account policy, position mode, and margin mode. Any change to an intent, proof, quantity, price, limit, anchor, market snapshot, policy, or lifetime changes the hash.

Execution requires the exact plan file, plan ID, and plan hash. It rereads the canonical daily source, weekly anchor, and market snapshot; recomputes their digests plus the execution-policy digest; and re-derives every intent field from the sealed rule/account proof. A correctly hashed hand-built quantity, contract count, notional, identity, or `reduce_only` value therefore still fails. A later source, anchor, snapshot, or configuration change requires a new entry plan even when the old plan hash remains internally valid. Reduction-only plans keep the stale-anchor exit path but are rechecked against identifiable managed fills. Expired, modified, blocked, derivation-mismatched, anchor-drifted, snapshot-drifted, policy-drifted, or identity-mismatched plans are rejected.

## USDT-M testnet gates

The only mutation path is a sealed USDT-M testnet plan. Both Gate manual mode and the venue-explicit automatic mode require all of these conditions before a client can submit:

- all required user limits are positive;
- the plan is sealed, unexpired, testnet-only, and has no blockers;
- the supplied plan ID and hash match exactly;
- `data/<venue>_KILL` is absent;
- no sticky-red reconciliation exists;
- account, exchange rules, quote, and reconciliation are freshly re-proven;
- account mode is one-way; and
- the contract position proves isolated leverage equal to the configured value, which is no greater than 3.

Gate's retained manual path additionally requires `gate.submission_mode=manual_testnet`, `--commit`, the byte-for-byte confirmation `EXECUTE GATE TESTNET <plan_id> <plan_hash>`, real stdin/stdout TTYs, and no `CI` or `TYCHE_UNATTENDED` marker. Static rejection, including any unsupported environment, happens before client creation and therefore before network activity.

The separate `scripts/testnet-trade.mjs` executor adds venue-bound `automatic_testnet` mode for Gate and Binance. It intentionally omits the manual commit, confirmation, and TTY requirements while preserving the shared plan, dynamic-proof, kill-switch, reservation, no-blind-retry, fill-identity, reduce-only-protection, and sticky-red gates. Each venue has its own ledger and must be selected explicitly; there is no `all` or broadcast execution option. Binance base quantities are represented internally as exact integer lot-step units so the shared sizing and ledger rules remain deterministic.

## One-shot USDT-M paper automation

`scripts/crypto-automation.mjs` automates only USDT-M paper trading. Its `prepare` command first calls the paper settlement engine even if later analysis fails, then collects and seals the requested CCXT registry, records and archives the fixed-host Gate BTC/ETH snapshot with the cross-venue summary, and reports whether the weekly anchor must be refreshed. After the read-only workflow has persisted the required weekly and daily canonical documents, `plan` validates the complete handoff, runs deterministic selection/sizing, and applies the simulated execution model.

The v2 cycle follows `PREPARED → ANCHOR_READY → ANALYZED → PLANNED → PAPER_APPLIED → COMPLETE`, with fail-closed `BLOCKED` exits. It seals summaries of the weekly anchor, daily document, market snapshot, paper policy, pre/post ledger state, plan, and paper receipt. A per-date lock serializes callers; a completed cycle is reused when the active ledger matches its sealed post-state.

The fixed paper ledger `data/paper/active.json` is a hash-chained `tyche_paper_ledger/v1` event stream with atomic writes. All order/fill identifiers use simulation-only prefixes and all lifecycle events are explicitly `SIMULATED_*`. Order-book fills require the opposing displayed price to cross the limit and cannot exceed visible contracts; the fill price remains the conservative plan limit. A later one-minute trade-candle touch is recorded only as a shadow event.

Stop, target, and estimated liquidation are evaluated against paginated one-minute mark-price bars. Liquidation wins a same-minute conflict, then stop wins over target. Missing or discontinuous evidence blocks state progress and new entries. Trading fees use the public taker rate and are labeled estimated. Funding uses the historical settlement rate and mark close, adjusts isolated margin, and is applied once by deterministic event identity. Risk-tier maintenance rate and deduction, isolated margin, and close-fee rate feed the estimated liquidation line; the result never claims to be Gate's actual liquidation engine. See the [Gate futures API](https://www.gate.com/docs/developers/apiv4/en/futures/), [funding explanation](https://miniapp.gate.com/help/futures/futures-logic/27569/funding-rate-and-funding-fee), and [liquidation mechanism](https://miniapp.gate.com/help/futures/futures-logic/22159/liquidation-mechanism).

This is an explicit one-shot command rather than a timer. It has no route to `execute`, cannot produce testnet or production mutations, and cannot turn missing capital or policy values into assumptions. Spot dry-run remains available through `gate-trade plan`, but `/auto-crypto` never invokes it.

## Identity, ambiguity, and ledger

Each order receives a deterministic Gate `text` value derived from product, environment, plan, intent, and leg. The identifier is generated by the script and never accepted from analysis output.

Before a POST, Tyche atomically appends `SUBMISSION_RESERVED`. A second process observing any existing reservation or later state cannot submit the same intent.

Transport loss, timeout, HTTP 408, or HTTP 5xx after submission is ambiguous. Tyche does not retry the POST. An unresolved-cause set is derived from the original `SUBMISSION_AMBIGUOUS` or `RECONCILE_RED` event plus the deterministic client identity and any known venue order ID. Every unresolved cause blocks later plans, including when other causes are already resolved.

A matching known order that is still open is not terminal resolution. Absence from the bounded open/finished-order snapshots is not evidence of rejection. A cause can resolve only with:

- exact client `text` lookup and exact venue order identity when an ID exists;
- terminal identified fills/trades, explicit terminal cancellation, definitive venue rejection, or an exact-order endpoint not-found result that covers every known identity;
- no unknown order state; and
- account position plus reduce-only protection state reconciled to identifiable ledger fills.

Reconciliation clears nothing by default. `status` reports cause IDs; an operator may request exact evidence for one or more IDs with `reconcile ... --resolve-cause <cause-id[,cause-id...]>`. A green snapshot or receipt-ID association alone never clears an ambiguous cause. Legacy `clears_red_id` rows remain readable but have no clearing effect. The complete receipt, including cause evidence, recovered fills, and resolutions, receives a deterministic ID and SHA-256 seal only after all evidence is attached. Tampering or partial evidence fails loudly.

Rate limiting after reservation is also sticky red because the mutation outcome cannot be safely inferred.

The ledger is append-only at the logical level and uses a directory lock plus temp-file rename for each update. An existing empty, zero-byte, or malformed ledger is an error; it is never replaced with an empty default.

## Fill truth and protection

Only an exchange trade identifier plus positive executed quantity and price can create a fill record. A narrative, order acknowledgement, or inferred balance change is not a fill.

After an entry, Tyche fetches identifiable fills and sums the proven contract count. It then creates two USDT-M testnet price orders:

- a stop leg;
- a take-profit leg.

Both are `reduce_only`, use the exact opposite signed contract count, and are created only after the fill proof exists. If both protections cannot be proven active, any created leg is cancelled individually and an exact-size reduce-only emergency close is attempted. Failure or ambiguous state becomes sticky red.

Tyche never performs an account-wide cancellation. Reconciliation and kill-switch handling preserve protective orders.

## Kill switch

For automatic paper trading, `data/gate_KILL` blocks new plans and entries but does not stop settlement, funding, protection, exits, or reductions. For the separate manual testnet executor, it continues to block all submissions. The kill switch itself never cancels an order or removes protection.

## Alternatives rejected

- **Letting the agent choose quantity or leverage** was rejected because prose generation is not a deterministic risk boundary and can be prompt-injected.
- **Supporting a production mutation mode but hiding it behind flags** was rejected because dormant code, hosts, and credential names still form a reachable future bypass surface.
- **Retrying failed POST requests** was rejected because a timeout does not prove the exchange rejected the first request.
- **Using an arbitrary REST request helper** was rejected because caller-controlled method/path/host values erase the endpoint allowlist.
- **Using account position size as bot-owned exposure** was rejected because it can silently absorb manual positions. Managed quantity comes from identifiable Tyche fills and is cross-checked against the account.
- **Auto-setting leverage** was rejected. The executor proves that the user configured one-way isolated leverage on testnet; it does not mutate account leverage as a side effect.
- **Background scheduling or cross-venue broadcast** remains rejected. Automatic testnet execution is an explicit one-shot command for exactly one venue.
