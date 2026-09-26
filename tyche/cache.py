"""Prompt-cache adaptation for every model provider.

Every provider Tyche can reach caches requests by prefix, but they differ in how:

* Automatic prefix caches (DeepSeek, OpenAI, Gemini, xAI, Zhipu, MiniMax, Moonshot, self-hosted
  vLLM/SGLang, ...) only need a request that repeats an earlier one's prefix byte for byte. Some
  also accept a routing hint that sends requests sharing a prefix to the same cache: OpenAI's
  ``prompt_cache_key`` body field, xAI's ``x-grok-conv-id`` header, and the ``session_id`` that
  openjiuwen's KV-affinity gateways turn into an ``agent_hint``.
* Explicit caches (Qwen on DashScope; Anthropic and Qwen models behind OpenRouter or another
  OpenAI-compatible gateway) cache only up to ``cache_control`` breakpoints on content blocks.
  openjiuwen already places these for the native Anthropic client and for its OpenRouter
  provider; this module places them everywhere else.

What works for all of them is the request shape, and Tyche controls it everywhere: one fixed
system prefix per purpose, append-only conversations (:class:`tyche.llm.Conversation`), constant
request parameters per role, and nothing volatile in the prefix. This module adds the
provider-specific part, :func:`build_messages` and :func:`request_hints`, on top of that shape.
:class:`PrefixLedger` checks the shape itself. For each model route it records which message
prefixes have already been sent, so every call reports how many of its prompt tokens a prefix
cache could serve and whether it broke a conversation's earlier prefix. That estimate works even
for providers that report no cache usage, and the offline selftest fails on a cache break.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from tyche.textutil import count_tokens

AUTOMATIC = "automatic"  # provider caches prefixes on its own; Tyche keeps the shape stable
EXPLICIT = "explicit"  # Tyche places cache_control breakpoints on content blocks
CLIENT = "client"  # openjiuwen's client places the breakpoints (native Anthropic, OpenRouter provider)
UNVERIFIED = "unverified"  # caching behaviour undocumented; Tyche keeps the shape stable and measures
NONE = "none"  # adapter switched off


@dataclass(frozen=True)
class CacheProfile:
    """How one provider's prompt cache is fed and what its documentation promises."""

    name: str
    mechanism: str
    # Shortest prefix the provider caches, as documented; 0 when undocumented.
    min_prefix_tokens: int = 0
    # Cache hits are reported rounded down to a multiple of this many tokens.
    granularity: int = 1
    # Body field that carries a routing key (OpenAI ``prompt_cache_key``).
    key_field: str = ""
    # HTTP header that carries a routing key (xAI ``x-grok-conv-id``).
    key_header: str = ""
    # openjiuwen KV-affinity gateways route by the ``session_id`` request keyword.
    session_affinity: bool = False
    # Body field for an optional retention hint (OpenAI ``prompt_cache_retention``).
    retention_field: str = ""
    # Largest number of cache_control breakpoints one request may carry.
    max_breakpoints: int = 4
    note: str = ""

    def public_dict(self) -> dict[str, Any]:
        return {
            "profile": self.name,
            "mechanism": self.mechanism,
            "min_prefix_tokens": self.min_prefix_tokens,
            "routing_hint": self.key_field or self.key_header or ("session_id" if self.session_affinity else ""),
            "note": self.note,
        }


