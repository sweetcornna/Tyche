import pytest

from tyche import cache
from tyche.cache import PROFILES, PrefixLedger, build_messages, detect_profile, request_hints
from tyche.config import ConfigError, TycheConfig
from tyche.textutil import count_tokens

LONG = "Shared research context. " * 400  # comfortably above every documented minimum


@pytest.mark.parametrize(
    ("provider", "api_base", "model", "expected"),
    [
        ("OpenAI", "https://api.deepseek.com", "deepseek-flash", "deepseek"),
        ("DeepSeek", "", "deepseek-v4-pro", "deepseek"),
        ("OpenAI", "https://api.openai.com/v1", "gpt-5", "openai"),
        ("OpenAI", "https://res.openai.azure.com/openai/v1", "gpt-5", "azure_openai"),
        ("Anthropic", "https://api.anthropic.com", "claude-sonnet", "anthropic"),
        ("OpenRouter", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet", "openrouter_client"),
        ("OpenAI", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet", "openrouter_explicit"),
        ("OpenAI", "https://openrouter.ai/api/v1", "qwen/qwen3-max", "openrouter_explicit"),
        ("OpenAI", "https://openrouter.ai/api/v1", "deepseek/deepseek-chat", "openrouter"),
        ("OpenAI", "https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus", "dashscope"),
        ("OpenAI", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen-plus", "dashscope"),
        ("DashScope", "", "qwen-plus", "dashscope"),
        ("OpenAI", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-2.5-flash", "gemini"),
        ("OpenAI", "https://api.x.ai/v1", "grok-4", "xai"),
        ("OpenAI", "https://api.moonshot.cn/v1", "kimi-k2", "moonshot"),
        ("OpenAI", "https://open.bigmodel.cn/api/paas/v4", "glm-4.6", "zhipu"),
        ("OpenAI", "https://api.minimaxi.com/v1", "MiniMax-M2", "minimax"),
        ("AscendAffinity", "https://gateway.internal/v1", "any", "affinity"),
        ("OpenAI", "http://localhost:8000/v1", "qwen3", "self_hosted"),
        ("OpenAI", "http://127.0.0.1:30000/v1", "qwen3", "self_hosted"),
        ("OpenAI", "https://gateway.example.com/v1", "claude-sonnet", "openai_compatible"),
        # Suffix matching respects domain boundaries.
        ("OpenAI", "https://api.deepseek.com.example.net/v1", "x", "openai_compatible"),
        ("OpenAI", "https://notapi.openai.com.evil/v1", "x", "openai_compatible"),
        ("OpenAI", "api.deepseek.com", "x", "deepseek"),
    ],
)
def test_detect_profile_covers_every_provider_family(provider, api_base, model, expected):
    assert detect_profile(provider, api_base, model).name == expected


def test_configured_profile_overrides_detection_and_unknown_names_fail():
    assert detect_profile("OpenAI", "https://gateway.example.com/v1", "claude", "explicit").name == "explicit"
    assert detect_profile("OpenAI", "https://api.openai.com/v1", "gpt-5", "off").mechanism == cache.NONE
    with pytest.raises(cache.CacheConfigError):
        detect_profile("OpenAI", "", "x", "bogus")
    with pytest.raises(ConfigError, match="models.writer.cache"):
        TycheConfig.load(overrides=[{"models": {"default": {"cache": "bogus"}}}], env={}).model("writer")


def test_model_spec_exposes_cache_settings_but_no_secret_in_route():
    config = TycheConfig.load(
        overrides=[{"models": {"default": {"cache_retention": "24h"}}}], env={"API_KEY": "sk-secret-value"}
    )
    spec = config.model("writer")
    assert spec.public_dict()["cache"] == "auto"
    assert spec.public_dict()["cache_retention"] == "24h"
    assert spec.cache_profile().name == "deepseek"
    assert "sk-secret-value" not in spec.route()
    assert "sk-secret-value" not in cache.routing_key(spec.route(), "system")


def _marks(messages):
    return [i for i, m in enumerate(messages) if isinstance(m["content"], list)]


def test_explicit_profile_marks_system_previous_turn_and_new_turn():
    history = [
        {"role": "user", "content": "turn one " * 50},
        {"role": "assistant", "content": "reply one"},
        {"role": "user", "content": "turn two " * 50},
        {"role": "assistant", "content": "reply two"},
    ]
    messages = build_messages(PROFILES["dashscope"], LONG, history, "turn three", continues=True)
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user", "assistant", "user"]
    # System prefix, the previous request's final user turn, and this request's final turn.
    assert _marks(messages) == [0, 3, 5]
    block = messages[3]["content"][0]
    assert block == {"type": "text", "text": "turn two " * 50, "cache_control": {"type": "ephemeral"}}
    # Replies stay plain strings; the caller's history is not mutated.
    assert isinstance(messages[4]["content"], str)
    assert isinstance(history[2]["content"], str)
    # A one-shot call writes nothing it will not read again: only the shared system prefix.
    single = build_messages(PROFILES["dashscope"], LONG, None, "question")
    assert _marks(single) == [0]


def test_explicit_breakpoints_respect_minimum_and_limit():
    short = build_messages(PROFILES["dashscope"], "short system", None, "q", continues=True)
    assert _marks(short) == []  # below DashScope's 1024-token minimum: stays eligible for implicit caching
    limited = cache.CacheProfile("tight", cache.EXPLICIT, max_breakpoints=1)
    history = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    assert _marks(build_messages(limited, LONG, history, "c", continues=True)) == [3]


@pytest.mark.parametrize("name", ["deepseek", "openai", "anthropic", "gemini", "xai", "openai_compatible", "off"])
def test_non_explicit_profiles_send_plain_messages(name):
    history = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    messages = build_messages(PROFILES[name], LONG, history, "c", continues=True)
    assert all(isinstance(m["content"], str) for m in messages)


def test_request_hints_per_profile():
    assert request_hints(PROFILES["deepseek"], key="k") == {}
    assert request_hints(PROFILES["openai"], key="k") == {"prompt_cache_key": "k"}
    assert request_hints(PROFILES["openai"], key="k", retention="24h") == {
        "prompt_cache_key": "k",
        "prompt_cache_retention": "24h",
    }
    assert request_hints(PROFILES["deepseek"], key="k", retention="24h") == {}
    assert request_hints(PROFILES["xai"], key="k") == {"custom_headers": {"x-grok-conv-id": "k"}}
    assert request_hints(PROFILES["affinity"], key="k") == {"session_id": "k"}
    assert cache.static_hints(PROFILES["openai"], key="k") == {"prompt_cache_key": "k"}


def test_routing_key_is_stable_and_per_prefix():
    key = cache.routing_key("route", "system A")
    assert key == cache.routing_key("route", "system A")
    assert key != cache.routing_key("route", "system B")
    assert key != cache.routing_key("other route", "system A")
    assert key.startswith("tyche-") and len(key) <= 64


class _BadRequest(Exception):
    status_code = 400


class _RateLimited(Exception):
    status_code = 429


def test_request_rejected_only_for_request_validation_errors():
    assert cache.request_rejected(_BadRequest("Unrecognized request argument supplied: prompt_cache_key"))
    assert cache.request_rejected(_BadRequest("messages[0].content: expected a string"))
    assert cache.request_rejected(TypeError("create() got an unexpected keyword argument 'prompt_cache_retention'"))
    assert not cache.request_rejected(_RateLimited("prompt_cache_key rate limited"))
    assert not cache.request_rejected(TimeoutError("cache_control"))
    try:
        try:
            raise _BadRequest("unknown field cache_control")
        except _BadRequest as inner:
            raise RuntimeError("openAI API async invoke error") from inner
    except RuntimeError as wrapped:
        assert cache.request_rejected(wrapped)


def _conversation(ledger, profile, turns, route="r"):
    """Send an append-only conversation through ``ledger``; return each request's check."""
    checks, history = [], []
    for i, user in enumerate(turns):
        checks.append(ledger.observe(route, build_messages(profile, LONG, history, user), profile))
        history += [{"role": "user", "content": user}, {"role": "assistant", "content": f"reply {i}"}]
    return checks, history


def test_prefix_ledger_measures_append_only_reuse_and_flags_edits():
    profile = PROFILES["automatic"]
    ledger = PrefixLedger()
    checks, history = _conversation(ledger, profile, ["first " * 30, "second " * 30, "third " * 30])
    assert checks[0].reusable_tokens == 0
    # Turn n reuses exactly the previous request: system plus every earlier user turn and reply.
    assert checks[1].reusable_tokens == count_tokens(LONG) + count_tokens("first " * 30)
    assert checks[2].reusable_tokens > checks[1].reusable_tokens
    assert not any(c.cache_break for c in checks)

    # Editing an earlier user turn breaks the prefix and is flagged.
    edited = [dict(t) for t in history]
    edited[2]["content"] = "second, rewritten"
    check = ledger.observe("r", build_messages(profile, LONG, edited, "fourth"), profile)
    assert check.cache_break

    # Rolling back to an earlier checkpoint re-extends a prefix that was sent: not a break.
    rolled = history[:2]
    assert not ledger.observe("r", build_messages(profile, LONG, rolled, "again"), profile).cache_break

    # A conversation resumed in a new process has no earlier requests to compare with.
    fresh = PrefixLedger()
    assert not fresh.observe("r", build_messages(profile, LONG, history, "resumed"), profile).cache_break


def test_prefix_ledger_shares_system_prefix_and_applies_provider_minimum():
    ledger = PrefixLedger()
    openai = PROFILES["openai"]
    ledger.observe("r", build_messages(openai, LONG, None, "question one"), openai)
    check = ledger.observe("r", build_messages(openai, LONG, None, "question two"), openai)
    system_tokens = count_tokens(LONG)
    assert check.reusable_tokens == system_tokens - system_tokens % 128  # OpenAI's 128-token increments
    # Below the documented 1024-token minimum nothing is expected to hit.
    small = PrefixLedger()
    small.observe("r", build_messages(openai, "tiny system", None, "a"), openai)
    assert small.observe("r", build_messages(openai, "tiny system", None, "b"), openai).reusable_tokens == 0
    # Routes do not share prefixes: another model or parameter set has its own cache.
    assert ledger.observe("other", build_messages(openai, LONG, None, "x"), openai).reusable_tokens == 0


def test_prefix_ledger_reads_marked_content_like_plain_text():
    ledger = PrefixLedger()
    plain, marked = PROFILES["automatic"], PROFILES["explicit"]
    ledger.observe("r", build_messages(plain, LONG, None, "q1"), plain)
    assert ledger.observe("r", build_messages(marked, LONG, None, "q2"), marked).reusable_tokens == count_tokens(LONG)


def test_bare_yaml_off_disables_the_adapter():
    config = TycheConfig.load(overrides=["models.default.cache=off"], env={})
    assert config.model("writer").cache == "off"
    assert config.model("writer").cache_profile().mechanism == cache.NONE
    config = TycheConfig.load(overrides=[{"models": {"reviewer": {"cache": False}}}], env={})
    assert config.model("reviewer").cache == "off"
