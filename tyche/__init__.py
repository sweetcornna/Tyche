"""Tyche: an evidence-bound ICLR short-paper agent built on JiuwenSwarm.

Tyche turns a research topic about LLM agents into a compiled ICLR-format
short paper. Language models propose plans, prose, and critiques; deterministic
code owns retrieval, citation verification, statistics, LaTeX compilation,
and the gates that decide whether a draft may advance.
"""

__version__ = "0.1.0"

STAGES = (
    "plan",
    "survey",
    "experiments",
    "analysis",
    "write",
    "review",
    "evolve",
    "package",
)
