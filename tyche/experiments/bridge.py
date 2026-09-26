"""Stage S2: experiments.

Tyche does not reimplement experiment automation. The default engine drives
openjiuwen's auto_research ``ManagerRuntime`` -- the same runtime JiuwenSwarm's
RSI paper provider uses -- restricted to its science loop:

    experiment_design -> code_implementation -> experiment_execution -> reflection

Its web-search survey and NeurIPS reporting modules are switched off: Tyche's
verified survey is passed in as the research input, and Tyche writes the ICLR
paper itself from the harvested metrics.

Two other engines exist for honest alternatives:

* ``imported`` reads ``*.metrics.json`` files the team produced by other means;
* ``fixture`` serves packaged synthetic metrics for the offline selftest only.
"""

from __future__ import annotations

import contextlib
import functools
import json
import os
import shutil
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any, Iterator, Protocol

import yaml

from tyche.config import ModelSpec
from tyche.planning import ResearchPlan, plan_markdown

_BOOKKEEPING = {
    "status",
    "method",
    "variant",
    "n_questions",
    "per_question",
    "model_call_count",
    "failure_stage",
    "failure_substage",
    "error_type",
    "error_code",
    "detail",
    "seed",
    "notes",
    "model_call_errors",
    "empty_content_retries",
    "n_errors",
    # Run settings and run diagnostics, not results.
    "temperature",
    "top_p",
    "max_tokens",
    "concurrency",
    "batch_size",
    "elapsed_s",
    "elapsed_seconds",
    "wall_time_s",
    "logical_call_count",
    "retry_count",
    "failed_call_count",
    "failed_item_count",
    "failed_item_fraction",
    "n_items",
    "n_seeds",
}

# Maps {metric: bool} by which experiment code marks metrics it could not compute
# (e.g. an empty subset); such a metric's placeholder value is never a result.
_DEFINED_KEYS = ("metric_defined", "metrics_defined", "defined_metrics", "metric_valid")

# Per-item fields that mark an item whose model call failed (not a wrong answer).
_ITEM_ERROR_KEYS = ("error", "model_error", "exception")


@dataclass
class ExperimentOutcome:
    status: str
    engine: str
    variants: dict[str, dict[str, Any]]
    metrics_dir: Path | None = None
    design_path: Path | None = None
    code_dir: Path | None = None
    reflections: list[Path] = field(default_factory=list)
    notes: str = ""
    synthetic: bool = False

    def summary(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "engine": self.engine,
            "synthetic": self.synthetic,
            "variants": sorted(self.variants),
            "notes": self.notes,
            "design_path": str(self.design_path) if self.design_path else None,
            "code_dir": str(self.code_dir) if self.code_dir else None,
            "reflections": [str(p) for p in self.reflections],
        }


class ExperimentEngine(Protocol):
    name: str

    async def run(
        self, plan: ResearchPlan, *, summary_path: Path, work_dir: Path, run_id: str
    ) -> ExperimentOutcome: ...


def read_metrics_dir(path: Path) -> dict[str, dict[str, Any]]:
    """Load ``<variant>.metrics.json`` files; skip failed or empty variants loudly via 'status'."""
    variants: dict[str, dict[str, Any]] = {}
    for file in sorted(path.glob("*.metrics.json")):
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict) or str(data.get("status", "")).lower() == "failed":
            continue
        name = file.name[: -len(".metrics.json")]
        variants[name] = data
    return variants


def failed_items(data: dict[str, Any]) -> tuple[int, int]:
    """(failed, total) per-item rows of one variant; failed rows carry a non-empty error field."""
    items = data.get("per_question")
    if not isinstance(items, list):
        return 0, 0
    failed = sum(1 for item in items if isinstance(item, dict) and any(item.get(k) for k in _ITEM_ERROR_KEYS))
    return failed, len(items)


def numeric_metrics(data: dict[str, Any]) -> dict[str, float]:
    """Top-level numeric metrics of one variant, excluding bookkeeping and undefined metrics."""
    undefined = {
        name
        for key in _DEFINED_KEYS
        if isinstance(data.get(key), dict)
        for name, ok in data[key].items()
        if ok is False
    }
    out: dict[str, float] = {}
    for key, value in data.items():
        if key in _BOOKKEEPING or key in undefined or isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            out[key] = float(value)
    return out


