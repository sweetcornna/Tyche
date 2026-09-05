# Multi-exchange public data

## Selected foundation

The adapter uses an exact pinned [CCXT](https://github.com/ccxt/ccxt) release. Its JavaScript registry currently exposes more than 100 exchange adapters and a unified public market interface. Tyche discovers the registry at runtime rather than copying a list that would immediately become stale.

Other reviewed projects remain useful references but do not match this repository's runtime:

| Project | Strength | Reason not selected as Tyche's primary adapter |
|---|---|---|
| [Cryptofeed](https://github.com/bmoscon/cryptofeed) | Normalized WebSocket feeds, replay, and storage backends | Requires Python 3.12 and a second runtime/dependency stack |
| [ccxws](https://github.com/altangent/ccxws) | JavaScript WebSocket normalization | Streaming-focused and narrower than CCXT's current REST registry |
| [XChange](https://github.com/knowm/XChange) | Mature Java abstraction over 60+ exchanges | Requires a Java runtime and does not fit Tyche's Node execution boundary |

## Meaning of “all exchanges”

“All” means every identifier in the installed CCXT registry that can expose at least one active BTC or ETH market supported by Tyche:

- Spot quoted in USDT, falling back to USD when USDT is unavailable.
- Linear perpetual swap quoted and settled in USDT.

The set is capability-driven. An exchange can be registered but return `NO_RELEVANT_MARKETS`, be regionally unavailable, or omit a particular channel. Those outcomes remain explicit in the sealed snapshot.

## Public-only boundary

`scripts/multi-exchange-market.mjs` constructs each exchange with only fixed timeout and rate-limit options. It accepts no credential, custom URL, raw method name, headers, proxy, or exchange-specific parameter object. The only callable exchange methods are:

- `loadMarkets`
- `fetchTicker`
- `fetchOrderBook`
- `fetchOHLCV`
- `fetchTrades`
- `fetchFundingRate`
- `fetchFundingRateHistory`
- `fetchOpenInterest`
- `fetchLiquidations`

The adapter never returns an exchange instance. Account, position, order, transfer, deposit, withdrawal, and private subscription methods are outside its interface and are statically tested as absent from Tyche source.

## Snapshot model

The full `tyche_multi_exchange_market/v1` artifact contains:

- adapter pin and reported runtime version;
- requested channel and exchange counts;
- per-exchange capability, status, normalized BTC/ETH markets, and sanitized error classes;
- normalized rules, ticker, five-level book, candles, trades, funding, open interest, and liquidations when supported;
- cross-venue median price and funding, price dispersion, and best visible bid/ask;
- a SHA-256 snapshot seal.

One exchange failure never deletes another exchange's evidence. A run is `COMPLETE` only when every requested adapter succeeds, `PARTIAL` when usable sources and explicit failures coexist, and `BLOCKED` when no requested exchange provides usable BTC/ETH data.

The full artifact stays in `data/crypto_multi_exchange.json`. `data/crypto_market.json` embeds only `tyche_multi_exchange_summary/v1`: aggregates, counts, adapter provenance, source path, and the full snapshot hash. This keeps the analysis context bounded.

The normal automation preparation command performs paper settlement before invoking this collector. This order is mandatory: a slow or failed cross-venue read must never prevent an existing simulated position from receiving funding, stop, target, or liquidation settlement.

## Trading isolation

Cross-venue data is analytical context only. It can confirm direction, reveal dispersion, compare visible liquidity, and contextualize funding. It cannot size an order or supply an executable price. Gate remains authoritative for paper contract rules and execution evidence. Gate/Binance testnet plans independently re-fetch their venue's signed account, rules, quote, position, order, fill, and protection evidence through fixed native adapters.

## Commands

```sh
npm run market:all -- catalog
npm run market:all -- snapshot --date 2030-01-07 --iso-week 2030-W02 --channels core --out data/crypto_multi_exchange.json
npm run market:all -- snapshot --date 2030-01-07 --iso-week 2030-W02 --channels all --out data/crypto_multi_exchange.json
npm run automation -- prepare --date 2030-01-07 --iso-week 2030-W02 --config config/tyche.local.json --exchanges all --channels core
```

Use `--exchanges` with a comma-separated subset only for diagnostics. The value must be an exact identifier already present in the installed registry. Concurrency is bounded to 1–8 and per-exchange request timeout to 1–30 seconds.
