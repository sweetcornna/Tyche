"""BibTeX generation from verified records only."""

from __future__ import annotations

import re

from tyche.literature.models import Paper
from tyche.textutil import ascii_fold

_STOPWORDS = {"a", "an", "the", "on", "of", "for", "in", "to", "and", "with", "towards", "toward", "via", "is", "are"}
_LATEX_SPECIAL = {"&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_"}


def _surname(author: str) -> str:
    parts = [p for p in re.split(r"\s+", ascii_fold(author).strip()) if p]
    if not parts:
        return "anon"
    if "," in author:
        return re.sub(r"[^a-z]", "", ascii_fold(author.split(",")[0]).lower()) or "anon"
    return re.sub(r"[^a-z]", "", parts[-1].lower()) or "anon"


def cite_key(paper: Paper) -> str:
    first = _surname(paper.authors[0]) if paper.authors else "anon"
    words = [w for w in re.findall(r"[a-z0-9]+", ascii_fold(paper.title).lower()) if w not in _STOPWORDS]
    word = words[0] if words else "paper"
    return f"{first}{paper.year or 'nd'}{word}"


def assign_keys(papers: list[Paper]) -> dict[str, Paper]:
    """Stable, unique keys; collisions get a/b/c suffixes in input order."""
    keyed: dict[str, Paper] = {}
    for paper in papers:
        base = cite_key(paper)
        key = base
        suffix = ord("a")
        while key in keyed:
            key = f"{base}{chr(suffix)}"
            suffix += 1
        keyed[key] = paper
    return keyed


def _escape(value: str) -> str:
    out = []
    for char in value:
        out.append(_LATEX_SPECIAL.get(char, char))
    text = "".join(out)
    return re.sub(r"\s+", " ", text).strip()


def _protect_title(title: str) -> str:
    # Keep acronyms and model names capitalized under bibliography styles that lowercase titles.
    escaped = _escape(title)
    return re.sub(r"\b([A-Za-z]*[A-Z][A-Za-z0-9\-]*[A-Z0-9][A-Za-z0-9\-]*)\b", r"{\1}", escaped)


def format_authors(authors: list[str]) -> str:
    names = [_escape(a) for a in authors if a.strip()]
    if len(names) > 12:
        names = names[:12] + ["others"]
    return " and ".join(names)


def to_bibtex(key: str, paper: Paper) -> str:
    fields: list[tuple[str, str]] = [
        ("title", "{" + _protect_title(paper.title) + "}"),
        ("author", "{" + format_authors(paper.authors) + "}"),
        ("year", "{" + str(paper.year) + "}"),
    ]
    venue = paper.venue.strip()
    is_arxiv_only = bool(paper.arxiv_id) and (not venue or "arxiv" in venue.lower())
    if is_arxiv_only:
        entry = "article"
        fields.append(("journal", "{arXiv preprint arXiv:" + paper.arxiv_id + "}"))
    elif venue and re.search(r"conference|proceedings|workshop|symposium|neurips|icml|iclr|acl|emnlp|aaai|ijcai", venue, re.I):
        entry = "inproceedings"
        fields.append(("booktitle", "{" + _escape(venue) + "}"))
    elif venue:
        entry = "article"
        fields.append(("journal", "{" + _escape(venue) + "}"))
    else:
        entry = "misc"
    if paper.doi:
        fields.append(("doi", "{" + paper.doi + "}"))
    if paper.arxiv_id:
        fields.append(("eprint", "{" + paper.arxiv_id + "}"))
        fields.append(("archivePrefix", "{arXiv}"))
    if paper.url and entry == "misc":
        fields.append(("howpublished", "{\\url{" + paper.url + "}}"))
    body = ",\n".join(f"  {name} = {value}" for name, value in fields)
    return f"@{entry}{{{key},\n{body}\n}}\n"


def bibliography(keyed: dict[str, Paper]) -> str:
    return "\n".join(to_bibtex(key, paper) for key, paper in keyed.items())
