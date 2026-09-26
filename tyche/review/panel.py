"""Simulated peer review aligned with the Stanford Agentic Reviewer's dimensions.

The public description of the Stanford Agentic Reviewer (paperreview.ai)
scores seven dimensions -- originality, importance of the research question,
whether claims are supported by evidence, soundness of experiments, clarity of
writing, value to the research community, and contextualization relative to
prior work -- and combines them into an ICLR-style score. Tyche's panel
scores the same seven dimensions with three reviewer lenses plus a fidelity
auditor. The composite below is an unweighted mean chosen by us; it is not
the reviewer's own regression and should only be read as a relative signal
between drafts of the same paper.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from statistics import mean
from typing import Any, Literal

from pydantic import BaseModel, Field

from tyche.llm import LLMClient, complete_json
from tyche.prompts import load_prompt
from tyche.textutil import truncate_tokens

DIMENSIONS = (
    "originality",
    "importance",
    "claims_supported",
    "experimental_soundness",
    "clarity",
    "community_value",
    "contextualization",
)
SECTIONS = ("abstract", "introduction", "related_work", "method", "experiments", "analysis", "conclusion", "general")

PERSONAS = {
    "rigor": (
        "empirical rigor. Scrutinize whether the experiments test the hypotheses, whether baselines are fair, "
        "whether statistics and uncertainty are reported and interpreted correctly, and whether any claim "
        "outruns the evidence."
    ),
    "positioning": (
        "novelty and positioning. Scrutinize what is genuinely new, whether the closest prior work is discussed "
        "and contrasted, and whether the research question matters to the agent community."
    ),
    "clarity": (
        "clarity and impact. Scrutinize whether a busy reader can extract the problem, the idea, the evidence, "
        "and the takeaway quickly, and whether practitioners would find the result usable."
    ),
}


class Scores(BaseModel):
    originality: int = Field(ge=1, le=10)
    importance: int = Field(ge=1, le=10)
    claims_supported: int = Field(ge=1, le=10)
    experimental_soundness: int = Field(ge=1, le=10)
    clarity: int = Field(ge=1, le=10)
    community_value: int = Field(ge=1, le=10)
    contextualization: int = Field(ge=1, le=10)


class ReviewFinding(BaseModel):
    section: str
    severity: Literal["blocker", "major", "minor"]
    dimension: str
    quote: str
    problem: str
    fix: str
    close_criterion: str


class PriorRuling(BaseModel):
    id: str
    status: Literal["resolved", "still_open", "wontfix_accepted"]
    note: str = ""


class ReviewOutput(BaseModel):
    scores: Scores
    overall: int = Field(ge=1, le=10)
    confidence: int = Field(ge=1, le=5)
    summary: str
    strengths: list[str] = Field(default_factory=list)
    weaknesses: list[str] = Field(default_factory=list)
    findings: list[ReviewFinding] = Field(default_factory=list, max_length=8)
    prior_rulings: list[PriorRuling] = Field(default_factory=list)


class AuditOutput(BaseModel):
    findings: list[ReviewFinding] = Field(default_factory=list, max_length=8)


_ALNUM = re.compile(r"[^a-z0-9]+")


def _squash(text: str) -> str:
    return _ALNUM.sub("", text.lower())


def quote_in(quote: str, haystack_squashed: str) -> bool:
    q = _squash(quote)
    return len(q) >= 15 and q in haystack_squashed


_DOWNGRADE = {"blocker": "major", "major": "minor", "minor": None}


@dataclass
class PanelRound:
    reviews: dict[str, dict[str, Any]]
    dimension_means: dict[str, float]
    composite: float
    overall_mean: float
    findings: list[dict[str, Any]]
    rulings: list[dict[str, Any]] = field(default_factory=list)
    dropped_findings: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def normalize_findings(
    raw: list[ReviewFinding], source: str, paper_squashed: str
) -> tuple[list[dict[str, Any]], int]:
    kept: list[dict[str, Any]] = []
    dropped = 0
    for item in raw:
        finding = item.model_dump()
        finding["source"] = source
        finding["section"] = finding["section"] if finding["section"] in SECTIONS else "general"
        if finding["dimension"] not in DIMENSIONS:
            finding["dimension"] = "clarity"
        finding["quote_verified"] = quote_in(finding["quote"], paper_squashed)
        if not finding["quote_verified"]:
            lower = _DOWNGRADE[finding["severity"]]
            if lower is None:
                dropped += 1
                continue
            finding["severity"] = lower
        kept.append(finding)
    return kept, dropped


class ReviewPanel:
    def __init__(
        self,
        llm: LLMClient,
        *,
        reviewers: list[str],
        samples: int = 1,
        budget: int = 24000,
        auditor: bool = True,
    ):
        unknown = [r for r in reviewers if r not in PERSONAS]
        if unknown:
            raise ValueError(f"unknown reviewer persona(s): {unknown}")
        self.llm = llm
        self.reviewers = reviewers
        self.samples = max(1, samples)
        self.budget = budget
        self.auditor = auditor

    async def review(
        self,
        *,
        paper_text: str,
        sections: dict[str, str],
        uncited_related: list[dict[str, Any]],
        prior_findings: list[dict[str, Any]],
        results_brief: str,
        cited_evidence: dict[str, str],
        experiment_reflection: str = "",
    ) -> PanelRound:
        paper = truncate_tokens(paper_text, int(self.budget * 0.7))
        squashed = _squash(paper_text) + _squash(" ".join(sections.values()))
        prior = [
            {k: f[k] for k in ("id", "section", "severity", "problem", "fix", "close_criterion", "response") if k in f}
            for f in prior_findings
        ]
        base_user = (
            "<paper_text>\n" + paper + "\n</paper_text>\n"
            "<retrieved_related_work>\n" + json.dumps(uncited_related[:15], ensure_ascii=False, indent=1)
            + "\n</retrieved_related_work>\n"
        )
        if prior:
            base_user += "<prior_findings>\n" + json.dumps(prior, ensure_ascii=False, indent=1) + "\n</prior_findings>\n"
        reviews: dict[str, dict[str, Any]] = {}
        findings: list[dict[str, Any]] = []
        rulings: list[dict[str, Any]] = []
        dropped = 0
        per_dim: dict[str, list[float]] = {d: [] for d in DIMENSIONS}
        overall: list[float] = []
        for persona in self.reviewers:
            for sample in range(self.samples):
                name = persona if self.samples == 1 else f"{persona}#{sample + 1}"
                # Paper and context sit in the system prompt, identical for every persona, so the
                # providers' prompt caches serve them after the first reviewer; only the lens varies.
                out = await complete_json(
                    self.llm,
                    system=load_prompt("review_system") + "\n\n" + base_user,
                    user="<reviewer_lens>\n" + PERSONAS[persona] + "\n</reviewer_lens>\nReview the paper through this lens.",
                    schema=ReviewOutput,
                    purpose=f"review:{persona}",
                )
                reviews[name] = out.model_dump()
                for dim in DIMENSIONS:
                    per_dim[dim].append(float(getattr(out.scores, dim)))
                overall.append(float(out.overall))
                kept, lost = normalize_findings(out.findings, name, squashed)
                findings += kept
                dropped += lost
                rulings += [dict(r.model_dump(), reviewer=name) for r in out.prior_rulings]
        if self.auditor:
            cited = "\n".join(f"[{key}] {text}" for key, text in cited_evidence.items())
            audit_user = (
                "<paper_latex>\n"
                + truncate_tokens("\n\n".join(f"%% {n}\n{b}" for n, b in sections.items()), int(self.budget * 0.5))
                + "\n</paper_latex>\n<results_brief>\n"
                + results_brief
                + "\n</results_brief>\n<cited_evidence>\n"
                + truncate_tokens(cited, int(self.budget * 0.3))
                + "\n</cited_evidence>"
            )
            if experiment_reflection:
                audit_user += "\n<experiment_reflection>\n" + experiment_reflection + "\n</experiment_reflection>"
            audit = await complete_json(
                self.llm, system=load_prompt("auditor_system"), user=audit_user, schema=AuditOutput, purpose="review:auditor"
            )
            kept, lost = normalize_findings(audit.findings, "auditor", squashed)
            findings += kept
            dropped += lost
        dim_means = {d: round(mean(v), 3) for d, v in per_dim.items() if v}
        composite = round(mean(dim_means.values()), 3) if dim_means else 0.0
        return PanelRound(
            reviews=reviews,
            dimension_means=dim_means,
            composite=composite,
            overall_mean=round(mean(overall), 3) if overall else 0.0,
            findings=findings,
            rulings=rulings,
            dropped_findings=dropped,
        )