PROFILES: dict[str, CacheProfile] = {
    p.name: p
    for p in (
        CacheProfile(
            "deepseek", AUTOMATIC,
            note="automatic prefix cache; hits in usage.prompt_cache_hit_tokens",
        ),
        CacheProfile(
            "openai", AUTOMATIC, min_prefix_tokens=1024, granularity=128,
            key_field="prompt_cache_key", retention_field="prompt_cache_retention",
            note="automatic from 1024 tokens; prompt_cache_key routes shared prefixes to one cache",
        ),
        CacheProfile(
            "azure_openai", AUTOMATIC, min_prefix_tokens=1024, granularity=128,
            note="automatic from 1024 tokens",
        ),
        CacheProfile(
            "anthropic", CLIENT, min_prefix_tokens=1024,
            note="openjiuwen marks the system block, tools, and last message with cache_control",
        ),
        CacheProfile(
            "openrouter_client", CLIENT,
            note="openjiuwen's OpenRouter provider marks Anthropic/Qwen models; others cache automatically",
        ),
        CacheProfile(
            "openrouter", AUTOMATIC,
            note="upstream provider caches automatically; OpenRouter keeps a session on one provider",
        ),
        CacheProfile(
            "openrouter_explicit", EXPLICIT, min_prefix_tokens=1024,
            note="Anthropic/Qwen model behind OpenRouter: Tyche places cache_control breakpoints",
        ),
        CacheProfile(
            "dashscope", EXPLICIT, min_prefix_tokens=1024,
            note="explicit cache: 10% hits after a 125% write, versus best-effort implicit hits",
        ),
        CacheProfile(
            "gemini", AUTOMATIC, min_prefix_tokens=2048,
            note="implicit cache on Gemini 2.5 and later; 2048-4096 token minimum by model",
        ),
        CacheProfile(
            "xai", AUTOMATIC, key_header="x-grok-conv-id",
            note="automatic; x-grok-conv-id routes a conversation to one server",
        ),
        CacheProfile("moonshot", AUTOMATIC, note="automatic on models with context caching"),
        CacheProfile("zhipu", AUTOMATIC, min_prefix_tokens=512, note="automatic implicit cache"),
        CacheProfile("minimax", AUTOMATIC, note="automatic prefix cache"),
        CacheProfile(
            "affinity", AUTOMATIC, session_affinity=True,
            note="openjiuwen KV-affinity gateway: session_id becomes an agent_hint",
        ),
        CacheProfile("self_hosted", AUTOMATIC, note="vLLM/SGLang automatic prefix caching when enabled"),
        CacheProfile("automatic", AUTOMATIC, note="declared automatic prefix cache"),
        CacheProfile(
            "explicit", EXPLICIT,
            note="declared explicit cache (for example a gateway in front of Claude or Qwen)",
        ),
        CacheProfile("openai_compatible", UNVERIFIED, note="caching undocumented; request shape kept stable"),
        CacheProfile("off", NONE, note="cache adapter disabled"),
    )
}

# Hosts are matched as a suffix of the api_base hostname.
_HOSTS: tuple[tuple[str, str], ...] = (
    ("api.deepseek.com", "deepseek"),
    ("api.openai.com", "openai"),
    ("openai.azure.com", "azure_openai"),
    ("cognitiveservices.azure.com", "azure_openai"),
    ("openrouter.ai", "openrouter"),
    ("dashscope.aliyuncs.com", "dashscope"),
    ("dashscope-intl.aliyuncs.com", "dashscope"),
    ("generativelanguage.googleapis.com", "gemini"),
    ("api.x.ai", "xai"),
    ("moonshot.cn", "moonshot"),
    ("moonshot.ai", "moonshot"),
    ("kimi.com", "moonshot"),
    ("bigmodel.cn", "zhipu"),
    ("z.ai", "zhipu"),
    ("minimaxi.com", "minimax"),
    ("minimax.io", "minimax"),
    ("minimax.chat", "minimax"),
)
# openjiuwen provider names (ProviderType values, lower-cased) that decide the profile.
_PROVIDERS: dict[str, str] = {
    "anthropic": "anthropic",
    "openrouter": "openrouter_client",
    "deepseek": "deepseek",
    "dashscope": "dashscope",
    "moonshot": "moonshot",
    "zhipu": "zhipu",
    "minimax": "minimax",
    "ascendaffinity": "affinity",
    "inferenceaffinity": "affinity",
}
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "::1")
# OpenRouter model prefixes whose providers cache only at explicit breakpoints.
_OPENROUTER_EXPLICIT = ("anthropic/", "qwen/")


class CacheConfigError(ValueError):
    """An unknown cache profile name was configured."""


def _host(api_base: str) -> str:
    base = (api_base or "").strip()
    if "://" not in base:
        base = "https://" + base
    return (urlparse(base).hostname or "").lower()


