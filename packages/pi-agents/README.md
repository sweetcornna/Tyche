# Tyche Pi analysis cluster

This workspace is the narrow, single-host integration boundary for Pi Agent
Core `0.84.4`. It runs a fixed semantic-analysis DAG:

```text
orchestrator -> preflight -> (btc-analyst || eth-analyst) -> synthesizer -> reviewer
```

The Node controller owns the topology, timeout, retry, and fail-closed rules.
Each worker receives exactly one `tyche_pi_job/v1` JSON line and emits exactly
one `tyche_pi_result/v1` JSON line. A worker constructs the official Pi
`Agent` with one tool only: `submit_analysis`. No coding-agent package,
shell/file tools, extensions, skills, context discovery, or Pi server/client
protocol is loaded.

Provider and model are required at the call boundary. Model-provider
environment variables are copied only from the explicit allowlist in
`src/env.mjs`; Gate/Binance and other exchange credentials are never copied.
Results are returned as `tyche_pi_cluster/v1` with independent provenance and
are never written to Tyche canonical `data/` artifacts.

Use the exported `runCluster()` for integration. The fixture command is
credential-free and exercises both weekly and daily-compatible DAG framing:

```sh
npm run --workspace @tyche/pi-agents fixture
```
