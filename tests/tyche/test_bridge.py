import json

from tyche.config import TycheConfig
from tyche.experiments import ImportedEngine, fixture_engine
from tyche.experiments.bridge import (
    OpenJiuwenEngine,
    build_openjiuwen_config,
    code_implementation_agent,
    numeric_metrics,
    objective_text,
)
from tyche.planning import ResearchPlan
from tyche.selftest import PLAN


def test_openjiuwen_config_runs_only_the_science_loop():
    spec = TycheConfig.load(env={"MODEL_NAME": "m", "API_BASE": "https://x.invalid"}).model("experiments")
    config = build_openjiuwen_config({"max_rounds": 7}, spec)
    modules = config["manager"]["modules"]
    assert modules["topic_survey"] is False and modules["reporting"] is False
    assert modules["experiment_design"] and modules["code_implementation"] and modules["experiment_execution"]
    assert config["manager"]["max_rounds"] == 7
    assert config["openjiuwen"]["model"] == "m" and config["openjiuwen"]["base_url"] == "https://x.invalid"


def test_objective_names_variants_and_metrics():
    text = objective_text(ResearchPlan.model_validate(PLAN), {"max_variants": 3})
    assert "LedgerMem" in text and "prompt_tokens_per_query" in text and "'proposed'" in text


async def test_imported_and_fixture_engines(tmp_path, results_dir):
    plan = ResearchPlan.model_validate(PLAN)
    outcome = await ImportedEngine(results_dir).run(plan, summary_path=tmp_path / "s.md", work_dir=tmp_path / "w", run_id="r")
    assert outcome.status == "completed" and set(outcome.variants) == {"proposed", "full_context", "sliding_window"}
    assert outcome.design_path is not None and not outcome.synthetic
    fixture = await fixture_engine().run(plan, summary_path=tmp_path / "s.md", work_dir=tmp_path / "f", run_id="r")
    assert fixture.synthetic and fixture.engine == "fixture"
    missing = await ImportedEngine(tmp_path / "nope").run(plan, summary_path=tmp_path / "s.md", work_dir=tmp_path / "m", run_id="r")
    assert missing.status == "failed"
    assert numeric_metrics({"accuracy": 0.5, "status": "completed", "flag": True, "per_question": []}) == {"accuracy": 0.5}


async def test_openjiuwen_engine_drives_manager_runtime_and_harvests(tmp_path, monkeypatch):
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.common import workspace as arw
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.experiment_design import agent as design_mod
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.manager import agent as manager_mod
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.manager.schemas import TerminalReport
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.reflection import agent as reflection_mod
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.pipeline import manager as runtime_mod

    captured = {}

    class Dummy:
        def __init__(self, *args, **kwargs):
            captured.setdefault("constructed", []).append(type(self).__name__)

    class FakeRuntime:
        def __init__(self, config, **kwargs):
            captured["config"] = config
            captured["kwargs"] = sorted(kwargs)

        async def arun(self, **kwargs):
            captured["arun"] = kwargs
            run_id = kwargs["run_id"]
            results = arw.results_dir(run_id)
            results.mkdir(parents=True, exist_ok=True)
            for name, acc in (("proposed", 0.7), ("baseline", 0.5)):
                (results / f"{name}.metrics.json").write_text(json.dumps({"status": "completed", "accuracy": acc}))
            arw.experiment_design_path(run_id).parent.mkdir(parents=True, exist_ok=True)
            arw.experiment_design_path(run_id).write_text("# design")
            return TerminalReport(status="complete", run_id=run_id, completion_satisfied=True)

    monkeypatch.setattr(manager_mod, "ManagerAgent", type("ManagerAgent", (Dummy,), {}))
    monkeypatch.setattr(design_mod, "ExperimentDesignAgent", type("ExperimentDesignAgent", (Dummy,), {}))
    monkeypatch.setattr(reflection_mod, "ReflectionAgent", type("ReflectionAgent", (Dummy,), {}))
    monkeypatch.setattr(runtime_mod, "ManagerRuntime", FakeRuntime)
    monkeypatch.setenv("API_KEY", "test-key")
    spec = TycheConfig.load(env={"MODEL_NAME": "m"}).model("experiments")
    summary = tmp_path / "summary.md"
    summary.write_text("## Short Summary\nx\n")
    engine = OpenJiuwenEngine(object(), spec, {"constraints": ["small"], "max_rounds": 5})
    outcome = await engine.run(ResearchPlan.model_validate(PLAN), summary_path=summary, work_dir=tmp_path / "exp", run_id="r1")
    assert outcome.status == "completed" and set(outcome.variants) == {"proposed", "baseline"}
    assert outcome.design_path.read_text() == "# design"
    assert captured["arun"]["research_paths"][0] == "inputs/research_summary.md"
    assert captured["arun"]["constraints"] == ["small"]
    assert captured["config"]["manager"]["modules"]["reporting"] is False
    assert "code_implementation" in captured["kwargs"]
    assert (tmp_path / "exp" / "inputs" / "research_summary.md").exists()


