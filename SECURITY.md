# Security policy

## Supported security boundary

Tyche supports public BTC/ETH market reads, optional read-only production Spot account context for dry-run sizing, manually confirmed Gate USDT-M testnet execution, and venue-explicit automatic Gate/Binance USDT-M testnet execution. Production order mutation is intentionally unsupported.

## Secrets

Use narrowly scoped testnet credentials supplied through environment variables. The Gate Spot key should be read-only. Gate and Binance USDT-M keys must belong to their respective testnets and should have no withdrawal capability. They are forbidden in Claude Code analysis, public-data, and paper processes and are supplied only to the selected testnet process, preferably by an external secret manager. Do not store their values in `.env`, another persistent project file, prompts, or workflow state. Never commit a real environment file, local configuration, plan, ledger, account response, certificate, key, log, or output.

The code rejects credential-shaped configuration keys and does not accept caller-provided hosts, URLs, endpoints, methods, signatures, or raw authorization headers. Error and ledger projections remove secret-shaped fields.

The multi-exchange adapter is the sole exception to Gate's fixed-host transport: its hosts come only from the exact pinned CCXT exchange registry, never from user configuration. The adapter constructs exchanges without credentials and exposes only a fixed public-read method set. It does not call or wrap balance, position, order mutation, deposit, withdrawal, transfer, or private subscription methods. Per-exchange errors are reduced to sanitized error classes before persistence.

## Execution safety

USDT-M testnet submission requires all static and dynamic gates to pass: positive user-defined limits, an unexpired venue-bound sealed plan, exact plan identity, a clear venue kill switch, product-local funding, current exchange rules and quotes, green reconciliation, one-way mode, isolated margin, and proof of configured leverage. Gate manual mode additionally requires explicit commit, an exact confirmation phrase, real TTYs, and absence of unattended markers. Automatic mode requires the selected venue's local `automatic_testnet` configuration and the internal executor capability; no command flag can upgrade a locked configuration.

Every submission is reserved atomically before the network call. A timeout, transport loss, HTTP 408, or server error is ambiguous. Tyche never blindly repeats the submission. Each unresolved cause is keyed to its original event and deterministic client identity. A matching open order is still unresolved, and absence from a bounded order snapshot proves nothing. Resolution requires exact client text, exact venue identity when one exists, a terminal fill/cancel/rejection or definitive exact-endpoint not-found result, and reconciled position/protection state. Each complete receipt is sealed after its evidence is attached; all causes must resolve independently before later submission is allowed. Legacy receipt-link fields are ignored for clearing.

The one-shot automation command is USDT-M paper-only. It first settles existing simulated positions, then collects public evidence, validates canonical analysis, creates a sealed dry-run plan, and applies a conservative simulated fill model. It rejects mutation credentials and non-dry-run configuration, serializes same-date cycles, and refuses any venue submitted/filled claim. The kill switch and paper risk breakers block only new entries; settlement and managed reductions/exits remain available.

Paper state is event-sourced in `data/paper/active.json`, hash-chained, atomically updated, and never reused as Gate account or order state. Paper order/fill identities use `po_`/`pf_` prefixes, lifecycle types are explicitly `SIMULATED_*`, and paper performance never grants testnet authority.

The loopback UI's fixed Paper setup endpoint accepts only eleven scalar user
settings, behind the existing Host/Origin, session and CSRF checks. It can write
only the ignored local configuration and the fixed active Paper file, validates
both, serializes initialization, rejects symbolic links and conflicting existing
state, and never enables venue submission. Its DTO exposes settings and readiness,
not raw account or ledger data. Custom startup files are never rewritten.

Session model credentials remain in memory. Strategy discussion uses the same
restricted provider transport with no tools; prompts and bounded discussion
history remain session-local. Applying a strategy changes only subsequent
semantic analysis input, never capital, risk gates, fixed roles, execution mode
or same-cycle receipt reuse. Provider changes, discussion and cycle launch are
mutually excluded while the model is busy. Connection values and credentials
are checked before model input and excluded from discussion output and errors.

Session role-model configuration accepts only the six fixed roles and the five
Responses model IDs already present in the pinned Pi catalog. Discussion may
propose changes but cannot apply them. Explicit model application is protected
by the same session/CSRF and busy checks as strategy application. A cycle freezes
all effective role choices before its first asynchronous prerequisite check;
the main discussion uses the orchestrator choice. Jobs, result identity checks
and persisted provenance follow each actual role model. Changing models never
changes the semantic schema, credentials, execution gates or receipt reuse.

Protective orders are created only after identifiable fills prove the executed contract count. They are reduce-only and use that proven amount. Tyche has no transfer operation and no account-wide cancellation operation.

## Runtime privacy

Claude prompts should receive public market snapshots and semantic analysis inputs only. Custom workflow agents have read-only tools; they return structured data and do not persist, invoke clients, or run shell commands. Both workflows reject inherited USDT-M testnet credentials before the first agent launch. Do not place credentials, account payloads, plans, ledgers, or private trading history in prompts or external search queries. Runtime artifacts are local and ignored by Git.

## Reporting a vulnerability

Open a private security advisory in the repository host. Do not include active credentials, complete account payloads, or reproducible secrets. Rotate any credential that may have been exposed before sharing sanitized evidence.
