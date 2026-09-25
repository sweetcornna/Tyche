import json

from tyche.config import TycheConfig
from tyche.experiments import ImportedEngine, fixture_engine
from tyche.experiments.bridge import OpenJiuwenEngine, build_openjiuwen_config, numeric_metrics, objective_text
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