def detect_profile(provider: str, api_base: str, model: str, setting: str = "auto") -> CacheProfile:
    """Pick the cache profile for a model route.

    ``setting`` is the configured ``cache`` value: ``auto`` detects from the provider name, the
    api_base host, and (for OpenRouter) the model's vendor prefix; any profile name forces that
    profile, and ``off`` disables the adapter.
    """
    setting = (setting or "auto").strip().lower()
    if setting != "auto":
        if setting not in PROFILES:
            raise CacheConfigError(f"unknown cache profile {setting!r}; use auto or one of {sorted(PROFILES)}")
        return PROFILES[setting]
    by_provider = _PROVIDERS.get((provider or "").strip().lower())
    if by_provider:
        return PROFILES[by_provider]
    host = _host(api_base)
    for suffix, name in _HOSTS:
        if host == suffix or host.endswith("." + suffix):
            if name == "openrouter" and (model or "").lower().lstrip("~").startswith(_OPENROUTER_EXPLICIT):
                return PROFILES["openrouter_explicit"]
            return PROFILES[name]
    if host in _LOCAL_HOSTS:
        return PROFILES["self_hosted"]
    return PROFILES["openai_compatible"]


def routing_key(route: str, system: str) -> str:
    """A stable key shared by every request that starts with ``system`` on ``route``.

    Derived from content only, so reruns and resumed runs reuse it. It never contains the
    credential: ``route`` is the public model route (base URL, model, parameters).
    """
    return "tyche-" + hashlib.sha256(f"{route}\n{system}".encode("utf-8")).hexdigest()[:24]


