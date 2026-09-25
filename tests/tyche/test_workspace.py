import pytest

from tyche.workspace import StageError, Workspace


def test_artifacts_are_versioned_and_hashed(workspace):
    first = workspace.save_json("plan", {"a": 1}, stage="plan")
    second = workspace.save_json("plan", {"a": 2}, stage="plan", inputs=[first.id])
    assert (first.version, second.version) == (1, 2)
    assert second.parent == first.id
    assert workspace.load_json("plan") == {"a": 2}
    assert workspace.verify_provenance() == []


def test_provenance_detects_modified_artifacts(workspace):
    rec = workspace.save_text("notes", "original", stage="plan")
    (workspace.run_dir / rec.path).write_text("tampered", encoding="utf-8")
    assert workspace.verify_provenance() == [rec.id]


def test_stage_state_and_resume(tmp_path, workspace):
    workspace.mark_stage("plan", "done", title="x")
    reopened = Workspace.open(tmp_path, "run1")
    assert reopened.stage_status("plan") == "done"
    assert reopened.stage_status("survey") == "pending"
    with pytest.raises(StageError):
        Workspace.create(tmp_path, "run1", topic="t", direction="d", config_digest="x")
    with pytest.raises(StageError):
        workspace.latest_path("missing")
