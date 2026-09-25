---
name: tyche-iclr-paper
description: |
  Runs the Tyche pipeline as a staged SwarmFlow that produces a verified ICLR-format short paper, with optional human approval of the plan.
  Use when the user wants the team to write an ICLR short research paper about LLM agents with stage-by-stage progress.
  Do NOT use for hand-editing an existing paper or for non-agent research topics.
description_cn: 以分阶段 SwarmFlow 运行 Tyche 科研论文流水线（选题规划→文献核验→实验→分析→ICLR 短论文写作→模拟评审修订→经验演进→打包），可选人工审批研究计划。
version: "0.1"
kind: swarm-skill
---

# Tyche ICLR Short-Paper Swarm

A sequential pipeline with hard handoffs. Every stage is executed by the deterministic `tyche` command line; each stage agent only runs the command for its stage and reports the recorded state. Evidence rules (verified citations, numbers traced to computed results, compile and page-limit checks) are enforced inside `tyche`, never by the stage agents.

## Workflow

0. **Pre-flight** — `tyche doctor` must pass in the repository root: TeX toolchain present, `API_KEY` set, literature APIs reachable.
1. **Plan** — create the run and stop after the research plan. When `review_plan` is true, a human approves the plan or supplies notes; notes trigger a re-plan.
2. **Survey** — retrieve, screen, and verify literature from arXiv, Semantic Scholar, and OpenAlex.
3. **Experiments** — run openJiuwen's experiment loop (design, code, execute, reflect) or read imported metrics.
4. **Analysis** — compute statistics, the allowed-numbers registry, tables, and figures.
5. **Writing** — draft the ICLR 2027 short paper section by section.
6. **Review** — seven-dimension review panel plus fidelity auditor; revise until the target score, a plateau, or the round limit.
7. **Package** — distill cross-run lessons, then package the PDF with provenance; refuses when a gate blocker remains.

Arguments: `topic` (required), `direction` (`context_engineering`, `memory_engine`, or `self_evolution`), optional `run_id`, `engine` (`openjiuwen` or `imported`), `results_dir`, `review_plan` (boolean).

## Files

- [scripts/workflow.py](scripts/workflow.py) — the SwarmFlow orchestration script.
