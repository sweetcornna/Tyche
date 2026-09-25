---
name: tyche-paper
description: "Generate a verified ICLR 2027 short paper about LLM agents with the Tyche pipeline (plan, verified survey, experiments, statistics, writing, simulated review, packaging)."
description_cn: 使用 Tyche 流水线自动生成经过核验的 ICLR 2027 格式 Agent 方向科研短论文。
version: "0.1"
---

# Tyche paper generation

Use this skill when the user asks for an automatically generated research paper about LLM agents, in particular on
agent context engineering, agent memory engines, or agent self-evolution, or when they want to review, resume, or
package an existing Tyche run. Tyche is installed with this repository (`tyche` command).

## Rules

- Run `tyche` commands from the repository root. Never write or edit paper content, numbers, or references yourself:
  the pipeline's gates reject numbers that were not computed and citations that were not verified.
- Credentials come from the environment (`API_KEY`, `API_BASE`, `MODEL_NAME`, optionally `S2_API_KEY`). Never print
  or copy their values.
- If a stage fails, report the error line and the run id, then stop. Do not work around a failed gate.

## Steps

1. Check the environment: `tyche doctor`. Fix missing TeX tools or credentials before continuing.
2. Start a run. `--direction` is one of `context_engineering`, `memory_engine`, `self_evolution`:

   ```bash
   tyche run --topic "<topic in the user's words>" --direction memory_engine --stop-after plan
   ```

3. Show the user the plan (`workspace/runs/<run-id>/artifacts/plan_md/`) and ask whether to continue. To change it,
   rerun the plan stage with notes: `tyche run --resume --run-id <run-id> --stage plan --notes "<notes>"`
   (rerunning a stage marks every later stage pending).
4. Continue to the end: `tyche run --resume --run-id <run-id>`. Experiments can take hours; report progress from
   `tyche status --run-id <run-id>`.
5. When the user already has experiment outputs, use them instead of the automatic experiment loop:
   `tyche run --resume --run-id <run-id> --engine imported --results-dir <dir-with-metrics-json>`.
6. Report the paper path (`package/paper.pdf` in the run directory, or `paper_UNVERIFIED.pdf` if the user chose
   `--allow-gate-failures`), the gate status, and the review composite from `run_report.md`. Remind the user that the
   composite is Tyche's own signal, not a paperreview.ai score.

To keep the cross-run writing lessons visible in JiuwenSwarm's `/evolve_list`, pass
`--export-skill-dir ~/.jiuwenswarm/agent/workspace/skills/tyche-paper` to `tyche run`.
