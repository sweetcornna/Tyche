"""Deterministic statistics over experiment metrics.

All numbers that may appear in the paper's results are computed here from the
metrics files, with a fixed random seed, so a rerun reproduces them exactly.
Confidence intervals use the percentile bootstrap; paired comparisons use a
sign-flip permutation test on per-item differences.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np

from tyche.experiments.bridge import numeric_metrics

_LOWER_TOKENS = {
    "token", "tokens", "cost", "costs", "latency", "time", "seconds", "ms", "error", "errors", "stale", "violation",
    "violations", "regression", "regressions", "loss", "perplexity", "ppl", "steps", "calls", "episodes", "wer", "cer",
}
_HIGHER_TOKENS = {
    "accuracy", "acc", "f1", "success", "precision", "recall", "score", "reward", "em", "bleu", "rouge", "auc",
    "hit", "hits", "win", "pass", "correct", "exact",
}
_ITEM_ID_KEYS = ("id", "item_id", "question_id", "qid", "task_id", "index")
_BOOL_ALIASES = {
    "accuracy": ("correct", "is_correct", "exact_match", "em"),
    "success": ("success", "succeeded", "solved", "correct"),
}


def lower_is_better(metric: str) -> bool:
    """Decide direction from whole name tokens; quality words (accuracy, f1, success) win over cost words."""
    tokens = set(re.split(r"[^a-z0-9]+", metric.lower())) - {""}
    if tokens & _HIGHER_TOKENS:
        return False
    return bool(tokens & _LOWER_TOKENS)


@dataclass
class MetricSummary:
    value: float | None
    n: int = 0
    mean: float | None = None
    std: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None


@dataclass
class Comparison:
    metric: str
    proposed: str
    baseline: str
    n: int
    diff: float
    ci_low: float
    ci_high: float
    p_value: float
    relative: float | None
    better: bool


@dataclass
class Analysis:
    proposed: str
    baselines: list[str]
    metrics: list[str]
    variants: dict[str, dict[str, MetricSummary]]
    comparisons: list[Comparison] = field(default_factory=list)
    lower_is_better: dict[str, bool] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    confidence: float = 0.95

    @property
    def confidence_percent(self) -> str:
        return f"{self.confidence * 100:g}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "confidence": self.confidence,
            "proposed": self.proposed,
            "baselines": self.baselines,
            "metrics": self.metrics,
            "lower_is_better": self.lower_is_better,
            "variants": {v: {m: asdict(s) for m, s in ms.items()} for v, ms in self.variants.items()},
            "comparisons": [asdict(c) for c in self.comparisons],
            "notes": self.notes,
        }


# Per-item fields that split items into groups a metric may be reported over, e.g.
# stratum="change_count" for change_count_accuracy, or pass="matched_budget".
_GROUP_KEYS = (
    "stratum", "category", "question_set", "question_type", "qtype", "type", "set", "bucket", "slice", "split",
    "subset", "task_type", "pass", "setting",
)
# Group values that stand for the headline evaluation when a metric names no group.
_DEFAULT_GROUP_VALUES = {"main", "primary", "default", "test", "full"}


def _norm(text: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def _item_subsets(items: list[dict[str, Any]], metric: str) -> list[list[dict[str, Any]]]:
    """Candidate item sets a metric may be computed over, most specific first.

    For each grouping field present on every item, keep the values the metric's name
    mentions (change_count_accuracy -> stratum change_count); when it mentions none,
    keep the default values (pass main) if the field has any, else every value.
    """
    name = "_" + _norm(metric) + "_"
    keep: dict[str, set[str]] = {}
    for key in _GROUP_KEYS:
        if not items or not all(isinstance(i, dict) and isinstance(i.get(key), str) for i in items):
            continue
        values = {i[key] for i in items}
        if len(values) < 2:
            continue
        named = {v for v in values if _norm(v) and "_" + _norm(v) + "_" in name}
        default = {v for v in values if _norm(v) in _DEFAULT_GROUP_VALUES}
        if named or default:
            keep[key] = named or default
    subsets = []
    if keep:
        subset = [i for i in items if all(i[k] in vals for k, vals in keep.items())]
        if subset:
            subsets.append(subset)
    subsets.append(items)
    return subsets


def _values_for(items: list[dict[str, Any]], key: str) -> list[float] | None:
    values = []
    for item in items:
        if not isinstance(item, dict) or key not in item:
            return None
        raw = item[key]
        if isinstance(raw, bool):
            values.append(1.0 if raw else 0.0)
        elif isinstance(raw, (int, float)) and math.isfinite(float(raw)):
            values.append(float(raw))
        else:
            return None
    return values or None


def _reproduces(values: list[float], target: float | None) -> bool:
    if target is None:
        return True
    return abs(float(np.mean(values)) - target) <= 1e-3 * max(1.0, abs(target))


def _item_values(
    items: list[dict[str, Any]], metric: str, target: float | None = None
) -> tuple[list[dict[str, Any]], list[float]] | None:
    """Per-item values behind ``metric``: (items used, values), or None.

    Values are accepted only when their mean reproduces the reported ``target``, so
    a stratum-level metric never inherits the all-items accuracy's interval or test.
    """
    keys = [metric]
    for stem, aliases in _BOOL_ALIASES.items():
        if stem in metric.lower():
            keys.extend(aliases)
    for subset in _item_subsets(items, metric):
        for key in keys:
            values = _values_for(subset, key)
            if values and _reproduces(values, target):
                return subset, values
    return None


_SEED_KEYS = ("seed", "run_seed", "trial_seed")
# Fields that identify an item's content; if they differ for one id across seeds, the
# id names different items per seed (generated data), not repeated trials of one item.
_CONTENT_KEYS = ("gold", "gold_answer", "answer", "target", "question", "question_text", "prompt", "entity", "attribute")


def _item_ids(items: list[dict[str, Any]]) -> list[str] | None:
    for key in _ITEM_ID_KEYS:
        if items and all(isinstance(i, dict) and key in i for i in items):
            ids = [str(i[key]) for i in items]
            seed_key = next((s for s in _SEED_KEYS if all(s in i for i in items)), None)
            if seed_key and len(set(ids)) < len(ids) and _ids_name_different_items(items, key, seed_key):
                return [f"{i[seed_key]}:{i[key]}" for i in items]
            return ids
    return None


def _ids_name_different_items(items: list[dict[str, Any]], key: str, seed_key: str) -> bool:
    content: dict[str, set[str]] = {}
    for item in items:
        signature = repr([item.get(k) for k in _CONTENT_KEYS if k in item])
        content.setdefault(str(item[key]), set()).add(signature)
    return any(len(signatures) > 1 for signatures in content.values())


def _per_id_means(ids: list[str], values: np.ndarray) -> dict[str, float]:
    groups: dict[str, list[float]] = {}
    for key, value in zip(ids, values):
        groups.setdefault(key, []).append(float(value))
    return {key: float(np.mean(vals)) for key, vals in groups.items()}


def bootstrap_ci(values: np.ndarray, rng: np.random.Generator, resamples: int, confidence: float) -> tuple[float, float]:
    if len(values) < 2:
        m = float(values.mean()) if len(values) else float("nan")
        return m, m
    idx = rng.integers(0, len(values), size=(resamples, len(values)))
    means = values[idx].mean(axis=1)
    alpha = (1 - confidence) / 2
    return float(np.quantile(means, alpha)), float(np.quantile(means, 1 - alpha))


def sign_flip_p(diffs: np.ndarray, rng: np.random.Generator, resamples: int) -> float:
    if len(diffs) == 0 or np.allclose(diffs, 0):
        return 1.0
    observed = abs(diffs.mean())
    signs = rng.choice([-1.0, 1.0], size=(resamples, len(diffs)))
    null = np.abs((signs * diffs).mean(axis=1))
    # Add-one correction keeps the estimate valid (never exactly zero).
    return float((np.sum(null >= observed - 1e-12) + 1) / (resamples + 1))


def _tokens(text: str) -> set[str]:
    return set(re.split(r"[^a-z0-9]+", text.lower())) - {""}


def pick_proposed(names: list[str], hint: str = "") -> str:
    """The proposed variant: 'proposed'/'ours' by name first, then a whole-token match with the method name."""
    for name in names:
        if name.lower() == "proposed":
            return name
    for name in names:
        if _tokens(name) & {"proposed", "ours"}:
            return name
    hint_tokens = _tokens(hint)
    if hint_tokens:
        matches = [n for n in names if _tokens(n) == hint_tokens]
        if matches:
            return matches[0]
    raise ValueError(
        "cannot tell which variant is the proposed method; name it 'proposed' (or include 'ours') in the metrics "
        f"file names. Variants: {', '.join(names)}"
    )


def analyze(
    variants: dict[str, dict[str, Any]],
    *,
    plan_metrics: list[str],
    method_name: str = "",
    resamples: int = 2000,
    permutations: int = 5000,
    confidence: float = 0.95,
    seed: int = 0,
) -> Analysis:
    if len(variants) < 2:
        raise ValueError("analysis needs at least two variants")
    names = sorted(variants)
    proposed = pick_proposed(names, method_name)
    names = [proposed] + [n for n in names if n != proposed]
    numeric = {name: numeric_metrics(variants[name]) for name in names}
    shared = set.intersection(*(set(m) for m in numeric.values()))
    # Planned metrics first, then other metrics that differ between variants; metrics identical
    # for every variant (budgets, conformance flags, ...) carry no comparison and go last.
    extras = sorted(shared - set(plan_metrics))
    constant = [m for m in extras if len({round(numeric[n][m], 12) for n in names}) == 1]
    ordered = [m for m in plan_metrics if m in shared] + [m for m in extras if m not in constant] + constant
    notes = []
    missing = [m for m in plan_metrics if m not in shared]
    if missing:
        notes.append(f"planned metrics not reported by every variant: {', '.join(missing)}")
    if not ordered:
        raise ValueError("variants share no numeric metric; nothing can be compared")
    rng = np.random.default_rng(seed)
    summaries: dict[str, dict[str, MetricSummary]] = {}
    per_item: dict[str, dict[str, np.ndarray]] = {}
    ids: dict[str, dict[str, list[str] | None]] = {}
    unmatched: set[str] = set()
    for name in names:
        items = variants[name].get("per_question") or []
        items = items if isinstance(items, list) else []
        summaries[name] = {}
        per_item[name] = {}
        ids[name] = {}
        for metric in ordered:
            summary = MetricSummary(value=numeric[name][metric])
            found = _item_values(items, metric, numeric[name][metric]) if items else None
            if items and found is None and _item_values(items, metric) is not None:
                unmatched.add(metric)
            if found:
                used, values = found
                ids[name][metric] = _item_ids(used)
                arr = np.asarray(values, dtype=float)
                per_item[name][metric] = arr
                lo, hi = bootstrap_ci(arr, rng, resamples, confidence)
                summary.n = len(arr)
                summary.mean = float(arr.mean())
                summary.std = float(arr.std(ddof=1)) if len(arr) > 1 else 0.0
                summary.ci_low, summary.ci_high = lo, hi
            summaries[name][metric] = summary
    comparisons: list[Comparison] = []
    for baseline in names[1:]:
        for metric in ordered:
            a = per_item[proposed].get(metric)
            b = per_item[baseline].get(metric)
            if a is None or b is None:
                continue
            ia, ib = ids[proposed].get(metric), ids[baseline].get(metric)
            if ia and ib:
                # Repeated trials of the same item are averaged per item before pairing.
                mean_a = _per_id_means(ia, a)
                mean_b = _per_id_means(ib, b)
                common = [k for k in mean_a if k in mean_b]
                if len(common) < 2:
                    continue
                a_al = np.asarray([mean_a[k] for k in common])
                b_al = np.asarray([mean_b[k] for k in common])
            elif len(a) == len(b):
                a_al, b_al = a, b
            else:
                continue
            diffs = a_al - b_al
            lo, hi = bootstrap_ci(diffs, rng, resamples, confidence)
            base_mean = float(b_al.mean())
            diff = float(diffs.mean())
            better = diff < 0 if lower_is_better(metric) else diff > 0
            comparisons.append(
                Comparison(
                    metric=metric,
                    proposed=proposed,
                    baseline=baseline,
                    n=len(diffs),
                    diff=diff,
                    ci_low=lo,
                    ci_high=hi,
                    p_value=sign_flip_p(diffs, rng, permutations),
                    relative=(diff / abs(base_mean) * 100.0) if abs(base_mean) > 1e-12 else None,
                    better=better,
                )
            )
    if unmatched:
        notes.append(
            "per-item rows do not reproduce the reported value of "
            + ", ".join(sorted(unmatched))
            + "; those metrics are reported without intervals or paired tests"
        )
    if not comparisons:
        notes.append("no per-item data aligned across variants; paired tests were not computed")
    return Analysis(
        proposed=proposed,
        baselines=names[1:],
        metrics=ordered,
        variants=summaries,
        comparisons=comparisons,
        lower_is_better={m: lower_is_better(m) for m in ordered},
        notes=notes,
        confidence=confidence,
    )
