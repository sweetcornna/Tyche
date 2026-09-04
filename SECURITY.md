# Security policy

## Supported security boundary

Tyche supports public BTC/ETH market reads, optional read-only production Spot account context for dry-run sizing, and manually confirmed USDT-M testnet execution. Production order mutation is intentionally unsupported.

## Secrets

Use narrowly scoped Gate credentials supplied through environment variables. The Spot key should be read-only. `GATE_USDM_TESTNET_API_KEY` and `GATE_USDM_TESTNET_SECRET_KEY` must belong to testnet and should have no withdrawal capability. They are forbidden in Claude Code planning/workflow processes and are supplied only to a separate human-invoked process, preferably by an external secret manager. Do not store their values in `.env`, another persistent project file, prompts, or workflow state. Never commit a real environment file, local configuration, plan, ledger, account response, certificate, key, log, or output.

The code rejects credential-shaped configuration keys and does not accept caller-provided hosts, URLs, endpoints, methods, signatures, or raw authorization headers. Error and ledger projections remove secret-shaped fields.

## Execution safety

USDT-M testnet submission requires all static and dynamic gates to pass: a manual-testnet configuration with positive user-defined limits, an unexpired sealed plan, exact plan identity, explicit commit, an exact confirmation phrase, real stdin/stdout TTYs, absence of `CI` and `TYCHE_UNATTENDED`, a clear kill switch, product-local funding, current exchange rules, current quote evidence, a green reconciliation, one-way mode, isolated margin, and proof of the configured leverage.

Every submission is reserved atomically before the network call. A timeout, transport loss, HTTP 408, or server error is ambiguous. Tyche never blindly repeats the submission. Each unresolved cause is keyed to its original event and deterministic client identity. A matching open order is still unresolved, and absence from a bounded order snapshot proves nothing. Resolution requires exact client text, exact venue identity when one exists, a terminal fill/cancel/rejection or definitive exact-endpoint not-found result, and reconciled position/protection state. Each complete receipt is sealed after its evidence is attached; all causes must resolve independently before later submission is allowed. Legacy receipt-link fields are ignored for clearing.

Protective orders are created only after identifiable fills prove the executed contract count. They are reduce-only and use that proven amount. Tyche has no transfer operation and no account-wide cancellation operation.

## Runtime privacy

Claude prompts should receive public market snapshots and semantic analysis inputs only. Custom workflow agents have read-only tools; they return structured data and do not persist, invoke clients, or run shell commands. Both workflows reject inherited USDT-M testnet credentials before the first agent launch. Do not place credentials, account payloads, plans, ledgers, or private trading history in prompts or external search queries. Runtime artifacts are local and ignored by Git.

## Reporting a vulnerability

Open a private security advisory in the repository host. Do not include active credentials, complete account payloads, or reproducible secrets. Rotate any credential that may have been exposed before sharing sanitized evidence.