async def test_openjiuwen_engine_ignores_stale_variants_and_uses_fresh_run_ids(tmp_path, monkeypatch):
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.common import workspace as arw
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.experiment_design import agent as design_mod
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.manager import agent as manager_mod
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.manager.schemas import TerminalReport
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.reflection import agent as reflection_mod
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.pipeline import manager as runtime_mod

    from tyche.experiments import bridge

    run_ids = []

    class FakeRuntime:
        def __init__(self, *args, **kwargs):
            pass

        async def arun(self, **kwargs):
            run_ids.append(kwargs["run_id"])
            results = arw.results_dir(kwargs["run_id"])
            results.mkdir(parents=True, exist_ok=True)
            for name in ("proposed", "baseline", "dropped_old_variant"):
                (results / f"{name}.metrics.json").write_text(json.dumps({"status": "completed", "accuracy": 0.5}))
            return TerminalReport(status="complete", run_id=kwargs["run_id"], completion_satisfied=True)

    Dummy = type("Dummy", (), {"__init__": lambda self, *a, **k: None})
    monkeypatch.setattr(manager_mod, "ManagerAgent", Dummy)
    monkeypatch.setattr(design_mod, "ExperimentDesignAgent", Dummy)
    monkeypatch.setattr(reflection_mod, "ReflectionAgent", Dummy)
    monkeypatch.setattr(runtime_mod, "ManagerRuntime", FakeRuntime)
    monkeypatch.setattr(bridge, "_latest_execution_variants", lambda run_id: {"proposed", "baseline"})
    monkeypatch.setenv("API_KEY", "test-key")
    spec = TycheConfig.load(env={"MODEL_NAME": "m"}).model("experiments")
    summary = tmp_path / "summary.md"
    summary.write_text("## Short Summary\nx\n")
    engine = OpenJiuwenEngine(object(), spec, {})
    plan = ResearchPlan.model_validate(PLAN)
    first = await engine.run(plan, summary_path=summary, work_dir=tmp_path / "exp", run_id="r1")
    second = await engine.run(plan, summary_path=summary, work_dir=tmp_path / "exp", run_id="r1")
    assert set(first.variants) == {"proposed", "baseline"} and "dropped_old_variant" in first.notes
    assert run_ids == ["tyche-r1-a1", "tyche-r1-a2"] and second.status == "completed"


async def test_code_agent_gets_turn_budget_and_readable_inputs(tmp_path):
    from openjiuwen.core.foundation.llm import init_model
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.common import workspace as arw

    import openjiuwen.harness.subagents as subagents

    (tmp_path / "inputs").mkdir()
    (tmp_path / "inputs" / "research_plan.md").write_text("plan")
    manager = tmp_path / "experiments" / "r1" / "manager"
    manager.mkdir(parents=True)
    (manager / "original_task.md").write_text("task")
    arw.set_project_root(tmp_path)
    try:
        spec = TycheConfig.load(env={"MODEL_NAME": "m", "API_BASE": "http://127.0.0.1:9"}).model("experiments")
        model = init_model("OpenAI", "m", "offline-key", "http://127.0.0.1:9", timeout=5)
        agent = code_implementation_agent(build_openjiuwen_config({}, spec), model, 42)
        workspace = arw.agent_workspace_dir("r1").resolve()
        workspace.mkdir(parents=True)
        factory = subagents.create_code_agent
        built = agent._build_coding_agent(workspace, run_id="r1")
        try:
            # openjiuwen's factory default is 15 inner iterations; ours must reach the agent.
            assert built.deep_config.max_iterations == 42
            assert subagents.create_code_agent is factory
            assert (workspace / "inputs" / "research_plan.md").read_text() == "plan"
            assert (workspace / "experiments" / "r1" / "manager" / "original_task.md").read_text() == "task"
            assert not (workspace / "output" / "inputs").exists()
        finally:
            await agent._cleanup_coding_agent(built)
    finally:
        arw.set_project_root(None)


