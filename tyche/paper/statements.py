"""ICLR 2027 AI use and reproducibility statements, generated from the run record.

These are written by code from what the pipeline actually did, not by a model,
so the disclosure cannot drift from the facts.
"""

from __future__ import annotations

from typing import Any

from tyche.textutil import latex_escape


def ai_use_statement(meta: dict[str, Any], human_review: str) -> str:
    models = ", ".join(sorted(set(meta.get("models", [])))) or "a large language model"
    engine = meta.get("experiment_engine", "openjiuwen")
    experiment_clause = {
        "openjiuwen": (
            "designing the experiment and writing and debugging the experiment code, which was executed by the "
            "openJiuwen auto-research runtime; all reported numbers were computed by deterministic scripts from "
            "the logged outputs of those runs"
        ),
        "imported": (
            "analysing experiment outputs supplied by the authors; all reported numbers were computed by "
            "deterministic scripts from those outputs"
        ),
        "fixture": (
            "processing a synthetic selftest fixture; the numbers in this document are not experimental results"
        ),
    }.get(engine, "analysing experiment outputs")
    text = (
        "This paper was produced with Tyche, an automated research agent built on the openJiuwen JiuwenSwarm "
        f"framework. Generative AI ({latex_escape(models)}) was used for research ideation and planning, for "
        "screening and summarizing retrieved literature, for "
        + experiment_clause
        + ", for drafting and revising all sections of the manuscript, and for simulated peer review that guided "
        "revisions. Bibliographic records were retrieved from arXiv, Semantic Scholar, OpenAlex, and Crossref "
        "and cited only after automated verification; generative AI was not used to produce reference metadata. "
        "Deterministic checks verified that every cited key resolves to a verified record and that every "
        "reported result matches the computed analysis. "
        + latex_escape(human_review)
    )
    return text + "\n"


def reproducibility_statement(meta: dict[str, Any]) -> str:
    parts = [
        "The full run record accompanies this paper: the research plan, the retrieved and verified literature "
        "with its source manifest, the experiment design and code, per-variant metrics files, the analysis "
        "script outputs, every context manifest used to prompt the models, and the review ledger."
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
