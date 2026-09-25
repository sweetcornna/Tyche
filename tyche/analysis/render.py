"""LaTeX tables and figures generated from the analysis, never by a model."""

from __future__ import annotations

from pathlib import Path

from tyche.analysis.registry import fmt, fmt_p
from tyche.analysis.stats import Analysis
from tyche.textutil import latex_escape


def _metric_label(metric: str, lower: bool) -> str:
    arrow = r"$\downarrow$" if lower else r"$\uparrow$"
    return latex_escape(metric.replace("_", " ")) + " " + arrow


def results_table(analysis: Analysis, *, caption: str, label: str = "tab:main") -> str:
    metrics = analysis.metrics[:4]
    best: dict[str, str] = {}
    for metric in metrics:
        scored = []
        for variant, ms in analysis.variants.items():
            s = ms[metric]
            v = s.mean if s.mean is not None else s.value
            if v is not None:
                scored.append((v, variant))
        if scored:
            pick = min if analysis.lower_is_better.get(metric) else max
            best[metric] = pick(scored)[1]
    cols = "l" + "c" * len(metrics)
    lines = [
        r"\begin{table}[t]",
        r"\centering",
        r"\caption{" + caption + "}",
        r"\label{" + label + "}",
        r"\small",
        r"\begin{tabular}{" + cols + "}",
        r"\toprule",
        "Method & " + " & ".join(_metric_label(m, analysis.lower_is_better.get(m, False)) for m in metrics) + r" \\",
        r"\midrule",
    ]
    for variant, ms in analysis.variants.items():
        cells = []
        for metric in metrics:
            s = ms[metric]
            if s.mean is not None and s.ci_low is not None and s.ci_high is not None:
                cell = f"{fmt(s.mean, metric, latex=True)} $\\pm$ {fmt((s.ci_high - s.ci_low) / 2, metric, latex=True)}"
            else:
                cell = fmt(s.value, metric, latex=True)
            if best.get(metric) == variant:
                cell = r"\textbf{" + cell + "}"
            cells.append(cell)
        name = latex_escape(variant.replace("_", " "))
        if variant == analysis.proposed:
            name = r"\textsc{" + name + "} (ours)"
        lines.append(name + " & " + " & ".join(cells) + r" \\")
        if variant == analysis.proposed:
            lines.append(r"\midrule")
    lines += [r"\bottomrule", r"\end{tabular}", r"\end{table}"]
    return "\n".join(lines) + "\n"


def comparison_table(analysis: Analysis, *, label: str = "tab:paired") -> str:
    if not analysis.comparisons:
        return ""
    lines = [
        r"\begin{table}[t]",
        r"\centering",
        r"\caption{Paired comparisons of the proposed method against each baseline: mean per-item difference "
        r"(proposed minus baseline), 95\% bootstrap confidence interval, and sign-flip permutation $p$-value.}",
        r"\label{" + label + "}",
        r"\small",
        r"\begin{tabular}{llccc}",
        r"\toprule",
        r"Metric & Baseline & $\Delta$ & 95\% CI & $p$ \\",
        r"\midrule",
    ]
    for c in analysis.comparisons:
        lines.append(
            f"{latex_escape(c.metric.replace('_', ' '))} & {latex_escape(c.baseline.replace('_', ' '))} & "
            f"{fmt(c.diff, c.metric, latex=True)} & [{fmt(c.ci_low, c.metric, latex=True)}, "
            f"{fmt(c.ci_high, c.metric, latex=True)}] & "
            f"{fmt_p(c.p_value).replace('<', '$<$')} \\\\"
        )
    lines += [r"\bottomrule", r"\end{tabular}", r"\end{table}"]
    return "\n".join(lines) + "\n"


def results_figure(analysis: Analysis, out_path: Path) -> Path | None:
    """Bar chart with 95% CI error bars, one panel per metric (up to three)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    metrics = analysis.metrics[:3]
    if not metrics:
        return None
    variants = list(analysis.variants)
    fig, axes = plt.subplots(1, len(metrics), figsize=(3.2 * len(metrics), 2.6), squeeze=False)
    for ax, metric in zip(axes[0], metrics):
        heights, errs_lo, errs_hi, colors = [], [], [], []
        for variant in variants:
            s = analysis.variants[variant][metric]
            h = s.mean if s.mean is not None else (s.value or 0.0)
            heights.append(h)
            errs_lo.append(max(0.0, h - s.ci_low) if s.ci_low is not None else 0.0)
            errs_hi.append(max(0.0, s.ci_high - h) if s.ci_high is not None else 0.0)
            colors.append("#c0392b" if variant == analysis.proposed else "#7f8c8d")
        ax.bar(range(len(variants)), heights, yerr=[errs_lo, errs_hi], color=colors, capsize=3, width=0.7)
        ax.set_xticks(range(len(variants)))
        ax.set_xticklabels([v.replace("_", " ") for v in variants], rotation=30, ha="right", fontsize=7)
        arrow = "(lower is better)" if analysis.lower_is_better.get(metric) else "(higher is better)"
        ax.set_title(f"{metric.replace('_', ' ')}\n{arrow}", fontsize=8)
        ax.tick_params(axis="y", labelsize=7)
        ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, bbox_inches="tight")
    plt.close(fig)
    return out_path
