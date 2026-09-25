"""ICLR 2027 AI use and reproducibility statements, generated from the run record.

These are written by code from what the pipeline actually did, not by a model,
so the disclosure cannot drift from the facts. The package stage regenerates
the AI use statement with the final gate outcome when a paper is released
UNVERIFIED.
"""

from __future__ import annotations

from typing import Any

from tyche.textutil import latex_escape

_SOURCE_NAMES = {"arxiv": "arXiv", "semantic_scholar": "Semantic Scholar", "openalex": "OpenAlex"}


def _join(items: list[str]) -> str:
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + ", and " + items[-1]


def ai_use_statement(meta: dict[str, Any], human_review: str, *, verified: bool | None = None) -> str:
    models = ", ".join(sorted(set(meta.get("models", [])))) or "a large language model"
    engine = meta.get("experiment_engine", "openjiuwen")
    experiment_clause = {
        "openjiuwen": (
            "designing the experiment and writing and debugging the experiment code, which was executed by the "
            "openJiuwen auto-research runtime; the reported statistics were computed by deterministic scripts "
            "from the logged outputs of those runs"
        ),
        "imported": (
            "analysing experiment outputs supplied by the authors; the reported statistics were computed by "
            "deterministic scripts from those outputs"
        ),
        "fixture": (
            "processing a synthetic selftest fixture; the numbers in this document are not experimental results"
        ),
    }.get(engine, "analysing experiment outputs")
    sources = [_SOURCE_NAMES.get(s, s) for s in meta.get("sources", ["arxiv", "semantic_scholar", "openalex"])]
    text = (
        "This paper was produced with Tyche, an automated research agent built on the openJiuwen JiuwenSwarm "
        f"framework. Generative AI ({latex_escape(models)}) was used for research ideation and planning, for "
        "screening and summarizing retrieved literature, for "
        + experiment_clause
        + ", for drafting and revising all sections of the manuscript, and for simulated peer review that guided "
        f"revisions. Bibliographic records were retrieved from {latex_escape(_join(sources))}, cross-checked where "
        "an identifier allowed it, and cited only after automated verification; generative AI was not used to "
        "produce reference metadata. Tyche's release gates require every cited key to resolve to a verified "
        "record and every result number stated in the abstract, introduction, experiments, analysis, and "
        "conclusion to match the computed analysis."
    )
    if verified is False:
        text += (
            " This version did not pass those gates and is released UNVERIFIED; the accompanying gate report "
            "lists the open problems."
        )
    review = human_review.strip()
    if review:
        text += " " + latex_escape(review)
    else:
        text += (
            " No human review of this document was recorded by the pipeline; the submitting team is responsible "
            "for reviewing it before any submission."
        )
    return text + "\n"


def reproducibility_statement(meta: dict[str, Any]) -> str:
    parts = [
        "The run record released with this paper contains the research plan, the verified literature and its "
        "source manifest, the experiment design, code, and per-variant metrics, the analysis outputs, the context "
        "manifests of all section-writing and revision calls, and the review ledger, each with a SHA-256 "
        "provenance entry."
    ]
    seed = meta.get("analysis_seed")
    if seed is not None:
        parts.append(
            f"Confidence intervals use a percentile bootstrap and paired tests use a sign-flip permutation test, "
            f"both with a fixed random seed ({seed})."
        )
    if meta.get("experiment_engine") == "fixture":
        parts.append("This document was generated from a synthetic selftest fixture and reports no real experiment.")
    return " ".join(parts) + "\n"
