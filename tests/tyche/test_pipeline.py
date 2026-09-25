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
    ws.save_file("paper_pdf", pdf, stage="review")
    blocker = {"severity": "blocker", "gate": "number", "section": "experiments", "message": "number 9.9 unknown"}
    ws.save_json("gates", {"passed": False, "findings": [blocker]}, stage="review")
    services = Services(planner=None, writer=None, reviewer=None, searchers=[], verifier=None, s2=None, engine=None,
                        meter=UsageMeter())
    pipe = Pipeline(TycheConfig.load(env={}), ws, services, memory=None, direction={}, echo=lambda *a: None)
    with pytest.raises(StageError, match="gate blocker"):
        await pipe.stage_package()
