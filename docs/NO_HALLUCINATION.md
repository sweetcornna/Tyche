# No-hallucination contract

## One-vote veto

Every tradable number must come from a dated runtime source or a deterministic calculation over dated runtime sources. If a required value is missing, stale, internally inconsistent, or cannot be tied to the requested asset and product, the result is `NO_TRADE` or a loud blocker.

Agents must never reconstruct prices, indicators, funding, position size, leverage, entries, stops, targets, account values, exchange rules, fills, or order state from memory, training data, previous reports, or prose context.

## Agent output

Agents may state directional analysis and may propose semantic entry/stop/target values only when those values are copied from the current public market snapshot and cite the snapshot fields used. Agents may not calculate or emit quantities, notionals, contracts, leverage, identities, signatures, endpoints, `reduce_only`, or lifecycle state.

Weekly analysis emits no execution candidates. Daily entries require a fresh weekly anchor. A missing or stale anchor allows only managed reduction/exit candidates.

## Deterministic output

Scripts re-check all candidate values against current exchange data. Every entry/stop/target triple must match one complete deterministic level set in the canonical market snapshot, and the plan seals that snapshot digest. They do not trust a schema declaration, a success flag, or an agent assertion. The deterministic layer owns:

- supported asset/product identity;
- source and anchor freshness;
- R:R and price geometry;
- account scope and capital projection;
- precision and quantity;
- plan identity and expiry;
- submission eligibility;
- order and fill lifecycle truth.

An order is `SUBMITTED` only after an exchange acknowledgement or exact-identity recovery. A position is `FILLED` only after an identifiable trade record proves quantity and price. If the outcome of a mutation is ambiguous, report `RECONCILE_RED`; never rewrite it as rejected, retried, or successful.

## Reporting language

When nothing was submitted, reports must state that no order was sent to a trading venue. `PLANNED`, `BLOCKED`, and `NO_TRADE` must not be described as working, accepted, placed, or filled.