class ImportedEngine:
    """Metrics produced outside Tyche, e.g. by the team's own scripts."""

    name = "imported"

    def __init__(self, results_dir: Path | None, *, synthetic: bool = False, label: str = "imported"):
        self.results_dir = Path(results_dir) if results_dir else None
        self.synthetic = synthetic
        self.name = label

    async def run(self, plan: ResearchPlan, *, summary_path: Path, work_dir: Path, run_id: str) -> ExperimentOutcome:
        if self.results_dir is None:
            return ExperimentOutcome("failed", self.name, {}, notes="no results directory configured; pass --results-dir")
        if not self.results_dir.is_dir():
            return ExperimentOutcome("failed", self.name, {}, notes=f"results directory {self.results_dir} not found")
        target = work_dir / "results"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(self.results_dir, target)
        variants = read_metrics_dir(target)
        design = target / "design.md"
        code = target / "code"
        return ExperimentOutcome(
            status="completed" if len(variants) >= 2 else "failed",
            engine=self.name,
            variants=variants,
            metrics_dir=target,
            design_path=design if design.exists() else None,
            code_dir=code if code.is_dir() else None,
            notes="" if len(variants) >= 2 else "need metrics for at least two variants (proposed + one baseline)",
            synthetic=self.synthetic,
        )


def fixture_engine() -> ImportedEngine:
    path = Path(str(resources.files("tyche.fixtures").joinpath("experiment_results")))
    return ImportedEngine(path, synthetic=True, label="fixture")


@contextlib.contextmanager
def model_environment(spec: ModelSpec) -> Iterator[None]:
    """Expose the experiment model to generated code, which reads API_* env vars."""
    values = {
        "API_KEY": spec.api_key(),
        "API_BASE": spec.api_base,
        "MODEL_NAME": spec.model_name,
        "MODEL_PROVIDER": spec.provider,
        "MODEL_TIMEOUT": str(int(spec.timeout)),
    }
    previous = {key: os.environ.get(key) for key in values}
    try:
        for key, value in values.items():
            if value:
                os.environ[key] = value
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def build_openjiuwen_config(settings: dict[str, Any], spec: ModelSpec) -> dict[str, Any]:
    """Load auto_research's default pipeline config and restrict it to the science loop."""
    resource = resources.files("openjiuwen.rsi.artifact_rsi.paper_opt").joinpath("configs/pipeline.default.yaml")
    config = yaml.safe_load(resource.read_text(encoding="utf-8"))
    modules = {
        "topic_survey": False,
        "experiment_design": True,
        "code_implementation": True,
        "experiment_execution": True,
        "reflection": True,
        "reporting": False,
    }
    config.setdefault("manager", {})["modules"] = dict(modules)
    config.setdefault("pipeline", {})["modules"] = {**modules, "idea_generation": False}
    for key in ("max_rounds", "max_code_retries", "max_design_revisions", "max_execution_retries"):
        if key in settings:
            config["manager"][key] = int(settings[key])
    config["openjiuwen"] = {
        **(config.get("openjiuwen") or {}),
        "base_url": spec.api_base,
        "model": spec.model_name,
        "provider": spec.provider,
        "timeout": spec.timeout,
    }
    return config


def objective_text(plan: ResearchPlan, settings: dict[str, Any]) -> str:
    hyps = "; ".join(f"{h.statement} (expect: {h.prediction})" for h in plan.hypotheses)
    return (
        f"Test these hypotheses: {hyps}. Implement the proposed method '{plan.method_name}' ({plan.method_sketch}) "
        f"and compare it against: {', '.join(plan.baselines)}. Task: {plan.task_description}. "
        f"Report these metrics for every variant: {', '.join(plan.metrics)}. "
        f"Use at most {int(settings.get('max_variants', 4))} variants in total, and name the proposed variant 'proposed'."
    )


