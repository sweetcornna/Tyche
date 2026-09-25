"""Stage S0: decompose a topic into a falsifiable short-paper research plan."""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field

from tyche.llm import LLMClient, complete_json
from tyche.memory import Block, MemoryStore, memory_block, pack
from tyche.prompts import load_prompt


class Hypothesis(BaseModel):
    statement: str = Field(description="A claim the experiments can support or refute.")
    prediction: str = Field(description="The measurable outcome that would support it.")


class ResearchPlan(BaseModel):
    working_title: str
    problem: str
    motivation: str
    research_questions: list[str] = Field(min_length=1, max_length=3)
    hypotheses: list[Hypothesis] = Field(min_length=1, max_length=3)
    method_name: str = Field(description="Short name for the proposed method, e.g. an acronym.")
    method_sketch: str
    baselines: list[str] = Field(min_length=1, max_length=4)
    experiment_family: str
    task_description: str
    metrics: list[str] = Field(min_length=1, max_length=4)
    contributions: list[str] = Field(min_length=2, max_length=4)
    scope_limits: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list, max_length=8)
    search_queries: list[str] = Field(min_length=3, max_length=10)


async def make_plan(
    llm: LLMClient,
    *,
    topic: str,
    direction: dict[str, Any],
    memory: MemoryStore,
    run_id: str,
    budget: int,
    operator_notes: str = "",
) -> tuple[ResearchPlan, dict[str, Any]]:
    blocks = [
        Block("topic", topic, required=True),
        Block(
            "direction_preset",
            json.dumps(
                {
                    key: direction.get(key)
                    for key in ("title", "summary", "experiment_families", "angle_hints", "canonical_works")
                },
                ensure_ascii=False,
                indent=2,
            ),
            required=True,
        ),
        memory_block(
            memory,
            "lessons_from_previous_runs",
            topic,
            kinds=["lesson", "preference"],
            run_id=run_id,
            limit=6,
            priority=20,
            extra_filter=lambda item: item.meta.get("status", "active") == "active",
        ),
    ]
    if operator_notes.strip():
        blocks.append(Block("operator_notes", operator_notes, required=True))
    context = pack(blocks, budget)
    plan = await complete_json(
        llm,
        system=load_prompt("plan_system"),
        user=context.text,
        schema=ResearchPlan,
        purpose="plan",
    )
    memory.add(
        "decision",
        f"Proposed method {plan.method_name}: {plan.method_sketch}",
        provenance="inferred",
        run_id=run_id,
        title="research plan",
        tags=["plan", *plan.keywords],
    )
    return plan, context.manifest()


def plan_markdown(plan: ResearchPlan) -> str:
    lines = [
        f"# {plan.working_title}",
        "",
        f"**Problem.** {plan.problem}",
        "",
        f"**Motivation.** {plan.motivation}",
        "",
        "## Research questions",
        *[f"- {q}" for q in plan.research_questions],
        "",
        "## Hypotheses",
        *[f"- {h.statement} (prediction: {h.prediction})" for h in plan.hypotheses],
        "",
        f"## Method: {plan.method_name}",
        plan.method_sketch,
        "",
        "## Evaluation",
        f"- Experiment family: {plan.experiment_family}",
        f"- Task: {plan.task_description}",
        f"- Baselines: {', '.join(plan.baselines)}",
        f"- Metrics: {', '.join(plan.metrics)}",
        "",
        "## Intended contributions",
        *[f"- {c}" for c in plan.contributions],
    ]
    if plan.scope_limits:
        lines += ["", "## Scope limits", *[f"- {s}" for s in plan.scope_limits]]
    return "\n".join(lines) + "\n"
