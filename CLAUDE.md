# Tyche Claude Code contract

Tyche is a public, crypto-only project for BTC and ETH. Keep every change within that boundary.

## Trust boundary

- Agents analyze dated evidence and emit semantic candidates only.
- Agents must not choose quantities, notionals, contract counts, leverage, client identifiers, `reduce_only`, HTTP methods, paths, hosts, signatures, or execution status.
- Deterministic scripts validate freshness and schema, size from product-local account evidence, quantize to current venue rules, seal plans, enforce submission gates, and record lifecycle truth.
- Missing, stale, conflicting, or unverifiable data means `NO_TRADE` or a loud blocker. Never reconstruct market values from memory.

## Runtime boundary

- Supported assets are exactly BTC and ETH.
- Spot is dry-run only. There is no Spot mutation operation.
- USDT-M execution is testnet-only and requires a human to run the exact confirmation command in a real terminal.
- Production mutation is unsupported. Do not add a production execution environment, credential name, host mapping, command, compatibility alias, or bypass.
- Workflows require `date` and `isoWeek`, use repository-relative paths, explicitly select `sonnet` or `opus`, and never call the execute command.
- Workflows reject inherited USDT-M testnet credentials before launching agents. Custom workflow agents are read-only and return structured data; deterministic top-level code persists it and may run only dry-run planning.
- USDT-M testnet credentials exist only in a separate human-invoked process, preferably injected by an external secret manager; never place their values in a project env file.
- Do not add schedulers, deployment files, browser/PDF tooling, Python, runtime dependencies, or external orchestration services.

## Data handling

- Credentials come only from environment variables and never enter prompts, plans, reports, logs, ledgers, examples, or committed configuration.
- Account payloads stay in process memory. Persist only the sanitized projections defined by deterministic scripts.
- Runtime data, plans, ledgers, outputs, local settings, caches, and logs remain ignored by Git.
- Agent-generated files use `data/_inbox/` and are validated by `scripts/agent-write.mjs` before becoming canonical runtime artifacts.

## Verification

Run all of the following before describing the repository as ready:

```sh
npm run check
npm test
npm run selftest
git diff --check
```

A passing claim must include the real command output.
