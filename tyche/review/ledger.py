"""Findings ledger: every critique gets an id, an owner section, and a fate.

Life cycle of an entry::

    open --(writer: fixed)--> open* --(next review: resolved)--> resolved
    open --(writer: rebutted)--> open* --(next review: wontfix_accepted)--> wontfix
    open --(re-flagged more than reflag_cap times)--> unaddressed  (closed with an audit note)

(* the writer's response is recorded; only a later ruling or a gate re-check
closes the entry.) Gate findings close automatically when the gate no longer
reports them. A re-raised critique that matches an open entry increments its
re-flag count instead of creating a duplicate.
"""

from __future__ import annotations

import difflib
from dataclasses import asdict, dataclass, field
from typing import Any, Iterable

SEVERITY_ORDER = {"blocker": 0, "major": 1, "minor": 2}


@dataclass
class Entry:
    id: str
    round_opened: int
    source: str
    severity: str
    dimension: str
    section: str
    quote: str
    problem: str
    fix: str
    close_criterion: str
    status: str = "open"
    reflags: int = 0
    response: str = ""
    history: list[str] = field(default_factory=list)
    revision_accepted: bool | None = None
    score_delta: float | None = None


class FindingsLedger:
    def __init__(self, reflag_cap: int = 2, entries: Iterable[Entry] = ()):
        self.reflag_cap = reflag_cap
        self.entries: list[Entry] = list(entries)
        self._counter = len(self.entries)

    # -- persistence ---------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {"reflag_cap": self.reflag_cap, "entries": [asdict(e) for e in self.entries]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FindingsLedger":
        return cls(int(data.get("reflag_cap", 2)), (Entry(**e) for e in data.get("entries", [])))

    # -- queries -------------------------------------------------------
    def get(self, entry_id: str) -> Entry | None:
        return next((e for e in self.entries if e.id == entry_id), None)

    def open(self, *, sources: set[str] | None = None) -> list[Entry]:
        items = [e for e in self.entries if e.status == "open" and (sources is None or e.source in sources)]
        return sorted(items, key=lambda e: (SEVERITY_ORDER.get(e.severity, 3), e.round_opened, e.id))

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for entry in self.entries:
            out[entry.status] = out.get(entry.status, 0) + 1
        return out

    # -- updates -------------------------------------------------------
    def _match(self, finding: dict[str, Any]) -> Entry | None:
        for entry in self.entries:
            if entry.status != "open" or entry.section != finding.get("section"):
                continue
            same_quote = finding.get("quote") and entry.quote and (
                finding["quote"].strip().lower() == entry.quote.strip().lower()
            )
            similar = difflib.SequenceMatcher(None, entry.problem.lower(), str(finding.get("problem", "")).lower()).ratio()
            if same_quote or similar >= 0.72:
                return entry
        return None

    def add(self, finding: dict[str, Any], *, round_no: int) -> Entry:
        existing = self._match(finding)
        if existing is not None:
            existing.reflags += 1
            existing.history.append(f"r{round_no}: re-flagged by {finding.get('source', '?')}")
            if SEVERITY_ORDER.get(finding.get("severity", "minor"), 2) < SEVERITY_ORDER.get(existing.severity, 2):
                existing.severity = finding["severity"]
            if existing.reflags > self.reflag_cap:
                existing.status = "unaddressed"
                existing.history.append(f"r{round_no}: closed as unaddressed after {existing.reflags} re-flags")
            return existing
        self._counter += 1
        prefix = "G" if str(finding.get("source", "")).startswith("gate") else "F"
        entry = Entry(
            id=f"{prefix}{self._counter:03d}",
            round_opened=round_no,
            source=str(finding.get("source", "")),
            severity=str(finding.get("severity", "minor")),
            dimension=str(finding.get("dimension", "")),
            section=str(finding.get("section", "general")),
            quote=str(finding.get("quote", "")),
            problem=str(finding.get("problem", "")),
            fix=str(finding.get("fix", "")),
            close_criterion=str(finding.get("close_criterion", "")),
        )
        entry.history.append(f"r{round_no}: opened by {entry.source}")
        self.entries.append(entry)
        return entry

    def record_responses(self, responses: list[dict[str, Any]], round_no: int) -> None:
        for response in responses:
            entry = self.get(str(response.get("id", "")))
            if entry is None or entry.status != "open":
                continue
            action = str(response.get("action", "")).lower()
            entry.response = f"{action}: {response.get('note', '')}".strip()
            entry.history.append(f"r{round_no}: writer {action}")

    def apply_rulings(self, rulings: list[dict[str, Any]], round_no: int) -> None:
        for ruling in rulings:
            entry = self.get(str(ruling.get("id", "")))
            if entry is None or entry.status != "open":
                continue
            status = ruling.get("status")
            if status == "resolved":
                entry.status = "resolved"
            elif status == "wontfix_accepted":
                entry.status = "wontfix"
            entry.history.append(f"r{round_no}: {ruling.get('reviewer', 'reviewer')} ruled {status}")

    def sync_gate_findings(self, current: list[dict[str, Any]], round_no: int) -> None:
        """Open gate findings still reported; resolve gate entries no longer reported."""
        still = []
        for finding in current:
            still.append(self.add(finding, round_no=round_no).id)
        for entry in self.entries:
            if entry.source.startswith("gate") and entry.status == "open" and entry.id not in still:
                entry.status = "resolved"
                entry.history.append(f"r{round_no}: gate no longer reports it")

    def mark_revision(self, ids: Iterable[str], *, accepted: bool, score_delta: float | None, round_no: int) -> None:
        for entry_id in ids:
            entry = self.get(entry_id)
            if entry is None:
                continue
            entry.revision_accepted = accepted
            entry.score_delta = score_delta
            entry.history.append(
                f"r{round_no}: revision {'accepted' if accepted else 'rejected'}"
                + (f" (composite {score_delta:+.2f})" if score_delta is not None else "")
            )


def gate_findings_as_review(report_findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map gate findings onto the ledger's review-finding shape."""
    out = []
    for f in report_findings:
        if f["severity"] == "minor":
            continue
        section = f["section"] if f["section"] not in ("main", "") else "general"
        out.append(
            {
                "source": f"gate:{f['gate']}",
                "severity": f["severity"],
                "dimension": "claims_supported" if f["gate"] in ("number", "citation") else "clarity",
                "section": section,
                "quote": f.get("evidence", ""),
                "problem": f["message"],
                "fix": {
                    "number": "Use only numbers from the results brief or the experiment design, rounded as given, or "
                    "remove the number.",
                    "citation": "Cite only keys from the allowed citation list, or remove the mention.",
                    "structure": "Restore the required element described in the problem.",
                    "placeholder": "Replace the placeholder with final text.",
                    "compile": "Fix the LaTeX so the document compiles and every reference resolves.",
                }.get(f["gate"], "Address the problem."),
                "close_criterion": "The deterministic gate no longer reports this problem.",
            }
        )
    return out
