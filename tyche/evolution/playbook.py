"""Cross-run self-evolution of the writing playbook.

After each run, the findings ledger is distilled into lessons. Lessons live in
the Research Memory Engine with global scope and move through a gated life
cycle, so the agent only keeps guidance that has earned its place:

* candidate -- seen in one run;
* active    -- recurred in at least ``promote_after_runs`` runs AND at least
  ``promote_after_helped`` of its findings were fixed by an accepted revision
  that did not lower the review score; only active lessons enter prompts;
* retired   -- while active, the same problem kept recurring in
  ``retire_after_misses`` runs, i.e. the guidance did not help.

Active lessons are also exported in JiuwenSwarm's skill ``evolutions.json``
format, so they show up in the TUI's ``/evolve_list`` for the Tyche skill and
can be reviewed, simplified, or rolled back with JiuwenSwarm's own tools.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from tyche.llm import LLMClient, complete_json
from tyche.memory import MemoryStore
from tyche.prompts import load_prompt
from tyche.review.ledger import FindingsLedger
from tyche.workspace import utcnow


class Lesson(BaseModel):
    category: str
    lesson: str
    sections: list[str] = Field(default_factory=list)
    finding_ids: list[str] = Field(default_factory=list)


class LessonSet(BaseModel):
    lessons: list[Lesson] = Field(default_factory=list, max_length=6)


@dataclass
class EvolutionPolicy:
    promote_after_runs: int = 2
    promote_after_helped: int = 1
    retire_after_misses: int = 2


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:60] or "general"


def ledger_digest(ledger: FindingsLedger) -> list[dict[str, Any]]:
    rows = []
    for e in ledger.entries:
        if e.source.startswith("gate:placeholder"):
            continue
        rows.append(
            {
                "id": e.id,
                "source": e.source,
                "severity": e.severity,
                "section": e.section,
                "dimension": e.dimension,
                "problem": e.problem,
                "status": e.status,
                "revision_accepted": e.revision_accepted,
                "score_delta": e.score_delta,
            }
        )
    return rows


def _helped(ledger: FindingsLedger, ids: list[str]) -> int:
    count = 0
    for entry_id in ids:
        entry = ledger.get(entry_id)
        if entry and entry.revision_accepted and (entry.score_delta is None or entry.score_delta >= 0):
            count += 1
    return count


def _status(meta: dict[str, Any], policy: EvolutionPolicy) -> str:
    status = meta.get("status", "candidate")
    if status == "retired":
        return "retired"
    if status == "active":
        return "retired" if int(meta.get("misses", 0)) >= policy.retire_after_misses else "active"
    runs = len(meta.get("support_runs", []))
    if runs >= policy.promote_after_runs and int(meta.get("helped", 0)) >= policy.promote_after_helped:
        return "active"
    return "candidate"


def update_lessons(
    memory: MemoryStore,
    lessons: list[Lesson],
    *,
    ledger: FindingsLedger,
    run_id: str,
    injected_ids: set[str],
    policy: EvolutionPolicy,
) -> list[dict[str, Any]]:
    """Merge this run's lessons into global memory and apply promotion/retirement."""
    existing = {item.meta.get("category"): item for item in memory.list(kinds=["lesson"], scopes=["global"])}
    changes = []
    seen_categories = set()
    for lesson in lessons:
        category = _slug(lesson.category)
        seen_categories.add(category)
        helped = _helped(ledger, lesson.finding_ids)
        item = existing.get(category)
        if item is None:
            meta = {
                "category": category,
                "support_runs": [run_id],
                "helped": helped,
                "misses": 0,
                "sections": lesson.sections,
                "status": "candidate",
                "created_run": run_id,
            }
            meta["status"] = _status(meta, policy)
            new_id = memory.add(
                "lesson",
                lesson.lesson,
                provenance="inferred",
                scope="global",
                title=category.replace("_", " "),
                tags=["lesson", *lesson.sections],
                meta=meta,
            )
            changes.append({"id": new_id, "category": category, "status": meta["status"], "change": "created"})
            continue
        meta = dict(item.meta)
        runs = list(meta.get("support_runs", []))
        if run_id not in runs:
            runs.append(run_id)
        meta["support_runs"] = runs
        meta["helped"] = int(meta.get("helped", 0)) + helped
        if item.id in injected_ids and meta.get("status") == "active":
            # The lesson was in the writer's context and the same problem still surfaced.
            meta["misses"] = int(meta.get("misses", 0)) + 1
        before = meta.get("status", "candidate")
        meta["status"] = _status(meta, policy)
        body_changed = lesson.lesson.strip() != item.body.strip() and before != "active"
        if body_changed:
            new_id = memory.supersede(item.id, lesson.lesson, meta=meta)
        else:
            memory.update_meta(item.id, **meta)
            new_id = item.id
        changes.append(
            {"id": new_id, "category": category, "status": meta["status"], "change": f"{before}->{meta['status']}"}
        )
    return changes


async def distill_lessons(llm: LLMClient, ledger: FindingsLedger) -> list[Lesson]:
    digest = ledger_digest(ledger)
    if not digest:
        return []
    result = await complete_json(
        llm,
        system=load_prompt("lessons_system"),
        user="<ledger>\n" + json.dumps(digest, ensure_ascii=False, indent=1) + "\n</ledger>",
        schema=LessonSet,
        purpose="evolve:lessons",
    )
    valid_ids = {e.id for e in ledger.entries}
    for lesson in result.lessons:
        lesson.finding_ids = [i for i in lesson.finding_ids if i in valid_ids]
    return [lesson for lesson in result.lessons if lesson.lesson.strip()]


def export_evolutions(memory: MemoryStore, skill_dir: Path, skill_id: str = "tyche-paper") -> Path:
    """Write active lessons as a JiuwenSwarm skill evolutions.json."""
    from openjiuwen.agent_evolving.checkpointing.types import EvolutionLog, EvolutionPatch, EvolutionRecord

    log = EvolutionLog.empty(skill_id)
    for item in memory.list(kinds=["lesson"], scopes=["global"]):
        if item.meta.get("status") != "active":
            continue
        record = EvolutionRecord.make(
            source="tyche-review-ledger",
            context=f"category={item.meta.get('category')}; runs={len(item.meta.get('support_runs', []))}; "
            f"helped={item.meta.get('helped', 0)}",
            change=EvolutionPatch(section="Instructions", action="append", content=item.body),
            score=min(0.95, 0.6 + 0.05 * int(item.meta.get("helped", 0))),
            summary=str(item.meta.get("category", "")),
        )
        record.applied = True
        log.entries.append(record)
    log.updated_at = utcnow()
    skill_dir.mkdir(parents=True, exist_ok=True)
    target = skill_dir / "evolutions.json"
    target.write_text(json.dumps(log.to_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target
