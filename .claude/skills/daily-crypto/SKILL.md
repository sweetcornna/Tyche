# Daily crypto tactics

Use a credential-free planning process. Before launching `.claude/workflows/crypto-analysis.mjs`, top-level deterministic code must validate configuration and create the current public `data/crypto_market.json` for the requested real `date` (`YYYY-MM-DD`) and `isoWeek` (`YYYY-Www`). The workflow rejects either USDT-M testnet credential before launching an agent.

Run the workflow with `tier: "daily"`. Its read-only subagents return a structured `document`; they do not run commands or write files. The top-level caller must persist that exact document through `scripts/agent-write.mjs`, render it with `scripts/concise-report.mjs`, and may then invoke only the deterministic Spot and USDT-M `dry-run` planning commands. It must not submit.

A same-week active anchor is required for new risk. A stale or missing anchor permits only a managed reduction/exit candidate or `NO_TRADE`. Spot short entry is forbidden. Every proposed entry/stop/target must be copied from one complete current snapshot level set and survive the script-enforced R:R minimum.
