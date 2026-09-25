import json
from pathlib import Path

import pytest

from tyche.cli import build_parser, main
from tyche.selftest import run_selftest

from .conftest import needs_latex


def test_cli_parser_and_status_on_empty_workspace(tmp_path, capsys):
    args = build_parser().parse_args(["run", "--topic", "t", "--direction", "memory_engine", "--stop-after", "plan"])
    assert args.stop_after == "plan"
    assert main(["status", "--workspace", str(tmp_path)]) == 0
    assert main(["run", "--workspace", str(tmp_path), "--resume"]) == 2
    assert "--resume needs --run-id" in capsys.readouterr().err


@needs_latex
async def test_selftest_end_to_end_and_resume(tmp_path):
    summary = await run_selftest(root=tmp_path, echo=lambda *a: None)
    assert summary["ok"], summary
    assert summary["gates_passed"] and summary["main_pages"] <= 5
    assert summary["review_rounds"][0][0] == 0 and summary["drifted_artifacts"] == []
    run_dir = tmp_path / "runs" / "selftest"
    state = json.loads((run_dir / "state.json").read_text())
    assert all(row["status"] == "done" for row in state["stages"].values())
    manifests = list((run_dir / "write" / "context_manifests").glob("*.json"))
    assert manifests and all("budget" in json.loads(m.read_text()) for m in manifests)
    report = (run_dir / "package" / "run_report.md").read_text()
    assert "SYNTHETIC FIXTURE" in report
    provenance = json.loads((run_dir / "package" / "provenance.json").read_text())
    names = {a["name"] for a in provenance["artifacts"]}
    assert {"plan", "refs_bib", "experiment_results", "analysis", "draft", "paper_pdf", "ledger"} <= names
    assert Path(summary["pdf"]).exists()


@needs_latex
async def test_selftest_twice_promotes_lessons(tmp_path):
    first = await run_selftest(root=tmp_path / "a", echo=lambda *a: None)
    assert first["lessons"] == ["candidate"]
    # A second run sharing the same memory database must see and promote the lesson.
    import shutil

    shutil.copy2(tmp_path / "a" / "memory.db", tmp_path / "memory.db")
    second_root = tmp_path / "b"
    second_root.mkdir()
    shutil.copy2(tmp_path / "memory.db", second_root / "memory.db")
    second = await run_selftest(root=second_root, echo=lambda *a: None, run_id="selftest-2")
    assert second["ok"]
    assert "active" in second["lessons"]


async def test_package_refuses_unverified_paper(tmp_path):
    from tyche.config import TycheConfig
    from tyche.llm import UsageMeter
    from tyche.pipeline import Pipeline, Services
    from tyche.workspace import StageError, Workspace

    ws = Workspace.create(tmp_path, "r", topic="t", direction="memory_engine", config_digest="x")
    pdf = tmp_path / "p.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    pdf_rec = ws.save_file("paper_pdf", pdf, stage="review")
    src = tmp_path / "src"
    src.mkdir()
    (src / "main.tex").write_text("x")
    src_rec = ws.save_tree("paper_source", src, stage="review")
    blocker = {"severity": "blocker", "gate": "number", "section": "experiments", "message": "number 9.9 unknown"}
    gates_rec = ws.save_json("gates", {"passed": False, "findings": [blocker]}, stage="review")
    ws.set_meta(review_outputs={"gates": gates_rec.id, "paper_pdf": pdf_rec.id, "paper_source": src_rec.id})
    services = Services(planner=None, writer=None, reviewer=None, searchers=[], verifier=None, s2=None, engine=None,
                        meter=UsageMeter())
    pipe = Pipeline(TycheConfig.load(env={}), ws, services, memory=None, direction={}, echo=lambda *a: None)
    with pytest.raises(StageError, match="gate blocker"):
        await pipe.stage_package()


def _pipeline(tmp_path, ws, **kwargs):
    from tyche.config import TycheConfig
    from tyche.llm import UsageMeter
    from tyche.pipeline import Pipeline, Services

    services = Services(planner=None, writer=None, reviewer=None, searchers=[], verifier=None, s2=None, engine=None,
                        meter=UsageMeter(), model_names=["test-model"])
    return Pipeline(TycheConfig.load(env={}), ws, services, memory=None, direction={}, echo=lambda *a: None, **kwargs)


