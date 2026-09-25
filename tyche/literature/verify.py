"""Reference verification: only records confirmed by scholarly APIs are citable.

A paper becomes citable when it has a title, authors, a year, and at least one
persistent identifier (arXiv id, DOI, or Semantic Scholar id) returned by an
API, and no independent lookup contradicts it. Cross-checks run where an
identifier allows one: arXiv ids against the arXiv API, DOIs against Crossref.
A contradiction (the identifier resolves to a different title) excludes the
record. Unreachable services leave a note but do not by themselves exclude a
record that already came from an authoritative API.
"""

from __future__ import annotations

import difflib
from dataclasses import dataclass, field

from tyche.literature.http import HttpError
from tyche.literature.models import Paper
from tyche.literature.sources import ArxivClient, CrossrefClient, SemanticScholarClient
from tyche.textutil import normalize_title

TITLE_MATCH = 0.88


def title_similarity(a: str, b: str) -> float:
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return 0.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


@dataclass
class Verification:
    citable: bool
    verified_by: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


class Verifier:
    def __init__(
        self,
        *,
        arxiv: ArxivClient | None,
        crossref: CrossrefClient | None,
        s2: SemanticScholarClient | None,
    ):
        self.arxiv = arxiv
        self.crossref = crossref
        self.s2 = s2

    @staticmethod
    def minimal_metadata(paper: Paper) -> list[str]:
        missing = []
        if not paper.title:
            missing.append("title")
        if not [a for a in paper.authors if a]:
            missing.append("authors")
        if paper.year is None:
            missing.append("year")
        if not (paper.arxiv_id or paper.doi or paper.s2_id):
            missing.append("persistent identifier")
        return missing

    async def verify(self, papers: list[Paper]) -> dict[str, Verification]:
        """Return a verification per paper, keyed by the paper's first identity key."""
        results: dict[str, Verification] = {}
        arxiv_records: dict[str, Paper] = {}
        need_arxiv = [p.arxiv_id for p in papers if p.arxiv_id and "arxiv" not in p.sources]
        if need_arxiv and self.arxiv is not None:
            for start in range(0, len(need_arxiv), 20):
                try:
                    for rec in await self.arxiv.by_ids(need_arxiv[start : start + 20]):
                        arxiv_records[rec.arxiv_id] = rec
                except HttpError:
                    pass
        for paper in papers:
            key = paper.identity_keys()[0]
            check = Verification(citable=False, verified_by=list(paper.sources))
            missing = self.minimal_metadata(paper)
            if missing:
                check.notes.append("missing " + ", ".join(missing))
                results[key] = check
                continue
            contradicted = False
            if paper.arxiv_id and "arxiv" not in paper.sources and self.arxiv is not None:
                rec = arxiv_records.get(paper.arxiv_id)
                if rec is None:
                    check.notes.append("arXiv cross-check unavailable")
                elif title_similarity(rec.title, paper.title) >= TITLE_MATCH:
                    check.verified_by.append("arxiv")
                    paper.merge(rec)
                else:
                    contradicted = True
                    check.notes.append(f"arXiv id resolves to a different title: {rec.title!r}")
            if paper.doi and not paper.doi.startswith("10.48550/") and self.crossref is not None and not contradicted:
                try:
                    rec = await self.crossref.by_doi(paper.doi)
                except HttpError:
                    rec = None
                    check.notes.append("Crossref cross-check unavailable")
                if rec is not None:
                    if title_similarity(rec.title, paper.title) >= TITLE_MATCH:
                        check.verified_by.append("crossref")
                        if not paper.venue and rec.venue:
                            paper.venue = rec.venue
                    else:
                        contradicted = True
                        check.notes.append(f"DOI resolves to a different title: {rec.title!r}")
            check.citable = not contradicted
            check.verified_by = sorted(set(check.verified_by))
            results[key] = check
        return results

    async def resolve_title(self, title: str) -> Paper | None:
        """Find the record for a named work; accept only a close title match."""
        candidates: list[Paper] = []
        if self.s2 is not None:
            try:
                candidates += await self.s2.search(title, 5)
            except HttpError:
                pass
        if self.arxiv is not None and not candidates:
            try:
                candidates += await self.arxiv.search(title, 5)
            except HttpError:
                pass
        best = max(candidates, key=lambda p: title_similarity(p.title, title), default=None)
        if best is not None and title_similarity(best.title, title) >= TITLE_MATCH:
            return best
        return None
