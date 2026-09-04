# Daily crypto tactics

Use a credential-free planning process. Before launching `.claude/workflows/crypto-analysis.mjs`, top-level deterministic code must validate configuration, collect the sealed CCXT multi-exchange BTC/ETH public snapshot, and create the current Gate `data/crypto_market.json` with only the cross-venue aggregate embedded for the requested real `date` (`YYYY-MM-DD`) and `isoWeek` (`YYYY-Www`). The workflow rejects every Gate or Binance USDT-M testnet credential before launching an agent.

Run the workflow with `tier: "daily"`. Its read-only subagents return a structured `document`; they do not run commands or write files. The top-level caller must persist that exact document through `scripts/agent-write.mjs` and render it with `scripts/concise-report.mjs`. When invoked through `/auto-crypto`, it may then run deterministic USDT-M-only selection, planning, and paper application. It must not invoke Spot planning or submit to Gate.

A same-week active anchor is required for new risk. A stale or missing anchor permits only a managed reduction/exit candidate or `NO_TRADE`. Spot short entry is forbidden. Every proposed entry/stop/target must be copied from one complete current snapshot level set and survive the script-enforced R:R minimum.
