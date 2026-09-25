"""Bibliographic records shared by the literature clients."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from tyche.textutil import normalize_title


@dataclass
class Paper:
    title: str
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    venue: str = ""
    abstract: str = ""
    arxiv_id: str = ""
    doi: str = ""
    s2_id: str = ""
    openalex_id: str = ""
    url: str = ""
    citation_count: int | None = None
    sources: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)

    @property
    def norm_title(self) -> str:
        return normalize_title(self.title)

    def identity_keys(self) -> list[str]:
        keys = []
        if self.arxiv_id:
            keys.append(f"arxiv:{self.arxiv_id.lower()}")
        if self.doi:
            keys.append(f"doi:{self.doi.lower()}")
        if self.s2_id:
            keys.append(f"s2:{self.s2_id}")
        if self.norm_title:
            keys.append(f"title:{self.norm_title}")
        return keys

    def merge(self, other: "Paper") -> None:
        """Fill gaps from another record of the same work; never overwrite with blanks."""
        for name in ("venue", "abstract", "arxiv_id", "doi", "s2_id", "openalex_id", "url"):
            if not getattr(self, name) and getattr(other, name):
                setattr(self, name, getattr(other, name))
        if len(other.abstract) > len(self.abstract):
            self.abstract = other.abstract
        if not self.authors and other.authors:
            self.authors = list(other.authors)
        if self.year is None and other.year is not None:
            self.year = other.year
        if other.citation_count is not None:
            self.citation_count = max(self.citation_count or 0, other.citation_count)
        for src in other.sources:
            if src not in self.sources:
                self.sources.append(src)
        for query in other.queries:
            if query not in self.queries:
                self.queries.append(query)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Paper":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


def dedupe(papers: list[Paper]) -> list[Paper]:
    """Merge records that share an arXiv id, DOI, S2 id, or normalized title."""
    merged: list[Paper] = []
    index: dict[str, Paper] = {}
    for paper in papers:
        target = next((index[k] for k in paper.identity_keys() if k in index), None)
        if target is None:
            merged.append(paper)
            target = paper
        else:
            target.merge(paper)
        for key in target.identity_keys():
            index[key] = target
    return merged
