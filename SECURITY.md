# Security policy

## Supported security boundary

Tyche supports public BTC/ETH market reads, optional read-only production Spot account context for dry-run sizing, manually confirmed Gate USDT-M testnet execution, and venue-explicit automatic Gate/Binance USDT-M testnet execution. Production order mutation is intentionally unsupported.

## Secrets

Use narrowly scoped testnet credentials supplied through environment variables. The Gate Spot key should be read-only. Gate and Binance USDT-M keys must belong to their respective testnets and should have no withdrawal capability. They are forbidden in Claude Code analysis, public-data, and paper processes and are supplied only to the selected testnet process, preferably by an external secret manager. Do not store their values in `.env`, another persistent project file, prompts, or workflow state. Never commit a real environment file, local configuration, plan, ledger, account response, certificate, key, log, or output.

The code rejects credential-shaped configuration keys and does not accept caller-provided hosts, URLs, endpoints, methods, signatures, or raw authorization headers. Error and ledger projections remove secret-shaped fields.

The full loopback control-plane script optionally reads a reusable login token
from the fixed ignored `config/control-plane.token` file with owner-only
permissions. This local login credential is the sole file-based exception; it
does not configure model or exchange credentials. The reader rejects symbolic
links, non-regular files, public permissions, oversized or malformed content,
and read failures. Only a missing file retains the random one-time default.
The reusable core option must be an explicit boolean and requires an explicit
valid token. Each login creates independent random session and CSRF credentials
with the existing 15-minute TTL. A successful relogin revokes the previous cookie's
session, clears its model credentials/settings and closes its event streams;
logout and expiry do the same, and logout clears the browser cookie. Host,
Origin, CSRF and all executor confirmations remain required. Keep reusable tokens
private; they remain valid until the local file is changed or removed and the
service restarts. Never commit their contents.

Session cookie names include the bound port so independent local services do not
replace each other's browser sessions. Read-only `GET /api/session` requires the
fixed `X-Tyche-Session: resume` header plus a live cookie and the existing envelope
checks; it returns session/CSRF metadata with no-store and no CORS permission and
does not rotate credentials or extend TTL. Page reads carry their current CSRF
token as well, so an old tab cannot hydrate another session's settings. A changed
or expired session invalidates page state synchronously, closes its event stream
and excludes late results. Pending endpoint/key pairs remain a single in-memory
draft, separate from the restored server configuration, until the user reviews
and sends again. Recovery never replays configuration, workflow or executor writes.

The multi-exchange adapter is the sole exception to Gate's fixed-host transport: its hosts come only from the exact pinned CCXT exchange registry, never from user configuration. The adapter constructs exchanges without credentials and exposes only a fixed public-read method set. It does not call or wrap balance, position, order mutation, deposit, withdrawal, transfer, or private subscription methods. Per-exchange errors are reduced to sanitized error classes before persistence.

## Execution safety

USDT-M testnet submission requires all static and dynamic gates to pass: positive user-defined limits, an unexpired venue-bound sealed plan, exact plan identity, a clear venue kill switch, product-local funding, current exchange rules and quotes, green reconciliation, one-way mode, isolated margin, and proof of configured leverage. Gate manual mode additionally requires explicit commit, an exact confirmation phrase, real TTYs, and absence of unattended markers. Automatic mode requires the selected venue's local `automatic_testnet` configuration and the internal executor capability; no command flag can upgrade a locked configuration.

Every submission is reserved atomically before the network call. A timeout, transport loss, HTTP 408, or server error is ambiguous. Tyche never blindly repeats the submission. Each unresolved cause is keyed to its original event and deterministic client identity. A matching open order is still unresolved, and absence from a bounded order snapshot proves nothing. Resolution requires exact client text, exact venue identity when one exists, a terminal fill/cancel/rejection or definitive exact-endpoint not-found result, and reconciled position/protection state. Each complete receipt is sealed after its evidence is attached; all causes must resolve independently before later submission is allowed. Legacy receipt-link fields are ignored for clearing.

The one-shot automation command is USDT-M paper-only. It first settles existing simulated positions, then collects public evidence, validates canonical analysis, creates a sealed dry-run plan, and applies a conservative simulated fill model. It rejects mutation credentials and non-dry-run configuration, serializes same-date cycles, and refuses any venue submitted/filled claim. The kill switch and paper risk breakers block only new entries; settlement and managed reductions/exits remain available.

Paper state is event-sourced in `data/paper/active.json`, hash-chained, atomically updated, and never reused as Gate account or order state. Paper order/fill identities use `po_`/`pf_` prefixes, lifecycle types are explicitly `SIMULATED_*`, and paper performance never grants testnet authority.

The loopback UI's fixed Paper setup endpoint accepts only eleven scalar Paper
settings, behind the existing Host/Origin, session and CSRF checks. It can write
only the ignored local configuration and the fixed active Paper file, validates
both, serializes initialization, rejects symbolic links and conflicting existing
state, and never enables venue submission. Its DTO exposes settings and readiness,
not raw account or ledger data. Custom startup files are never rewritten.