async def test_package_never_ships_a_pdf_from_an_earlier_review(tmp_path):
    from tyche.workspace import StageError, Workspace

    ws = Workspace.create(tmp_path, "r", topic="t", direction="memory_engine", config_digest="x")
    pdf = tmp_path / "old.pdf"
    pdf.write_bytes(b"%PDF-1.4 old")
    ws.save_file("paper_pdf", pdf, stage="review")  # left over from an earlier review run
    gates_rec = ws.save_json("gates", {"passed": True, "findings": []}, stage="review")
    ws.set_meta(review_outputs={"gates": gates_rec.id, "paper_pdf": None, "paper_source": None})
    with pytest.raises(StageError, match="no compiled paper"):
        await _pipeline(tmp_path, ws).stage_package()


@needs_latex
async def test_unverified_package_is_recompiled_with_an_unverified_statement(tmp_path):
    from tyche.paper.latex import PaperSource, compile_pdf, pdf_text, write_build
    from tyche.workspace import Workspace

    ws = Workspace.create(tmp_path, "r", topic="t", direction="memory_engine", config_digest="x")
    bib = tmp_path / "refs.bib"
    bib.write_text("@misc{k1, title={A}, author={B, C}, year={2024}}\n")
    src = PaperSource(title="Tiny", abstract="An abstract.", sections={"introduction": "Hello \\citep{k1}."},
                      ai_statement="Original statement.", reproducibility="Repro.")
    build = tmp_path / "build"
    result = compile_pdf(write_build(src, build, bib_path=bib, figures=[]))
    assert result.ok
    pdf_rec = ws.save_file("paper_pdf", result.pdf, stage="review")
    src_rec = ws.save_tree("paper_source", build, stage="review")
    blocker = {"severity": "blocker", "gate": "number", "section": "experiments", "message": "number 9.9 unknown"}
    gates_rec = ws.save_json("gates", {"passed": False, "findings": [blocker]}, stage="review")
    ws.save_json("ledger", {"reflag_cap": 2, "entries": []}, stage="review")
    ws.set_meta(review_outputs={"gates": gates_rec.id, "paper_pdf": pdf_rec.id, "paper_source": src_rec.id})
    info = await _pipeline(tmp_path, ws, allow_gate_failures=True).stage_package()
    assert info["verified"] is False and info["pdf"].endswith("paper_UNVERIFIED.pdf")
    text = pdf_text(Path(info["pdf"]))
    assert "UNVERIFIED" in text and "Original statement" not in text
    record = ws.run_dir / "package" / "run_record"
    assert (record / "artifacts").is_dir() and (record / "state.json").exists()


def test_rerunning_a_stage_resets_every_later_stage(tmp_path):
    from tyche import STAGES
    from tyche.workspace import Workspace

    ws = Workspace.create(tmp_path, "r", topic="t", direction="memory_engine", config_digest="x")
    for stage in STAGES:
        ws.mark_stage(stage, "done")
    assert ws.reset_from("write") == ["write", "review", "evolve", "package"]
    assert [ws.stage_status(s) for s in STAGES] == ["done"] * 4 + ["pending"] * 4


def test_resume_keeps_the_run_config_and_rejects_mismatched_reuse(tmp_path, monkeypatch, capsys):
    import tyche.cli as cli
    from tyche.workspace import Workspace, write_json_atomic

    root = tmp_path / "ws"
    ws = Workspace.create(root, "r1", topic="topic A", direction="memory_engine", config_digest="x")
    saved = cli._config(cli.build_parser().parse_args(
        ["run", "--workspace", str(root), "--engine", "imported", "--results-dir", str(tmp_path)]))
    write_json_atomic(ws.run_dir / "config.json", saved.data)
    seen = {}

    def fake_services(config):
        seen["engine"] = config.get("experiments.engine")
        seen["results_dir"] = config.get("experiments.results_dir")
        raise cli.ConfigError("stop before running")

    monkeypatch.setattr(cli, "build_services", fake_services)
    assert cli.main(["run", "--workspace", str(root), "--run-id", "r1", "--resume"]) == 2
    assert seen == {"engine": "imported", "results_dir": str(tmp_path.resolve())}
    code = cli.main(["run", "--workspace", str(root), "--run-id", "r1", "--resume-if-exists",
                     "--topic", "topic B", "--direction", "memory_engine"])
    assert code == 2 and "different topic" in capsys.readouterr().err
