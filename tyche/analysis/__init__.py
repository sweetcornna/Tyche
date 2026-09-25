"""Deterministic statistics, the allowed-numbers registry, tables, and figures."""

from tyche.analysis.registry import NumberRegistry, build_registry, fmt, fmt_p, results_brief
from tyche.analysis.render import comparison_table, results_figure, results_table
from tyche.analysis.stats import Analysis, Comparison, MetricSummary, analyze, lower_is_better

__all__ = [
    "Analysis",
    "Comparison",
    "MetricSummary",
    "NumberRegistry",
    "analyze",
    "build_registry",
    "comparison_table",
    "fmt",
    "fmt_p",
    "lower_is_better",
    "results_brief",
    "results_figure",
    "results_table",
]