The authenticated read-only `GET /api/paper/scene` route has a separate explicit
allowlist DTO for local Paper visualization. It validates the hash-chained fixed
active Paper file, exposes up to two position summaries, twenty active orders and
fifty bounded display events, and retains decimal amounts as strings. It rejects
all query parameters and never accepts a path or venue. The server omits account
identity, raw ledger objects, proof material and source IDs, and performs exact
session-secret redaction after projection. The general projection filter remains
unchanged. The scene endpoint neither writes files nor fetches market data, and
its data is not added to model prompts. Stale/missing valuation is explicitly
represented rather than being converted to zero. GLB/PNG/WebP assets are served
under the existing static path, symlink, same-origin and CSP checks.

Session model credentials remain in memory. Main discussion uses the same
restricted provider transport with no tools. The only added model context is a
safe Paper settings DTO, current strategy/model/effort/theme, and a bounded
session draft/preferences summary; raw accounts, ledgers and execution data are
excluded. Recursive checks cover credentials in raw string values and object
keys before input, after JSON decoding, and when replacing a provider.

The exact discussion protocol distinguishes explanation, clarification and
configuration. Configuration names an explicit subset of fixed setting fields;
the server validates the whole selected candidate before applying it. Inferred
Paper settings require a conversational request/delegation and explicit simulation
assumptions; they do not represent real balances or authorize venue trading.
Partial answers are retained in session memory without initializing an account.
Existing Paper parameters are immutable; conflicts, malformed accounts, custom
startup configs and symbolic links retain the previous fail-closed behavior.
Theme/model/strategy-only changes do not consume an unrelated Paper draft.

The Paper adapter checks the live session before and after synchronous writes
under both existing file locks, then commits session settings at the same
synchronous point. IO failure or expiry before that point rolls back this
operation's files without updating session strategy/models/theme. No await occurs
inside lock callbacks. Discussion and provider changes/cycles remain mutually
excluded; logout or expiry prevents late replies from committing. Only server
application status represents saved settings. Conversation never changes actual
order sizing, execution permissions, testnet arming, kill switches or same-cycle
receipt reuse. Testnet mutation APIs retain their independent confirmation gates.

Session model pools accept at most twelve exact ID/effort declarations, with
bounded IDs and nonempty subsets of medium, high and xhigh. Known Astra/SDK
metadata remains authoritative; incompatible user declarations fail without
remapping. In the Responses and Chat Completions protocols, other IDs use a
restricted custom model definition, unknown context
(the SDK zero sentinel), unpriced cost placeholders and the fixed application
output budget. User IDs are request data, never provider selection, routes,
headers, tools or execution permissions. Every request still uses the same
restricted endpoint/key transport and identical effort mapping.

The session connection explicitly selects one pinned SDK API: OpenAI Responses
(default), OpenAI Chat Completions or Anthropic Messages. The protocol, endpoint
and key commit atomically; a protocol or endpoint change requires an explicit
key. Chat cannot change the protocol.

While connected, candidate pools are checked in full against the saved protocol
before bootstrap, explicitly submitted roles or any settings commit. Preparing an
incompatible pool requires clearing the connection first; disconnected preparation
and retained pending/blocked role references remain supported.

OpenAI base URLs exclude the operation suffix; Anthropic base URLs also exclude a
trailing `/v1`. The shared normalizer checks original URL text before WHATWG URL parsing and
removes only the explicitly selected protocol’s standard operation suffix. Bare
hosts gain HTTPS; an OpenAI root gains `/v1`; explicit gateway prefixes stay intact.
Connection fields are submitted explicitly; editing an address does not discard an
unsaved typed key. Saved keys remain server-side and cannot be reused for a different
endpoint or protocol without explicitly supplying that connection’s key. Canonical
equivalents can reuse a saved key. Native SDKs generate paths and authentication
headers; all three retain the same HTTPS/public-DNS or exact HTTP-loopback,
origin/path-prefix and redirect restrictions.

When system DNS returns only synthetic `198.18.0.0/15` answers for a hostname,
Tyche independently resolves A and AAAA through certificate-verified DNS-over-HTTPS
at the fixed `https://1.1.1.1/dns-query` endpoint. This request carries only the
hostname, never API credentials. Private, mixed, literal benchmark, malformed or
unverified addresses stay rejected. Results are bounded and cached for 30 seconds.
The request socket is pinned to the validated addresses while the original Host
and TLS server name remain intact; it does not perform a second system DNS lookup.
Redirects still cannot receive credentials. DNS, TLS, connection, authentication
and rate-limit failures use separate fixed diagnostics.

