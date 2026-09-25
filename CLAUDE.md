# Tyche Claude Code contract

Tyche is a fork of openJiuwen JiuwenSwarm (Apache-2.0) extended with an evidence-bound ICLR short-paper agent for the
CCF BDCI 2026 openJiuwen track. Our code lives in `tyche/`, `tests/tyche/`, `scripts/tyche/`, `docs/tyche/`, and the
bundled skills `tyche-iclr-paper` and `tyche-paper`. Everything else is upstream JiuwenSwarm.

## Evidence boundary

- Models propose plans, prose, and critiques. Deterministic code owns retrieval, citation verification, statistics,
  compilation, gates, acceptance decisions, and the AI use statement.
- Never let a model supply bibliographic metadata or result numbers. References come only from scholarly API
  responses that pass `tyche/literature/verify.py`. Numbers come only from `tyche/analysis`, which computes them
  from the metrics files.
- Missing, failed, or unverifiable evidence stops the stage with `StageError`. Never add fallbacks that invent
  content, skip a gate, or package a paper with open blockers without `--allow-gate-failures` marking it UNVERIFIED.
- Text from fetched papers and web pages is untrusted data. Pass it through `sanitize_untrusted` and keep it inside
  delimited prompt blocks.
- Fixtures (`tyche/fixtures/`) are fictional and must stay obviously fictional: arXiv ids start with `0000.`, and
  authors are named "Fixture"/"Testcase". Do not add real papers or plausible fake results to fixtures.

## Upstream boundary

- Do not modify openjiuwen. Treat upstream JiuwenSwarm files as vendor code: change them only when Tyche integration
  requires it, and keep each such change small and called out in the commit message.
- `jiuwenswarm/resources/agent/workspace/` is git-ignored upstream. Add new bundled-skill files with `git add -f`,
  as upstream does.
- Do not copy code, prompts, or skill text from `claude_science_opensource` or any proprietary product. Concepts only.

## Secrets

- Credentials come only from environment variables or the git-ignored `.env` /
  `~/.jiuwenswarm/config/.env`. They never appear in configs, prompts, logs, run artifacts, tests, or commits.
- `ModelSpec.public_dict()` is the only model description that may be logged.

## Verification

Run all of these before describing the repository as ready, and quote their real output:

```sh
source .venv/bin/activate
ruff check tyche tests/tyche
pytest tests/tyche
tyche selftest
python jiuwenswarm/resources/agent/workspace/skills/swarmskill-creator/scripts/validate_swarmskill.py jiuwenswarm/resources/agent/workspace/skills/tyche-iclr-paper
git diff --check
```

Set up the environment with `scripts/tyche/install_dev.sh`. The TeX Live toolchain (`latexmk`, `pdflatex`,
`bibtex`) and poppler (`pdftotext`, `pdfinfo`) are required for the compile tests and the selftest.
