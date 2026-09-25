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
