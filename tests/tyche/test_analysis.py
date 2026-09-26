from tyche.analysis import analyze, build_registry, comparison_table, lower_is_better, results_brief, results_table
from tyche.analysis.registry import NumberRegistry, fmt, p_phrase
from tyche.experiments import read_metrics_dir


def test_analysis_is_deterministic_and_paired(results_dir):
    variants = read_metrics_dir(results_dir)
    a1 = analyze(variants, plan_metrics=["accuracy", "prompt_tokens_per_query"], seed=3)
    a2 = analyze(variants, plan_metrics=["accuracy", "prompt_tokens_per_query"], seed=3)
    assert a1.to_dict() == a2.to_dict()
    assert a1.proposed == "proposed"
    assert a1.metrics[:2] == ["accuracy", "prompt_tokens_per_query"]
    acc = a1.variants["proposed"]["accuracy"]
    assert acc.n == 60 and acc.ci_low <= acc.mean <= acc.ci_high
    comps = {(c.baseline, c.metric): c for c in a1.comparisons}
    assert comps[("full_context", "prompt_tokens_per_query")].better  # fewer tokens is better
    assert 0 < comps[("sliding_window", "accuracy")].p_value <= 1


def test_failed_variants_are_skipped(results_dir):
    (results_dir / "broken.metrics.json").write_text('{"status": "failed", "detail": "x"}')
    assert "broken" not in read_metrics_dir(results_dir)


def test_registry_matches_roundings_and_percentages(results_dir):
    analysis = analyze(read_metrics_dir(results_dir), plan_metrics=["accuracy"], seed=1)
    reg = build_registry(analysis, setup_texts={"design": "Memory budget: 1024 tokens"})
    acc = analysis.variants["proposed"]["accuracy"].mean
    assert reg.match(f"{acc:.2f}") is not None
    assert reg.match(f"{acc * 100:.1f}", percent=True) is not None
    assert reg.match("1024") is not None
    assert reg.match("0.4242") is None
    restored = NumberRegistry.from_list(reg.to_list())
    assert len(restored.entries) == len(reg.entries)


def test_brief_tables_and_formatting(results_dir):
    analysis = analyze(read_metrics_dir(results_dir), plan_metrics=["accuracy", "prompt_tokens_per_query"], seed=1)
    brief = results_brief(analysis)
    assert "Proposed variant: proposed" in brief and "95% CI" in brief
    table = results_table(analysis, caption="c")
    assert "\\textbf{" in table and "(ours)" in table and "\\label{tab:main}" in table
    assert "\\label{tab:paired}" in comparison_table(analysis)
    assert fmt(2351.2) == "2,351" and fmt(2351.2, latex=True) == "2{,}351"
    assert p_phrase(0.0001) == "p < 0.001" and p_phrase(0.2) == "p = 0.200"
    assert lower_is_better("prompt_tokens_per_query") and not lower_is_better("accuracy")


def test_metric_direction_uses_whole_tokens():
    assert not lower_is_better("token_f1") and not lower_is_better("sentiment_accuracy")
    assert not lower_is_better("tool_calls_success_rate")
    assert lower_is_better("stale_fact_rate") and lower_is_better("recovery_episodes")


def test_proposed_variant_selection_is_explicit():
    import pytest

    from tyche.analysis.stats import pick_proposed

    assert pick_proposed(["cot", "ours_full", "react"], "Self-Verifying CoT") == "ours_full"
    assert pick_proposed(["rag", "ledgermem"], "LedgerMem") == "ledgermem"
    with pytest.raises(ValueError, match="proposed"):
        pick_proposed(["cot", "react"], "Something New")


def test_repeated_trials_are_averaged_per_item_before_pairing():
    def variant(values):
        items = [{"id": f"q{i // 2}", "correct": v} for i, v in enumerate(values)]
        return {"accuracy": sum(values) / len(values), "per_question": items}

    variants = {"proposed": variant([1, 1, 1, 0]), "base": variant([0, 1, 0, 0])}
    analysis = analyze(variants, plan_metrics=["accuracy"], seed=0)
    [comp] = analysis.comparisons
    assert comp.n == 2 and abs(comp.diff - 0.5) < 1e-9


def test_confidence_level_flows_into_brief_and_tables(results_dir):
    analysis = analyze(read_metrics_dir(results_dir), plan_metrics=["accuracy"], confidence=0.8, seed=1)
    assert "80% CI" in results_brief(analysis) and "95% CI" not in results_brief(analysis)
    assert "80\\% CI" in comparison_table(analysis)
    assert build_registry(analysis).match("80") is not None


def test_stratum_metrics_use_only_their_items():
    def rows(correct_by_stratum):
        out = []
        for stratum, flags in correct_by_stratum.items():
            for i, ok in enumerate(flags):
                for pass_name in ("main", "matched_budget"):
                    out.append({"question_id": f"{stratum}{i}", "stratum": stratum, "pass": pass_name, "correct": ok})
        return out

    proposed = rows({"count": [1, 1, 1, 0], "current": [1, 1, 1, 1]})
    baseline = rows({"count": [1, 0, 0, 0], "current": [1, 1, 1, 1]})
    variants = {
        "proposed": {"count_accuracy": 0.75, "current_accuracy": 1.0, "combined_accuracy": 0.9, "per_question": proposed},
        "baseline": {"count_accuracy": 0.25, "current_accuracy": 1.0, "combined_accuracy": 0.6, "per_question": baseline},
    }
    result = analyze(variants, plan_metrics=["count_accuracy"], resamples=200, permutations=200)
    count = result.variants["proposed"]["count_accuracy"]
    # Only the four main-pass "count" items, not all sixteen rows.
    assert count.n == 4 and count.mean == 0.75
    comparison = next(c for c in result.comparisons if c.metric == "count_accuracy")
    assert comparison.n == 4 and abs(comparison.diff - 0.5) < 1e-9
    # A reported value the rows cannot reproduce gets no interval rather than a wrong one.
    assert result.variants["proposed"]["combined_accuracy"].n == 0
    assert any("combined_accuracy" in note for note in result.notes)
