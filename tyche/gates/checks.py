"""Deterministic gates a draft must pass before review and before packaging.

Gates never call a model. They check what can be checked mechanically:

* compile  -- the PDF builds; no undefined references or citations;
* citation -- every cited key is a verified bibliography entry; the related
  work cites enough distinct papers; no author-year mention lacks a citation;
* number   -- every number stated in the results-bearing sections is a
  rounding of a registered value (see tyche.analysis.registry);
* structure-- required sections, contributions list, limitations, references
  to every table and figure, word ranges, and the main-text page limit;
* placeholder -- no TODO/TBD/?? or template leftovers.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from tyche.analysis.registry import NumberRegistry
from tyche.paper.latex import MAIN_SECTIONS, CompileResult
from tyche.paper.sanitize import cited_keys
from tyche.textutil import word_count

NUMBER_CHECKED_SECTIONS = ("abstract", "introduction", "experiments", "analysis", "conclusion")

_STRIP_ARGS = re.compile(
    r"\\(?:ref|eqref|cref|Cref|autoref|label|cite[tp]?|citealp|citeauthor|citeyear|url|href|includegraphics|input|"
    r"begin|end|paragraph|subsection|subsubsection|textsc|texttt)\*?(\[[^\]]*\])?\{[^}]*\}"
)
_NUMBER = re.compile(
    r"(?<![A-Za-z0-9_\-/.^])(\d{1,3}(?:(?:\{,\}|,)\d{3})+|\d+)(\.\d+)?(\s*(?:\\%|%|\\,\\%|~\\%))?(?![A-Za-z0-9])"
)
_ETAL = re.compile(r"\b[A-Z][A-Za-z\-]+\s+et\s+al\.?(?:,)?\s*\(?\s*(?:19|20)\d{2}")
_PLACEHOLDER = re.compile(
    r"\bTODO\b|\bTBD\b|\bXXX\b|\?\?|\[citation needed\]|lorem ipsum|\bINSERT\b|<\s*placeholder|\[(?:number|value|X)\]",
    re.I,
)


@dataclass
class GateFinding:
    gate: str
    severity: str  # blocker | major | minor
    section: str
    message: str
    evidence: str = ""


@dataclass
class GateReport:
    findings: list[GateFinding] = field(default_factory=list)
    stats: dict[str, Any] = field(default_factory=dict)

    @property
    def blockers(self) -> list[GateFinding]:
        return [f for f in self.findings if f.severity == "blocker"]

    @property
    def passed(self) -> bool:
        return not self.blockers

    def to_dict(self) -> dict[str, Any]:
        return {"passed": self.passed, "stats": self.stats, "findings": [asdict(f) for f in self.findings]}


def numeric_tokens(latex: str) -> list[tuple[str, bool, str]]:
    """(number, is_percent, context) triples from a LaTeX section, skipping identifiers."""
    text = _STRIP_ARGS.sub(" ", latex)
    text = re.sub(r"(?<!\\)%.*$", "", text, flags=re.M)
    tokens = []
    for match in _NUMBER.finditer(text):
        integer, frac, pct = match.group(1), match.group(2) or "", match.group(3) or ""
        number = integer.replace("{,}", "").replace(",", "") + frac
        is_percent = bool(pct.strip())
        if not frac and not is_percent:
            value = int(number)
            if value < 10:
                continue
            if 1900 <= value <= 2100 and len(integer) == 4:
                continue
        start = max(0, match.start() - 60)
        tokens.append((number, is_percent, text[start : match.end() + 20].replace("\n", " ")))
    return tokens


def check_numbers(sections: dict[str, str], registry: NumberRegistry) -> list[GateFinding]:
    findings = []
    for name in NUMBER_CHECKED_SECTIONS:
        body = sections.get(name, "")
        for number, is_percent, context in numeric_tokens(body):
            if registry.match(number, percent=is_percent) is None:
                findings.append(
                    GateFinding(
                        "number",
                        "blocker",
                        name,
                        f"number {number}{'%' if is_percent else ''} does not match any computed result or setup value",
                        context.strip(),
                    )
                )
    return findings


def check_citations(
    sections: dict[str, str], bib_keys: set[str], min_related: int, removed: dict[str, list[str]]
) -> tuple[list[GateFinding], dict[str, Any]]:
    findings = []
    all_keys: set[str] = set()
    for name, body in sections.items():
        keys = cited_keys(body)
        all_keys.update(keys)
        unknown = [k for k in keys if k not in bib_keys]
        if unknown:
            findings.append(GateFinding("citation", "blocker", name, f"cites unknown keys: {', '.join(unknown)}"))
        for match in _ETAL.finditer(body):
            window = body[max(0, match.start() - 80) : match.end() + 80]
            if "\\cite" not in window:
                findings.append(
                    GateFinding("citation", "major", name, "author-year mention without a citation command", match.group(0))
                )
    related = set(cited_keys(sections.get("related_work", "")))
    if len(related) < min_related:
        findings.append(
            GateFinding(
                "citation",
                "major",
                "related_work",
                f"related work cites {len(related)} distinct papers; at least {min_related} expected",
            )
        )
    for name, keys in removed.items():
        if keys:
            findings.append(
                GateFinding(
                    "citation",
                    "minor",
                    name,
                    "the writer cited keys that are not in the verified bibliography; they were removed: "
                    + ", ".join(sorted(set(keys))[:8]),
                )
            )
    return findings, {"distinct_citations": len(all_keys), "related_work_citations": len(related)}


def check_structure(
    sections: dict[str, str],
    contracts: dict[str, dict[str, Any]],
    labels: list[str],
) -> list[GateFinding]:
    findings = []
    for name, _ in MAIN_SECTIONS:
        if not sections.get(name, "").strip():
            findings.append(GateFinding("structure", "blocker", name, "section is missing or empty"))
    if not sections.get("abstract", "").strip():
        findings.append(GateFinding("structure", "blocker", "abstract", "abstract is missing"))
    elif "\n\n" in sections["abstract"].strip():
        findings.append(GateFinding("structure", "minor", "abstract", "abstract should be a single paragraph"))
    intro = sections.get("introduction", "")
    if intro and "\\begin{itemize}" not in intro and "\\begin{enumerate}" not in intro:
        findings.append(GateFinding("structure", "major", "introduction", "no itemized contributions list"))
    analysis = sections.get("analysis", "")
    if analysis and "limitation" not in analysis.lower():
        findings.append(GateFinding("structure", "major", "analysis", "no limitations discussion"))
    body = "\n".join(sections.values())
    for label in labels:
        if f"{{{label}}}" not in body:
            findings.append(GateFinding("structure", "major", "experiments", f"label {label} is never referenced"))
    for name, text in sections.items():
        limits = contracts.get(name) or {}
        words = word_count(text)
        lo, hi = limits.get("min_words"), limits.get("max_words")
        if lo and words < 0.6 * lo:
            findings.append(GateFinding("structure", "major", name, f"{words} words; contract minimum is {lo}"))
        if hi and words > 1.5 * hi:
            findings.append(GateFinding("structure", "minor", name, f"{words} words; contract maximum is {hi}"))
    return findings


def check_placeholders(sections: dict[str, str]) -> list[GateFinding]:
    findings = []
    for name, body in sections.items():
        for match in _PLACEHOLDER.finditer(body):
            findings.append(GateFinding("placeholder", "blocker", name, "placeholder or template leftover", match.group(0)))
    return findings


def run_gates(
    *,
    sections: dict[str, str],
    compile_result: CompileResult,
    main_pages: int,
    max_main_pages: int,
    registry: NumberRegistry,
    bib_keys: set[str],
    contracts: dict[str, dict[str, Any]],
    labels: list[str],
    removed_citations: dict[str, list[str]] | None = None,
    pdf_text: str = "",
) -> GateReport:
    report = GateReport()
    if not compile_result.ok:
        for err in compile_result.errors[:5]:
            report.findings.append(
                GateFinding("compile", "blocker", err.file or "main", f"LaTeX error: {err.message}", f"line {err.line}")
            )
    for ref in compile_result.undefined_references:
        report.findings.append(GateFinding("compile", "blocker", "main", f"undefined reference {ref}"))
    for cite in compile_result.undefined_citations:
        report.findings.append(GateFinding("compile", "blocker", "main", f"undefined citation {cite}"))
    if pdf_text and "??" in pdf_text:
        report.findings.append(GateFinding("compile", "blocker", "main", "the PDF shows '??' (unresolved reference)"))
    if main_pages > max_main_pages:
        report.findings.append(
            GateFinding("structure", "blocker", "main", f"main text is {main_pages} pages; the limit is {max_main_pages}")
        )
    cite_findings, cite_stats = check_citations(
        sections, bib_keys, int((contracts.get("related_work") or {}).get("min_citations", 6)), removed_citations or {}
    )
    report.findings += cite_findings
    report.findings += check_numbers(sections, registry)
    report.findings += check_structure(sections, contracts, labels)
    report.findings += check_placeholders(sections)
    report.stats = {
        "main_pages": main_pages,
        "total_pages": compile_result.pages,
        "overfull_boxes": compile_result.overfull_boxes,
        "words": {name: word_count(text) for name, text in sections.items()},
        **cite_stats,
    }
    return report
