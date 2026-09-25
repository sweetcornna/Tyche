"""Shared fixtures for Tyche tests. Everything runs offline."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from tyche.memory import MemoryStore
from tyche.workspace import Workspace

FIXTURE_RESULTS = Path(__file__).resolve().parents[2] / "tyche" / "fixtures" / "experiment_results"


@pytest.fixture
def memory(tmp_path: Path):
    store = MemoryStore(tmp_path / "memory.db")
    yield store
    store.close()


@pytest.fixture
def workspace(tmp_path: Path) -> Workspace:
    return Workspace.create(tmp_path, "run1", topic="t", direction="memory_engine", config_digest="x")


@pytest.fixture
def results_dir(tmp_path: Path) -> Path:
    target = tmp_path / "results"
    shutil.copytree(FIXTURE_RESULTS, target)
    return target


needs_latex = pytest.mark.skipif(shutil.which("latexmk") is None, reason="latexmk is not installed")
