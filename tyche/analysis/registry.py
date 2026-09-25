"""The allowed-numbers registry.

Every number the paper may state about results or setup is registered here
with a label saying where it came from. The number gate later checks each
numeric token in the prose against this registry, accepting any token that
equals a registered value rounded to the token's own precision (or the value
as a percentage when it is a fraction).
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Iterable

from tyche.analysis.stats import Analysis

_NUM_IN_TEXT = re.compile(r"(?<![\w.])[-+]?\d+(?:\.\d+)?")


@dataclass
class NumberEntry:
    value: float
    label: str
    kind: str  # result | derived | setup


class NumberRegistry:
    def __init__(self, entries: Iterable[NumberEntry] = ()):
        self.entries: list[NumberEntry] = list(entries)

    def add(self, value: float | int | None, label: str, kind: str = "result") -> None:
        if value is None:
            return
        value = float(value)
        if math.isfinite(value):
            self.entries.append(NumberEntry(value, label, kind))

    def add_text_numbers(self, text: str, label: str, kind: str = "setup") -> None:
        """Register every number that literally appears in a setup document."""
        for match in _NUM_IN_TEXT.finditer(text or ""):
            try:
                self.add(float(match.group(0)), label, kind)
            except ValueError:
                continue

    def match(self, token: str, *, percent: bool = False) -> NumberEntry | None:
        """Return the registered entry this token could be a rounding of."""
        try:
            x = float(token)
        except ValueError:
            return None
        decimals = len(token.split(".", 1)[1]) if "." in token else 0
        tol = 0.5 * 10 ** (-decimals) + 1e-9
        for entry in self.entries:
            candidates = [entry.value, abs(entry.value)]
            if percent or abs(entry.value) <= 1.0:
                candidates += [entry.value * 100.0, abs(entry.value) * 100.0]
            for cand in candidates:
                if abs(cand - x) <= tol:
                    return entry
        return None

    def to_list(self) -> list[dict[str, Any]]:
        return [asdict(e) for e in self.entries]

    @classmethod
    def from_list(cls, rows: list[dict[str, Any]]) -> "NumberRegistry":
        return cls(NumberEntry(**row) for row in rows)


def fmt(value: float | None, metric: str = "", *, latex: bool = False) -> str:
    """House number format, used by tables and the results brief alike."""
    if value is None or not math.isfinite(value):
        return "--"
    magnitude = abs(value)
    if magnitude >= 1000:
        text = f"{value:,.0f}"
        return text.replace(",", "{,}") if latex else text
    if magnitude >= 100:
        return f"{value:.1f}"
    if magnitude >= 1:
        return f"{value:.2f}"
    return f"{value:.3f}"


def fmt_p(p: float) -> str:
    if p < 0.001:
        return "< 0.001"
    return f"{p:.3f}"


def p_phrase(p: float) -> str:
    text = fmt_p(p)
    return f"p {text}" if text.startswith("<") else f"p = {text}"


def build_registry(analysis: Analysis, *, setup_texts: dict[str, str] | None = None) -> NumberRegistry:
    reg = NumberRegistry()
    for variant, metrics in analysis.variants.items():
        for metric, s in metrics.items():
            base = f"{variant}.{metric}"
            reg.add(s.value, base)
            reg.add(s.mean, f"{base}.mean")
            reg.add(s.std, f"{base}.std", "derived")
            reg.add(s.ci_low, f"{base}.ci_low", "derived")
            reg.add(s.ci_high, f"{base}.ci_high", "derived")
            if s.ci_low is not None and s.ci_high is not None:
                reg.add((s.ci_high - s.ci_low) / 2, f"{base}.ci_halfwidth", "derived")
            if s.n:
                reg.add(s.n, f"{base}.n", "setup")
    for c in analysis.comparisons:
        base = f"{c.proposed}-vs-{c.baseline}.{c.metric}"
        reg.add(c.diff, f"{base}.diff", "derived")
        reg.add(c.ci_low, f"{base}.diff_ci_low", "derived")
        reg.add(c.ci_high, f"{base}.diff_ci_high", "derived")
        reg.add(c.p_value, f"{base}.p_value", "derived")
        reg.add(c.relative, f"{base}.relative_percent", "derived")
        reg.add(c.n, f"{base}.n", "setup")
    reg.add(len(analysis.variants), "count.variants", "setup")
    reg.add(len(analysis.baselines), "count.baselines", "setup")
    reg.add(len(analysis.metrics), "count.metrics", "setup")
    reg.add(95, "confidence.percent", "setup")
    reg.add(0.05, "alpha", "setup")
    for label, text in (setup_texts or {}).items():
        reg.add_text_numbers(text, f"setup:{label}")
    return reg


def results_brief(analysis: Analysis) -> str:
    """Plain-language facts for the writer; every number here is registered."""
    lines = [f"Proposed variant: {analysis.proposed}. Baselines: {', '.join(analysis.baselines)}."]
    for metric in analysis.metrics:
        direction = "lower is better" if analysis.lower_is_better.get(metric) else "higher is better"
        lines.append(f"Metric {metric} ({direction}):")
        for variant, metrics in analysis.variants.items():
            s = metrics[metric]
            if s.mean is not None and s.ci_low is not None:
                lines.append(
                    f"  - {variant}: {fmt(s.mean, metric)} (95% CI {fmt(s.ci_low, metric)} to "
                    f"{fmt(s.ci_high, metric)}, n = {s.n})"
                )
            else:
                lines.append(f"  - {variant}: {fmt(s.value, metric)} (no per-item data)")
    if analysis.comparisons:
        lines.append("Paired comparisons (proposed minus baseline):")
        for c in analysis.comparisons:
            rel = f", relative {c.relative:+.1f}%" if c.relative is not None else ""
            verdict = "favors proposed" if c.better else "does not favor proposed"
            lines.append(
                f"  - {c.metric} vs {c.baseline}: diff {fmt(c.diff, c.metric)} (95% CI {fmt(c.ci_low, c.metric)} to "
                f"{fmt(c.ci_high, c.metric)}), {p_phrase(c.p_value)}, n = {c.n}{rel}; {verdict}"
            )
    for note in analysis.notes:
        lines.append(f"Note: {note}")
    return "\n".join(lines)