def test_failed_items_gate_stops_confounded_experiments():
    from types import SimpleNamespace

    import pytest

    from tyche.experiments import failed_items
    from tyche.pipeline import Pipeline
    from tyche.workspace import StageError

    ok_rows = [{"correct": True}] * 99 + [{"correct": False, "error": "EmptyContentError"}]
    bad_rows = [{"correct": True}] * 95 + [{"correct": False, "error": "EmptyContentError"}] * 5
    assert failed_items({"per_question": ok_rows}) == (1, 100)
    assert failed_items({"per_question": "n/a"}) == (0, 0)
    fake = SimpleNamespace(cfg=TycheConfig.load())
    Pipeline._check_failed_items(fake, {"proposed": {"per_question": ok_rows}, "base": {"accuracy": 0.5}})
    with pytest.raises(StageError, match="proposed: 5/100 items failed"):
        Pipeline._check_failed_items(fake, {"proposed": {"per_question": bad_rows}})
    assert "model_call_errors" not in numeric_metrics({"model_call_errors": 3, "accuracy": 0.5})


def test_metrics_marked_undefined_are_not_results():
    data = {
        "accuracy": 0.8,
        "accuracy_at_matched_budget": 0.0,
        "metric_defined": {"accuracy": True, "accuracy_at_matched_budget": False},
    }
    assert numeric_metrics(data) == {"accuracy": 0.8}


def test_run_settings_are_not_metrics():
    data = {
        "accuracy": 0.8, "concurrency": 8, "temperature": 0.0, "max_tokens": 8192, "elapsed_s": 12.5,
        "budget_prompt_tokens": 1500, "n_sessions": 80, "call_failure_rate": 0.0,
    }
    assert numeric_metrics(data) == {"accuracy": 0.8}



def test_interrupted_manager_attempt_is_resumed(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.manager import artifacts

    from tyche.experiments.bridge import _resumable_manager_run

    for name in ("tyche-r1-a1", "tyche-r1-a2", "tyche-r1-a10"):
        (tmp_path / "experiments" / name).mkdir(parents=True)
    states = {"tyche-r1-a10": SimpleNamespace(terminal=None)}
    monkeypatch.setattr(artifacts, "try_load_state", lambda run_id: states.get(run_id))
    # The numerically latest attempt (a10, not a2) was interrupted: resume it.
    assert _resumable_manager_run(tmp_path, "r1") == "tyche-r1-a10"
    states["tyche-r1-a10"] = SimpleNamespace(terminal=object())
    assert _resumable_manager_run(tmp_path, "r1") is None
    assert _resumable_manager_run(tmp_path, "other") is None



async def test_code_round_that_changes_nothing_is_retried_with_a_host_instruction(tmp_path, monkeypatch):
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.common import workspace as arw
    from openjiuwen.rsi.artifact_rsi.paper_opt.auto_research.modules.code_implementation import agent as code_mod

    from tyche.experiments.bridge import NOOP_NUDGE, source_digest

    arw.set_project_root(tmp_path)
    try:
        output = arw.agent_workspace_dir("r1").resolve() / "output"
        (output / "outputs").mkdir(parents=True)
        (output / "run.py").write_text("print('v0')")
        seen = []

        async def fake_run(self, inputs):
            seen.append(inputs.extra_host_instructions)
            (output / "outputs" / "smoke.json").write_text(str(len(seen)))  # outputs do not count
            if len(seen) == 2:
                (output / "run.py").write_text("print('v1')")
            return "result"

        monkeypatch.setattr(code_mod.CodeImplementationAgent, "_run_async", fake_run)
        agent = code_implementation_agent({}, object(), 10)
        inputs = type("I", (), {})()
        inputs.plan = type("P", (), {"run_id": "r1"})()
        inputs.extra_host_instructions = "prior"
        inputs.model_copy = lambda update: type("I2", (), {"plan": inputs.plan, **update})()
        before = source_digest(output)
        assert await agent._run_async(inputs) == "result"
        assert seen == ["prior", NOOP_NUDGE + "prior"]
        assert source_digest(output) != before
        assert source_digest(tmp_path / "missing") == ""
    finally:
        arw.set_project_root(None)


def test_planned_metrics_are_never_mistaken_for_settings():
    data = {"max_context_tokens": 512.0, "n_hallucinations": 3, "max_tokens": 8192, "metric_defined": {"n_hallucinations": True}}
    assert numeric_metrics(data) == {}
    assert numeric_metrics(data, keep={"max_context_tokens", "n_hallucinations"}) == {
        "max_context_tokens": 512.0,
        "n_hallucinations": 3.0,
    }
