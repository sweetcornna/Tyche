# Gate deterministic boundary

Use this skill for local status, dry-run planning, read-only USDT-M testnet reconciliation, or explaining the manual testnet procedure.

Workflow agents do not run commands. A top-level caller may run only `status`, dry-run `plan`, or `reconcile`; workflows never create signed clients and never run `execute`. `status` lists unresolved cause IDs. `reconcile` clears none by default; `--resolve-cause <cause-id[,cause-id...]>` requests exact terminal evidence for named causes, and all unresolved causes continue blocking execution.

After a human reviews a blocker-free sealed USDT-M testnet plan, the human may start a separate real terminal process with `GATE_USDM_TESTNET_API_KEY` and `GATE_USDM_TESTNET_SECRET_KEY` injected for that process only, preferably by an external secret manager, and run the following after replacing each placeholder with the exact values printed by the planner:

```sh
node scripts/gate-trade.mjs execute --plan <plan-file> --plan-id <plan-id> --hash <plan-hash> --commit --confirm "EXECUTE GATE TESTNET <plan-id> <plan-hash>" --config config/tyche.local.json
```

Do not normalize, shorten, or paraphrase the confirmation. The plan must be unexpired and the ID/hash must match. The command still refuses unless the local configuration is `manual_testnet`, all user limits are positive, the terminal is interactive, the kill switch is clear, and fresh account/rules/quote/reconciliation/mode/leverage proofs are green.

Spot has no execution command path. Never suggest an account transfer, account-wide cancellation, production mutation, or unattended execution.