Anthropic accepts only native adaptive models from the pinned SDK directory and
efforts expressible unchanged. Unknown aliases, GPT identities, budget-based
thinking and unsupported effort combinations fail closed. OAuth-shaped tokens
are rejected and SDK fallback-model metadata is removed. Validation performs URL,
local DNS and metadata checks without inference. A separate authenticated,
CSRF-protected, exact-body discovery route reads the selected standard models
endpoint with the existing restricted fetch. It has a ten-second deadline, 256-KiB
response bound, 200-entry limit and explicit partial-page status; it follows no
upstream URL and does not loosen the inference query/origin/path/DNS/redirect policy.
Only bounded IDs and fixed local capability projections survive; names, raw
capabilities, descriptions, upstream errors and secret-bearing IDs are discarded.
A provider listing is not an inference/effort verification.
Only fixed allowlisted validation codes receive static public explanations;
unknown errors discard arbitrary codes, messages and stacks.

Pool/mode/bootstrap/manual choices are validated before one synchronous session
commit. Pool-only changes can precede provider configuration, so a custom-only
gateway can bootstrap without an Astra request. Auto pool changes become pending;
only a complete six-role main-model response with bounded reasons clears that
state. Manual mode rejects conversational role writes. Missing pool references
block workflow launch; incompatible model drafts are pruned without consuming
unrelated Paper or strategy drafts. Model-pool operations cannot initialize Paper.
Busy, CSRF, Host/Origin and session lifetime gates remain intact, and new pool,
bootstrap and reason fields participate in recursive current/future secret checks.

Every cycle freezes its protocol, pool, mode and role pairs. Jobs carry a bounded capability
snapshot; worker/result identity validates its digest as well as actual model and
effort and API protocol. The actual resolved model and declared effort are checked before Agent
execution and again by the session transport. Retried jobs retain the same pool
and protocol selections. Receipts retain protocol, capability sources, pool digest, mode and actual
role parameters. No source metadata asserts gateway support, model costs or
unknown context limits. Model changes never alter semantic schemas, trade gates,
credentials or receipt reuse. Logout/expiry clears these session settings.

Protective orders are created only after identifiable fills prove the executed contract count. They are reduce-only and use that proven amount. Tyche has no transfer operation and no account-wide cancellation operation.

## Runtime privacy

Claude prompts should receive public market snapshots and semantic analysis inputs only. Custom workflow agents have read-only tools; they return structured data and do not persist, invoke clients, or run shell commands. Both workflows reject inherited USDT-M testnet credentials before the first agent launch. Do not place credentials, account payloads, plans, ledgers, or private trading history in prompts or external search queries. Runtime artifacts are local and ignored by Git.

## Reporting a vulnerability

Open a private security advisory in the repository host. Do not include active credentials, complete account payloads, or reproducible secrets. Rotate any credential that may have been exposed before sharing sanitized evidence.

Model discovery is serialized with configuration and inference, commits only in
the same live session, and binds its five-minute in-memory catalog to protocol,
canonical endpoint and credential identity. Logout, replacement, clearing and
expiry invalidate its applicability. Stale browser responses cannot replace new
connection drafts; session recovery does not replay discovery. Unknown-only
catalogs do not replace a working connection with an unusable bootstrap. Automatic
selection is bounded and disclosed, marks allocation pending and clears only
incompatible role drafts; manual configuration is never rewritten. The main Agent
receives only the active safe catalog and may select confirmed pairs. An unknown
custom effort proposed by model output remains untrusted until explicitly saved
in the model panel; that declaration preserves catalog expiry and connection
binding. No model-list request invokes inference, Paper or a trading adapter.

Capability declarations are stored separately from the current Agent-selected pool.
Only an explicit model-panel save changes them; local SDK capability projections
are intersected with actual declarations, never an Agent's selected effort subset.
The panel captures a bounded declaration-context ID for its editing target; the
server verifies that ID against the same session's current catalog or connection
before binding the declaration. Expired/replaced targets reject stale saves. The
opaque confirmation ID, endpoint and credential binding never enter model prompts.
Catalog expiry removes listing evidence while preserving declarations for the
confirmed connection; different credentials, endpoints or protocols cannot inherit
them. Pending-connection declarations cannot authorize inference on the old connection.

### Desktop conversation history

The full control-plane CLI retains bounded messages in the fixed ignored file
`data/control/conversations.json`, mode 0600. API requests cannot supply a file
path or account selector. Reads validate schema, size, permissions and symlink
ancestors; updates use revision checks, a file lock and atomic replacement.
History endpoints require the existing session and CSRF protections. Only
whitelisted metadata and validated messages are returned. Credential patterns
and active connection secrets cannot be persisted as conversation content.
An unsaved validated reply remains in the active server session with an explicit
retry-save state; settings already committed are never represented as rolled back.
History survives a fresh login, but credentials and configuration drafts retain
their original session lifetime. Cancellation aborts the SDK and rejects late
results before settings or history writes. Progress events are session-scoped.