def mirror_read_first_inputs(project_root: Path, agent_workspace: Path, run_id: str) -> list[Path]:
    """Copy the files a code-agent instruction lists under "Read First" into its sandbox.

    openjiuwen confines the coding agent's file tools to ``agent_workspace``, but the
    design agent's instruction points it at project-relative paths (``inputs/...`` and
    ``experiments/<run>/manager/...``). Mirroring them at the same relative paths lets
    those reads succeed instead of burning the agent's turns on "access denied".
    Only ``agent_workspace/output`` is promoted to generated code, so copies stay out of it.
    """
    sources = [
        *sorted((project_root / "inputs").glob("*.md")),
        *sorted((project_root / "experiments" / run_id / "manager").glob("*.md")),
        *sorted((project_root / "experiments" / run_id / "design").glob("*.md")),
    ]
    copied = []
    for source in sources:
        target = agent_workspace / source.relative_to(project_root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append(target)
    return copied


def code_implementation_agent(config: dict[str, Any], model: Any, max_iterations: int) -> Any:
    """openjiuwen's CodeImplementationAgent with a usable inner turn budget.

    ``create_code_agent`` defaults to 15 ReAct iterations per invoke, and without a
    completion promise the outer task loop never starts a second round, so one
    validation cycle ends after 15 model calls -- too few to write and smoke-test a
    multi-file experiment. This subclass passes ``max_iterations`` explicitly through
    the factory's public parameter and mirrors the "Read First" inputs into the sandbox.
    """
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.common import workspace as arw
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.code_implementation.agent import (
        CodeImplementationAgent,
    )

    class TycheCodeImplementationAgent(CodeImplementationAgent):
        def _build_coding_agent(self, agent_workspace: Path, *, run_id: str, cycle: int = 1):
            import openjiuwen.harness.subagents as subagents

            mirror_read_first_inputs(arw.project_root(), Path(agent_workspace), run_id)
            original = subagents.create_code_agent
            subagents.create_code_agent = functools.partial(original, max_iterations=max_iterations)
            try:
                return super()._build_coding_agent(agent_workspace, run_id=run_id, cycle=cycle)
            finally:
                subagents.create_code_agent = original

    return TycheCodeImplementationAgent(config, model=model)


class OpenJiuwenEngine:
    name = "openjiuwen"

    def __init__(self, model: Any, spec: ModelSpec, settings: dict[str, Any], subject: ModelSpec | None = None):
        self.model = model
        self.spec = spec
        self.settings = settings
        # The model the generated experiment code calls (via API_* env vars).
        self.subject = subject or spec

    async def run(self, plan: ResearchPlan, *, summary_path: Path, work_dir: Path, run_id: str) -> ExperimentOutcome:
        from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.common import workspace as arw
        from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.experiment_design.agent import (
            ExperimentDesignAgent,
        )
        from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.manager.agent import ManagerAgent
        from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.reflection.agent import ReflectionAgent
        from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.pipeline.manager import ManagerRuntime

        root = work_dir.resolve()
        (root / "inputs").mkdir(parents=True, exist_ok=True)
        shutil.copy2(summary_path, root / "inputs" / "research_summary.md")
        (root / "inputs" / "research_plan.md").write_text(plan_markdown(plan), encoding="utf-8")
        config = build_openjiuwen_config(self.settings, self.spec)
        arw.set_project_root(root)
        manager = ManagerAgent(config, model=self.model, project_root_path=root)
        runtime = ManagerRuntime(
            config,
            manager=manager,
            model=self.model,
            experiment_design=ExperimentDesignAgent(config, model=self.model, project_root_path=root),
            code_implementation=code_implementation_agent(
                config, self.model, int(self.settings.get("code_agent_max_iterations", 80))
            ),
            reflection=ReflectionAgent(config, model=self.model),
        )
        # A fresh manager run per attempt: a rerun must never mix in metrics or reflections
        # from an earlier attempt's variants.
        attempt = 1 + sum(1 for _ in (root / "experiments").glob(f"tyche-{run_id}-a*")) if (root / "experiments").is_dir() else 1
        manager_run_id = f"tyche-{run_id}-a{attempt}"
        with model_environment(self.subject):
            arw.set_project_root(root)
            terminal = await runtime.arun(
                topic=plan.working_title,
                research_paths=["inputs/research_summary.md", "inputs/research_plan.md"],
                run_id=manager_run_id,
                objective=objective_text(plan, self.settings),
                constraints=[str(c) for c in self.settings.get("constraints") or []],
                initial_prompt=plan_markdown(plan),
                task_mode="create_new_paper",
            )
        results = arw.results_dir(manager_run_id)
        variants = read_metrics_dir(results) if results.is_dir() else {}
        current = _latest_execution_variants(manager_run_id)
        if current is not None:
            # results/ can still hold metrics of variants dropped by a later design revision.
            stale = sorted(set(variants) - current)
            variants = {name: data for name, data in variants.items() if name in current}
        else:
            stale = []
        design = arw.experiment_design_path(manager_run_id)
        code = arw.generated_code_dir(manager_run_id)
        reflections = sorted(arw.reflection_dir(manager_run_id).glob("revision-*.md"))
        ok = getattr(terminal, "status", "") == "complete" or bool(getattr(terminal, "completion_satisfied", False))
        return ExperimentOutcome(
            status="completed" if ok and len(variants) >= 2 else "failed",
            engine=self.name,
            variants=variants,
            metrics_dir=results if results.is_dir() else None,
            design_path=design if design.exists() else None,
            code_dir=code if code.is_dir() else None,
            reflections=reflections,
            notes=f"manager run {manager_run_id}: terminal status={getattr(terminal, 'status', '?')} "
            f"reason={getattr(terminal, 'failure_reason', '') or getattr(terminal, 'abort_reason', '')}"
            + (f"; ignored stale variants: {', '.join(stale)}" if stale else ""),
        )


def _latest_execution_variants(manager_run_id: str) -> set[str] | None:
    """Variant names that completed in the manager's latest execution, or None if unknown."""
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.manager.artifacts import try_load_state

    state = try_load_state(manager_run_id)
    execution = getattr(state, "latest_execution", None) if state is not None else None
    if execution is None:
        return None
    return {v.name for v in execution.variants if getattr(v, "process_status", "") == "completed"}
