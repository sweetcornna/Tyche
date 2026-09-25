"""Run workspace: stage state, immutable artifact versions, and provenance.

Layout of one run::

    <root>/runs/<run_id>/
        state.json            stage status, topic, config digest
        events.jsonl          append-only event log
        provenance.jsonl      one record per artifact version
        artifacts/<name>/v<N><suffix>
        plan/ survey/ experiments/ analysis/ paper/ review/ package/

Artifacts are never overwritten: saving a name again creates the next version
with a pointer to its parent, the producing stage, its inputs, and a sha256.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from tyche import STAGES


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(str(item.relative_to(path)).encode("utf-8"))
        digest.update(sha256_file(item).encode("ascii"))
    return digest.hexdigest()


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2, sort_keys=False)
            handle.write("\n")
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class ArtifactRecord:
    id: str
    name: str
    version: int
    path: str
    sha256: str
    stage: str
    kind: str
    created_at: str
    inputs: list[str] = field(default_factory=list)
    parent: str | None = None
    note: str = ""


class StageError(RuntimeError):
    """A stage could not produce valid outputs; the run stops loudly."""


class Workspace:
    def __init__(self, root: Path, run_id: str):
        self.root = Path(root)
        self.run_id = run_id
        self.run_dir = self.root / "runs" / run_id
        self.state_path = self.run_dir / "state.json"
        self.events_path = self.run_dir / "events.jsonl"
        self.provenance_path = self.run_dir / "provenance.jsonl"

    # -- lifecycle -----------------------------------------------------
    @classmethod
    def create(cls, root: Path, run_id: str, *, topic: str, direction: str, config_digest: str) -> "Workspace":
        ws = cls(root, run_id)
        if ws.state_path.exists():
            raise StageError(f"run {run_id!r} already exists at {ws.run_dir}; use --resume")
        ws.run_dir.mkdir(parents=True, exist_ok=True)
        for sub in ("artifacts", *STAGES):
            (ws.run_dir / sub).mkdir(exist_ok=True)
        write_json_atomic(
            ws.state_path,
            {
                "run_id": run_id,
                "topic": topic,
                "direction": direction,
                "created_at": utcnow(),
                "config_digest": config_digest,
                "stages": {name: {"status": "pending"} for name in STAGES},
            },
        )
        ws.event("run.created", topic=topic, direction=direction)
        return ws

    @classmethod
    def open(cls, root: Path, run_id: str) -> "Workspace":
        ws = cls(root, run_id)
        if not ws.state_path.exists():
            raise StageError(f"no run named {run_id!r} under {root}")
        return ws

    def stage_dir(self, stage: str) -> Path:
        path = self.run_dir / stage
        path.mkdir(parents=True, exist_ok=True)
        return path

    # -- state ---------------------------------------------------------
    @property
    def state(self) -> dict[str, Any]:
        return read_json(self.state_path, {})

    def _update_state(self, mutate) -> dict[str, Any]:
        state = self.state
        mutate(state)
        write_json_atomic(self.state_path, state)
        return state

    def stage_status(self, stage: str) -> str:
        return str(self.state.get("stages", {}).get(stage, {}).get("status", "pending"))

    def mark_stage(self, stage: str, status: str, **extra: Any) -> None:
        def mutate(state: dict[str, Any]) -> None:
            row = state.setdefault("stages", {}).setdefault(stage, {})
            row["status"] = status
            row[f"{status}_at"] = utcnow()
            row.update(extra)

        self._update_state(mutate)
        self.event(f"stage.{status}", stage=stage, **extra)

    def reset_from(self, stage: str) -> list[str]:
        """Mark ``stage`` and every later stage pending, so a rerun cannot reuse stale downstream results."""
        order = list(STAGES)
        later = order[order.index(stage):]

        def mutate(state: dict[str, Any]) -> None:
            for name in later:
                state.setdefault("stages", {})[name] = {"status": "pending"}

        self._update_state(mutate)
        self.event("stages.reset", stages=later)
        return later

    def set_meta(self, **values: Any) -> None:
        self._update_state(lambda state: state.setdefault("meta", {}).update(values))

    def meta(self, key: str, default: Any = None) -> Any:
        return self.state.get("meta", {}).get(key, default)

    def event(self, kind: str, **fields: Any) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"at": utcnow(), "kind": kind, **fields}, ensure_ascii=False, default=str) + "\n")

    # -- artifacts -----------------------------------------------------
    def records(self) -> list[ArtifactRecord]:
        if not self.provenance_path.exists():
            return []
        out = []
        for line in self.provenance_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                out.append(ArtifactRecord(**json.loads(line)))
        return out

    def record(self, record_id: str) -> ArtifactRecord | None:
        return next((rec for rec in self.records() if rec.id == record_id), None)

    def latest(self, name: str) -> ArtifactRecord | None:
        found = [rec for rec in self.records() if rec.name == name]
        return max(found, key=lambda rec: rec.version) if found else None

    def latest_path(self, name: str) -> Path:
        rec = self.latest(name)
        if rec is None:
            raise StageError(f"artifact {name!r} has not been produced yet")
        return self.run_dir / rec.path

    def _next_version(self, name: str) -> tuple[int, str | None]:
        prev = self.latest(name)
        return (prev.version + 1, prev.id) if prev else (1, None)

    def _record(self, rec: ArtifactRecord) -> ArtifactRecord:
        with self.provenance_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(rec), ensure_ascii=False) + "\n")
        self.event("artifact.saved", id=rec.id, stage=rec.stage, sha256=rec.sha256[:12])
        return rec

    def save_text(
        self, name: str, text: str, *, stage: str, suffix: str = ".md", inputs: Iterable[str] = (), note: str = ""
    ) -> ArtifactRecord:
        version, parent = self._next_version(name)
        rel = Path("artifacts") / name / f"v{version}{suffix}"
        target = self.run_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return self._record(
            ArtifactRecord(
                id=f"{name}@v{version}",
                name=name,
                version=version,
                path=str(rel),
                sha256=sha256_file(target),
                stage=stage,
                kind="text",
                created_at=utcnow(),
                inputs=list(inputs),
                parent=parent,
                note=note,
            )
        )

    def save_json(self, name: str, data: Any, *, stage: str, inputs: Iterable[str] = (), note: str = "") -> ArtifactRecord:
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        return self.save_text(name, text, stage=stage, suffix=".json", inputs=inputs, note=note)

    def save_file(self, name: str, source: Path, *, stage: str, inputs: Iterable[str] = (), note: str = "") -> ArtifactRecord:
        version, parent = self._next_version(name)
        rel = Path("artifacts") / name / f"v{version}{source.suffix}"
        target = self.run_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return self._record(
            ArtifactRecord(
                id=f"{name}@v{version}",
                name=name,
                version=version,
                path=str(rel),
                sha256=sha256_file(target),
                stage=stage,
                kind="file",
                created_at=utcnow(),
                inputs=list(inputs),
                parent=parent,
                note=note,
            )
        )

    def save_tree(self, name: str, source: Path, *, stage: str, inputs: Iterable[str] = (), note: str = "") -> ArtifactRecord:
        version, parent = self._next_version(name)
        rel = Path("artifacts") / name / f"v{version}"
        target = self.run_dir / rel
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".venv"))
        return self._record(
            ArtifactRecord(
                id=f"{name}@v{version}",
                name=name,
                version=version,
                path=str(rel),
                sha256=sha256_tree(target),
                stage=stage,
                kind="tree",
                created_at=utcnow(),
                inputs=list(inputs),
                parent=parent,
                note=note,
            )
        )

    def load_json(self, name: str) -> Any:
        return json.loads(self.latest_path(name).read_text(encoding="utf-8"))

    def load_text(self, name: str) -> str:
        return self.latest_path(name).read_text(encoding="utf-8")

    def verify_provenance(self) -> list[str]:
        """Recompute every artifact hash; return ids whose bytes changed."""
        drifted = []
        for rec in self.records():
            target = self.run_dir / rec.path
            if not target.exists():
                drifted.append(rec.id)
                continue
            actual = sha256_tree(target) if rec.kind == "tree" else sha256_file(target)
            if actual != rec.sha256:
                drifted.append(rec.id)
        return drifted
