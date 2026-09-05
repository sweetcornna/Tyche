# Weekly crypto strategy

Use a credential-free planning process. Before launching `.claude/workflows/crypto-analysis.mjs`, top-level deterministic code must run the configuration check and create `data/crypto_market.json` for the requested real `date` (`YYYY-MM-DD`) and `isoWeek` (`YYYY-Www`). The workflow itself rejects every Gate or Binance USDT-M testnet credential before launching an agent.

Run the workflow with `tier: "weekly"`. Its read-only subagents return a structured `document`; they do not run commands or write files. The top-level caller must persist that exact document through `scripts/agent-write.mjs`, then render the report with `scripts/concise-report.mjs`. The weekly document must contain `execution_candidates: []`.

If public data is unavailable, incomplete, or stale, stop with the deterministic failure. Do not replace it with remembered market values or private account data. Weekly analysis never plans or submits an order.
