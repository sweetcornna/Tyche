"""Review-driven revision with acceptance tests.

Each round revises only the sections that open findings point at, rebuilds
and re-gates the paper, and has the panel re-review it (ruling on the prior
findings). A candidate replaces the current best only if it compiles, adds no
gate blockers, and does not lower the composite score by more than the
tolerance; otherwise the sections are reverted. The loop stops on the target
score, on a plateau, or on the round limit, and always returns the best
accepted draft.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from tyche.paper.compose import BuildResult, PaperComposer
from tyche.review.ledger import FindingsLedger, gate_findings_as_review
from tyche.review.panel import PanelRound
from tyche.workspace import write_json_atomic

ReviewFn = Callable[[BuildResult, list[dict[str, Any]]], Awaitable[PanelRound]]


@dataclass
class LoopResult:
    best: BuildResult
    best_review: PanelRound | None
    best_sections: dict[str, str]
    best_title: str
    rounds: list[dict[str, Any]] = field(default_factory=list)


def _as_prompt_finding(entry) -> dict[str, Any]:
    return {
        "id": entry.id,
        "severity": entry.severity,
        "problem": entry.problem,
        "quote": entry.quote,
        "fix": entry.fix,
        "close_criterion": entry.close_criterion,
    }


class RevisionLoop:
    def __init__(
        self,
        composer: PaperComposer,
        ledger: FindingsLedger,
        review_fn: ReviewFn,
        *,
        out_dir: Path,
        max_rounds: int,
        target: float,
        tolerance: float,
        plateau_rounds: int,
        max_findings: int,
        log=None,
    ):
        self.composer = composer
        self.ledger = ledger
        self.review_fn = review_fn
        self.out_dir = out_dir
        self.max_rounds = max_rounds
        self.target = target
        self.tolerance = tolerance
        self.plateau_rounds = plateau_rounds
        self.max_findings = max_findings
        self.log = log or (lambda *a, **k: None)

    def _persist(self, rounds: list[dict[str, Any]]) -> None:
        write_json_atomic(self.out_dir / "ledger.json", self.ledger.to_dict())
        write_json_atomic(self.out_dir / "rounds.json", rounds)

    def _prior_for_review(self) -> list[dict[str, Any]]:
        out = []
        for entry in self.ledger.open():
            if entry.source.startswith("gate"):
                continue
            out.append({**_as_prompt_finding(entry), "section": entry.section, "response": entry.response})
        return out

    async def _review(self, build: BuildResult, round_no: int) -> PanelRound | None:
        self.ledger.sync_gate_findings(gate_findings_as_review([f.__dict__ for f in build.gates.findings]), round_no)
        if not build.compile.ok:
            return None
        review = await self.review_fn(build, self._prior_for_review())
        self.ledger.apply_rulings(review.rulings, round_no)
        for finding in review.findings:
            self.ledger.add(finding, round_no=round_no)
        write_json_atomic(self.out_dir / f"review_r{round_no}.json", review.to_dict())
        return review

    def _select(self) -> dict[str, list]:
        chosen: dict[str, list] = {}
        count = 0
        for entry in self.ledger.open():
            section = entry.section
            if section == "general":
                # Paper-level critiques are handled where the framing lives.
                section = "introduction" if entry.dimension in ("importance", "originality", "contextualization") else "analysis"
            if section not in self.composer.sections:
                continue
            chosen.setdefault(section, []).append(entry)
            count += 1
            if count >= self.max_findings:
                break
        return chosen

    async def run(self) -> LoopResult:
        rounds: list[dict[str, Any]] = []
        current = await self.composer.build(self.out_dir / "build_r0")
        review = await self._review(current, 0)
        best_sections = dict(self.composer.sections)
        best_title = self.composer.title
        rounds.append(
            {
                "round": 0,
                "accepted": True,
                "composite": review.composite if review else None,
                "overall": review.overall_mean if review else None,
                "dimensions": review.dimension_means if review else None,
                "gates_passed": current.gates.passed,
                "blockers": len(current.gates.blockers),
                "build": current.summary(),
            }
        )
        self._persist(rounds)
        plateau = 0
        for round_no in range(1, self.max_rounds + 1):
            blockers_open = any(e.severity == "blocker" for e in self.ledger.open())
            if review is not None and review.composite >= self.target and not blockers_open:
                self.log("review.stop", reason="target reached", composite=review.composite)
                break
            if plateau >= self.plateau_rounds:
                self.log("review.stop", reason="plateau", rounds=round_no - 1)
                break
            selected = self._select()
            if not selected:
                self.log("review.stop", reason="no open findings")
                break
            snapshot = dict(self.composer.sections)
            touched_ids: list[str] = []
            for section, entries in selected.items():
                draft = await self.composer.writer.revise(
                    section,
                    self.composer.ctx,
                    self.composer.sections,
                    self.composer.sections[section],
                    [_as_prompt_finding(e) for e in entries],
                )
                if draft.latex.strip():
                    self.composer.sections[section] = draft.latex
                    self.composer.removed[section] = list(draft.report.removed_citations)
                self.ledger.record_responses(draft.responses, round_no)
                touched_ids += [e.id for e in entries]
            candidate = await self.composer.build(self.out_dir / f"build_r{round_no}")
            accepted = candidate.compile.ok and len(candidate.gates.blockers) <= len(current.gates.blockers)
            cand_review = None
            if accepted:
                cand_review = await self._review(candidate, round_no)
                if review is not None and cand_review is not None:
                    accepted = cand_review.composite >= review.composite - self.tolerance
            delta = None
            if review is not None and cand_review is not None:
                delta = round(cand_review.composite - review.composite, 3)
            self.ledger.mark_revision(touched_ids, accepted=accepted, score_delta=delta, round_no=round_no)
            if accepted:
                improved = delta is None or delta > 0.05 or len(candidate.gates.blockers) < len(current.gates.blockers)
                plateau = 0 if improved else plateau + 1
                current, review = candidate, cand_review
                best_sections = dict(self.composer.sections)
                best_title = self.composer.title
            else:
                self.composer.sections = snapshot
                plateau += 1
            rounds.append(
                {
                    "round": round_no,
                    "accepted": accepted,
                    "sections_revised": sorted(selected),
                    "findings_addressed": touched_ids,
                    "composite": cand_review.composite if cand_review else None,
                    "overall": cand_review.overall_mean if cand_review else None,
                    "dimensions": cand_review.dimension_means if cand_review else None,
                    "delta": delta,
                    "gates_passed": candidate.gates.passed,
                    "blockers": len(candidate.gates.blockers),
                    "build": candidate.summary(),
                }
            )
            self._persist(rounds)
            self.log("review.round", round=round_no, accepted=accepted, delta=delta)
        self.composer.sections = best_sections
        self.composer.title = best_title
        (self.out_dir / "best.json").write_text(
            json.dumps({"build_dir": str(current.build_dir), "composite": review.composite if review else None}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        return LoopResult(current, review, best_sections, best_title, rounds)