def _marked(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def build_messages(
    profile: CacheProfile,
    system: str,
    history: list[dict[str, str]] | None,
    user: str,
    *,
    continues: bool = False,
) -> list[dict[str, Any]]:
    """The chat messages for one request, with breakpoints where ``profile`` needs them.

    For explicit caches the breakpoints sit at the end of the system prompt (shared by every call
    of a purpose), at the previous request's final user turn (so this request reads exactly what
    that request wrote, however long the history), and, when the exchange ``continues``, at this
    request's final user turn (so the next turn can read it). Breakpoints whose prefix is below
    the provider's minimum are left out; a request with none stays in plain-string form. Other
    profiles get the plain messages unchanged.
    """
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    messages += [dict(turn) for turn in history or []]
    messages.append({"role": "user", "content": user})
    if profile.mechanism != EXPLICIT:
        return messages
    marks = [0]
    previous_tail = max((i for i in range(1, len(messages) - 1) if messages[i]["role"] == "user"), default=None)
    if previous_tail is not None:
        marks.append(previous_tail)
    if continues:
        marks.append(len(messages) - 1)
    cumulative, prefix_tokens = 0, []
    for message in messages:
        cumulative += count_tokens(str(message["content"]))
        prefix_tokens.append(cumulative)
    keep = [i for i in sorted(set(marks)) if prefix_tokens[i] >= profile.min_prefix_tokens]
    for i in keep[-profile.max_breakpoints:]:
        messages[i]["content"] = _marked(str(messages[i]["content"]))
    return messages


def request_hints(profile: CacheProfile, *, key: str, retention: str = "") -> dict[str, Any]:
    """Keyword arguments for openjiuwen's ``Model.invoke`` that steer the provider's cache.

    openjiuwen forwards unknown keywords as request fields, after the model's own configured
    fields, so a per-call key overrides the per-role key set by :func:`static_hints`.
    """
    hints: dict[str, Any] = {}
    if profile.key_field:
        hints[profile.key_field] = key
    if retention and profile.retention_field:
        hints[profile.retention_field] = retention
    if profile.key_header:
        hints["custom_headers"] = {profile.key_header: key}
    if profile.session_affinity:
        hints["session_id"] = key
    return hints


def static_hints(profile: CacheProfile, *, key: str) -> dict[str, Any]:
    """``init_model`` arguments that give every request of a model the same routing key.

    This covers requests Tyche does not build (openjiuwen's experiment agents). Retention stays
    per call, so a model that refuses it never breaks those agents.
    """
    hints: dict[str, Any] = {}
    if profile.key_field:
        hints[profile.key_field] = key
    if profile.key_header:
        hints["custom_headers"] = {profile.key_header: key}
    return hints


_HINT_WORDS = ("cache_control", "prompt_cache_key", "prompt_cache_retention", "x-grok-conv-id", "session_id")


def hint_rejected(exc: BaseException) -> bool:
    """Whether a call failed because the provider refused one of the cache hints Tyche sent.

    Only a request-validation failure (HTTP 400/422, or a client-side TypeError for an unknown
    keyword) that names a hint counts; timeouts, rate limits, and server errors never do.
    openjiuwen wraps provider errors, so the cause chain is searched.
    """
    current: BaseException | None = exc
    for _ in range(8):
        if current is None:
            break
        if isinstance(current, TypeError) or getattr(current, "status_code", None) in (400, 422):
            return any(word in str(current).lower() for word in _HINT_WORDS)
        current = current.__cause__ or current.__context__
    return False


def _common_prefix(a: str, b: str) -> int:
    """Length of the longest common prefix of two strings (binary search on slices)."""
    low, high = 0, min(len(a), len(b))
    while low < high:
        mid = (low + high + 1) // 2
        if a[:mid] == b[:mid]:
            low = mid
        else:
            high = mid - 1
    return low


@dataclass
class PrefixCheck:
    """One request as seen by :class:`PrefixLedger` (token counts are local estimates)."""

    prompt_tokens: int
    reusable_tokens: int
    cache_break: bool


class PrefixLedger:
    """Which message prefixes each model route has been sent, bounded to recent prefixes.

    A request's reusable tokens are those of its longest message prefix that an earlier request
    on the same route already contained: what a prefix cache that keeps every request could serve,
    reduced by the profile's documented minimum and granularity. For automatic caches, which
    match token by token, the common start of the first differing message counts as well;
    explicit caches serve only whole messages up to a breakpoint. A cache break is a conversation
    turn whose history, up to its latest reply, was never sent as a request although the
    conversation's opening turn was, so an earlier turn was edited rather than appended to.
    A conversation first seen after a process restart (a resumed run) is not flagged.
    """

    def __init__(self, limit: int = 50_000, followers: int = 4):
        self.limit = limit
        self.followers = followers
        self._seen: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._tokens: dict[str, int] = {}
        # Recent messages that followed each sent prefix, for the partial match inside the first
        # message that differs (automatic caches match token by token, not message by message).
        self._next: OrderedDict[tuple[str, str], list[tuple[str, str]]] = OrderedDict()

    def _count(self, text: str) -> int:
        digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
        if digest not in self._tokens:
            if len(self._tokens) >= self.limit:
                self._tokens.clear()
            self._tokens[digest] = count_tokens(text)
        return self._tokens[digest]

    def observe(self, route: str, messages: list[dict[str, Any]], profile: CacheProfile) -> PrefixCheck:
        chain = hashlib.sha256(route.encode("utf-8"))
        parents, digests, tokens, texts = [chain.hexdigest()], [], [], []
        running = 0
        for message in messages:
            content = message.get("content")
            text = content if isinstance(content, str) else "".join(
                part.get("text", "") for part in content or [] if isinstance(part, dict)
            )
            texts.append((str(message.get("role")), text))
            chain.update(f"\x1e{message.get('role')}\x1f{text}".encode("utf-8"))
            digests.append(chain.hexdigest())
            parents.append(digests[-1])
            running += self._count(text)
            tokens.append(running)
        longest = 0
        for i, digest in enumerate(digests):
            if (route, digest) in self._seen:
                longest = i + 1
        reusable = tokens[longest - 1] if longest else 0
        if longest < len(messages) and profile.mechanism in (AUTOMATIC, UNVERIFIED):
            role, text = texts[longest]
            shared = max(
                (_common_prefix(text, other) for r, other in self._next.get((route, parents[longest]), []) if r == role),
                default=0,
            )
            reusable += count_tokens(text[:shared]) if shared else 0
        if reusable < profile.min_prefix_tokens:
            reusable = 0
        reusable -= reusable % max(1, profile.granularity)
        # Stable part of a conversation turn: everything before its final assistant reply.
        stable = len(messages) - 2 if len(messages) >= 4 and messages[-2].get("role") == "assistant" else 0
        cache_break = bool(stable) and (route, digests[1]) in self._seen and (route, digests[stable - 1]) not in self._seen
        for i, digest in enumerate(digests):
            self._seen[(route, digest)] = None
            self._seen.move_to_end((route, digest))
            followers = self._next.setdefault((route, parents[i]), [])
            if texts[i] not in followers:
                followers.append(texts[i])
                del followers[: -self.followers]
            self._next.move_to_end((route, parents[i]))
        while len(self._seen) > self.limit:
            self._seen.popitem(last=False)
        while len(self._next) > self.limit:
            self._next.popitem(last=False)
        return PrefixCheck(prompt_tokens=tokens[-1], reusable_tokens=reusable, cache_break=cache_break)
