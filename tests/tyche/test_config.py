import pytest

from tyche.config import ConfigError, TycheConfig, load_direction, parse_override


def test_defaults_expand_environment_placeholders():
    config = TycheConfig.load(env={"MODEL_NAME": "deepseek-test", "API_BASE": "https://example.invalid/v1"})
    spec = config.model("writer")
    assert spec.model_name == "deepseek-test"
    assert spec.api_base == "https://example.invalid/v1"
    assert spec.api_key_env == "API_KEY"
    assert "api_key" not in spec.public_dict()


def test_reviewer_falls_back_to_default_model_but_keeps_its_temperature():
    config = TycheConfig.load(env={"MODEL_NAME": "base-model"})
    reviewer = config.model("reviewer")
    assert reviewer.model_name == "base-model"
    assert reviewer.temperature == 0.0
    separate = TycheConfig.load(env={"MODEL_NAME": "base-model", "TYCHE_REVIEW_MODEL_NAME": "judge"})
    assert separate.model("reviewer").model_name == "judge"


def test_overrides_are_parsed_as_yaml_and_deep_merged():
    assert parse_override("review.max_rounds=2") == {"review": {"max_rounds": 2}}
    config = TycheConfig.load(overrides=["review.max_rounds=5", "paper.anonymous=false"], env={})
    assert config.get("review.max_rounds") == 5
    assert config.get("paper.anonymous") is False
    assert config.get("review.reflag_cap") == 2  # untouched sibling keys survive


@pytest.mark.parametrize("pages", [0, 10])
def test_page_limit_outside_iclr_range_is_rejected(pages):
    with pytest.raises(ConfigError):
        TycheConfig.load(overrides=[f"paper.max_main_pages={pages}"], env={})


def test_unknown_engine_is_rejected():
    with pytest.raises(ConfigError):
        TycheConfig.load(overrides=["experiments.engine=magic"], env={})


def test_direction_presets_load():
    for name in ("context_engineering", "memory_engine", "self_evolution"):
        preset = load_direction(name)
        assert preset["name"] == name
        assert preset["seed_queries"] and preset["experiment_families"]
    with pytest.raises(ConfigError):
        load_direction("quantum")


def test_context_window_defaults_to_128k_and_follows_the_environment():
    spec = TycheConfig.load(env={}).model("writer")
    assert spec.context_window == 131072 and spec.public_dict()["context_window"] == 131072
    assert TycheConfig.load(env={"MODEL_CONTEXT_WINDOW": "1000000"}).model("writer").context_window == 1_000_000
