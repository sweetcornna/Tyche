"""Language-model access for Tyche.

Every stage talks to models through :class:`LLMClient`. The production client
wraps ``openjiuwen.core.foundation.llm.init_model`` so JiuwenSwarm's provider
support (OpenAI-compatible endpoints such as DeepSeek, Huawei Cloud MaaS,
DashScope, ...) is reused as-is. :class:`ScriptedLLM` replays deterministic
handlers for tests and the offline selftest.

Structured outputs are requested as JSON and validated with pydantic; a failed
parse is sent back to the model with the validation error, a bounded number of
times, before the call fails loudly.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from tyche import cache
from tyche.config import ModelSpec

T = TypeVar("T", bound=BaseModel)
log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """A model call failed or never produced a valid structured answer."""


@dataclass
class LLMReply:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""
    latency_s: float = 0.0
    # Input tokens the provider served from its prompt cache (DeepSeek prompt_cache_hit_tokens,
    # OpenAI cached_tokens, Anthropic cache_read_input_tokens; openjiuwen normalizes them).
    cached_tokens: int = 0
    # Input tokens written to an explicit cache (Anthropic/DashScope cache_creation_input_tokens).
    cache_write_tokens: int = 0
    # Whether the provider reported cache usage at all; a 0 hit count means nothing without it.
    cache_reported: bool = False
    # PrefixLedger estimates (local tokenizer): prompt size, the part an earlier request on the
    # same route already sent, and whether this turn broke its conversation's earlier prefix.
    est_prompt_tokens: int = 0
    est_reusable_tokens: int = 0
    cache_break: bool = False


@dataclass
class UsageRecord:
    purpose: str
    stage: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_s: float
    cached_tokens: int = 0
    cache_write_tokens: int = 0
    cache_reported: bool = False
    est_prompt_tokens: int = 0
    est_reusable_tokens: int = 0
    cache_break: bool = False


@dataclass
class UsageMeter:
    """Token accounting per stage and purpose, written into the run report.

    Two cache measures are kept apart. ``cache_hit_rate`` is what providers reported: cached
    input over all input, where input includes cache writes (cacheRead / (cacheRead + uncached +
    cacheWrite)). ``prefix_reuse_rate`` is Tyche's own, provider-independent estimate of how much
    of each prompt repeated an earlier request's prefix, the ceiling any prefix cache can reach;
    ``cache_breaks`` counts conversation turns that edited an earlier prefix (should be 0).
    """

    records: list[UsageRecord] = field(default_factory=list)
    stage: str = ""
    # Shared by every client of a run, so roles that share a model route share prefixes.
    ledger: cache.PrefixLedger = field(default_factory=cache.PrefixLedger)

    def add(self, purpose: str, reply: LLMReply) -> None:
        self.records.append(
            UsageRecord(
                purpose=purpose,
                stage=self.stage,
                model=reply.model,
                input_tokens=reply.input_tokens,
                output_tokens=reply.output_tokens,
                latency_s=round(reply.latency_s, 3),
                cached_tokens=reply.cached_tokens,
                cache_write_tokens=reply.cache_write_tokens,
                cache_reported=reply.cache_reported,
                est_prompt_tokens=reply.est_prompt_tokens,
                est_reusable_tokens=reply.est_reusable_tokens,
                cache_break=reply.cache_break,
            )
        )

    @staticmethod
    def _row(records: list[UsageRecord]) -> dict[str, Any]:
        row: dict[str, Any] = {
            "calls": len(records),
            "input_tokens": sum(r.input_tokens for r in records),
            "cached_input_tokens": sum(r.cached_tokens for r in records),
            "cache_write_tokens": sum(r.cache_write_tokens for r in records),
            "output_tokens": sum(r.output_tokens for r in records),
        }
        row["uncached_input_tokens"] = row["input_tokens"] - row["cached_input_tokens"]
        row["cache_hit_rate"] = _rate(row["cached_input_tokens"], row["input_tokens"])
        row["calls_without_cache_report"] = sum(1 for r in records if not r.cache_reported)
        est_prompt = sum(r.est_prompt_tokens for r in records)
        row["prefix_reuse_rate"] = _rate(sum(r.est_reusable_tokens for r in records), est_prompt)
        row["cache_breaks"] = sum(1 for r in records if r.cache_break)
        return row

    def summary(self) -> dict[str, Any]:
        stages: dict[str, list[UsageRecord]] = {}
        for rec in self.records:
            stages.setdefault(rec.stage or "unscoped", []).append(rec)
        return {"total": self._row(self.records), "by_stage": {k: self._row(v) for k, v in stages.items()}}


def _rate(part: int, whole: int) -> float:
    return round(part / whole, 3) if whole else 0.0


class LLMClient(Protocol):
    name: str

    async def complete(
        self,
        *,
        system: str,
        user: str,
        purpose: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
        continues: bool = False,
    ) -> LLMReply: ...


class OpenJiuwenLLM:
    """LLMClient backed by openjiuwen's unified model client.

    Requests are shaped for the provider's prompt cache by :mod:`tyche.cache`: explicit
    breakpoints where the provider needs them, a routing key where it accepts one. If the
    provider refuses a hint, the call is repeated once without hints and hints stay off for
    this client, so an unfamiliar endpoint never fails because of cache adaptation.
    """

    def __init__(self, spec: ModelSpec, *, meter: UsageMeter | None = None):
        api_key = spec.api_key()
        if not api_key:
            raise LLMError(
                f"environment variable {spec.api_key_env} is empty; set it (for example in .env) "
                f"before running the {spec.role} model"
            )
        from openjiuwen.core.foundation.llm import init_model

        self.spec = spec
        self.name = spec.model_name
        self.meter = meter
        self.route = spec.route()
        self.profile = spec.cache_profile()
        self.hints_enabled = self.profile.mechanism != cache.NONE
        self._ledger = meter.ledger if meter is not None else cache.PrefixLedger()
        # One routing key per role for requests Tyche does not build (openjiuwen's experiment
        # agents); Tyche's own calls override it with a key per shared system prefix.
        self._static = (
            cache.static_hints(self.profile, key=cache.routing_key(self.route, spec.role))
            if self.hints_enabled
            else {}
        )
        self._model = self._build_model(init_model, api_key, self._static)

    def _build_model(self, init_model: Callable[..., Any], api_key: str, static: dict[str, Any]) -> Any:
        spec = self.spec
        return init_model(
            spec.provider,
            spec.model_name,
            api_key,
            spec.api_base,
            temperature=spec.temperature,
            max_tokens=spec.max_tokens,
            timeout=spec.timeout,
            verify_ssl=True,
            extra_body=spec.extra_body or None,
            **static,
        )

    @property
    def openjiuwen_model(self) -> Any:
        """The underlying openjiuwen Model, shared with the experiment engine."""
        return self._model

    async def _invoke(self, messages: list[dict[str, Any]], hints: dict[str, Any], temperature, max_tokens):
        return await self._model.invoke(
            messages,
            temperature=temperature if temperature is not None else self.spec.temperature,
            max_tokens=max_tokens or self.spec.max_tokens,
            **hints,
        )

    async def complete(
        self,
        *,
        system: str,
        user: str,
        purpose: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
        continues: bool = False,
    ) -> LLMReply:
        started = time.monotonic()
        profile = self.profile if self.hints_enabled else cache.PROFILES["off"]
        messages = cache.build_messages(profile, system, history, user, continues=continues)
        hints = cache.request_hints(
            profile, key=cache.routing_key(self.route, system), retention=self.spec.cache_retention
        )
        check = self._ledger.observe(self.route, messages, self.profile)
        try:
            message = await self._invoke(messages, hints, temperature, max_tokens)
        except Exception as exc:
            if not (self.hints_enabled and (hints or messages != _plain(messages)) and cache.hint_rejected(exc)):
                raise
            log.warning(
                "%s (%s) refused a prompt-cache hint of profile %s; continuing without cache hints: %s",
                self.spec.role, self.spec.model_name, self.profile.name, str(exc)[:300],
            )
            self.hints_enabled = False
            if self._static:
                from openjiuwen.core.foundation.llm import init_model

                self._static = {}
                self._model = self._build_model(init_model, self.spec.api_key(), {})
            message = await self._invoke(_plain(messages), {}, temperature, max_tokens)
        content = message.content if isinstance(message.content, str) else json.dumps(message.content)
        usage = message.usage_metadata
        reported = usage is not None and (
            getattr(usage, "cache_status", None) == "observed"
            or getattr(usage, "cache_read_tokens", None) is not None
        )
        reply = LLMReply(
            text=content or "",
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            model=self.spec.model_name,
            latency_s=time.monotonic() - started,
            cached_tokens=int(getattr(usage, "cache_read_tokens", 0) or 0),
            cache_write_tokens=int(
                getattr(usage, "cache_write_tokens", None) or getattr(usage, "cache_creation_input_tokens", 0) or 0
            ),
            cache_reported=bool(reported),
            est_prompt_tokens=check.prompt_tokens,
            est_reusable_tokens=check.reusable_tokens,
            cache_break=check.cache_break,
        )
        if check.cache_break:
            log.warning("%s: request %s edited an earlier conversation turn (prompt-cache break)", self.spec.role, purpose)
        if self.meter is not None:
            self.meter.add(purpose, reply)
        return reply


def _plain(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The messages with cache breakpoints removed (content blocks back to strings)."""
    out = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
        out.append({**message, "content": content})
    return out


Handler = Callable[..., "str | Awaitable[str]"]


class ScriptedLLM:
    """Deterministic LLMClient for tests and the offline selftest.

    Handlers are looked up by exact purpose, then by the longest purpose
    prefix ending at a ``:``. Unknown purposes raise, so tests notice drift.
    """

    def __init__(self, handlers: dict[str, Handler], *, name: str = "scripted", meter: UsageMeter | None = None):
        self.handlers = handlers
        self.name = name
        self.meter = meter
        self.calls: list[tuple[str, str, str]] = []
        # Earlier turns sent with each call (empty for single-turn calls), parallel to ``calls``.
        self.histories: list[list[dict[str, str]]] = []
        # Prefix accounting as for a provider with an automatic prefix cache, so the selftest
        # measures the request shape the real clients send.
        self.profile = cache.PROFILES["automatic"]
        self.ledger = meter.ledger if meter is not None else cache.PrefixLedger()

    def _handler(self, purpose: str) -> Handler:
        if purpose in self.handlers:
            return self.handlers[purpose]
        parts = purpose.split(":")
        for cut in range(len(parts) - 1, 0, -1):
            prefix = ":".join(parts[:cut])
            if prefix in self.handlers:
                return self.handlers[prefix]
        raise LLMError(f"ScriptedLLM has no handler for purpose {purpose!r}")

    async def complete(
        self,
        *,
        system: str,
        user: str,
        purpose: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
        continues: bool = False,
    ) -> LLMReply:
        self.calls.append((purpose, system, user))
        self.histories.append(list(history or []))
        check = self.ledger.observe(
            f"scripted:{self.name}", cache.build_messages(self.profile, system, history, user), self.profile
        )
        handler = self._handler(purpose)
        # Handlers take (system, user), or (system, user, history) to see earlier turns.
        takes_history = len(inspect.signature(handler).parameters) >= 3
        result = handler(system, user, list(history or [])) if takes_history else handler(system, user)
        if asyncio.iscoroutine(result):
            result = await result
        from tyche.textutil import count_tokens

        reply = LLMReply(
            text=str(result),
            input_tokens=count_tokens(system) + sum(count_tokens(m["content"]) for m in history or []) + count_tokens(user),
            output_tokens=count_tokens(str(result)),
            model=self.name,
            est_prompt_tokens=check.prompt_tokens,
            est_reusable_tokens=check.reusable_tokens,
            cache_break=check.cache_break,
        )
        if self.meter is not None:
            self.meter.add(purpose, reply)
        return reply


@dataclass
class Conversation:
    """An append-only multi-turn exchange with one model role.

    Every request is the previous request plus its reply plus one new user turn, so the
    provider's prefix cache serves all earlier turns; only the newest turn and the last
    reply are uncached. Automatic caches need nothing more; for explicit caches
    :mod:`tyche.cache` puts a breakpoint on the previous and the newest user turn. Earlier turns are never edited. A rejected step is undone by truncating
    the history back to a checkpoint, which leaves a prefix of an earlier request.
    Keep one Conversation per LLMClient role: request parameters (model, max_tokens,
    reasoning effort) are part of the provider's cache key.
    """

    system: str
    turns: list[dict[str, str]] = field(default_factory=list)

    def checkpoint(self) -> int:
        return len(self.turns)

    def rollback(self, mark: int) -> None:
        del self.turns[mark:]

    def tokens(self) -> int:
        from tyche.textutil import count_tokens

        return count_tokens(self.system) + sum(count_tokens(t["content"]) for t in self.turns)

    async def ask(self, llm: LLMClient, user: str, *, purpose: str, record: str | None = None) -> LLMReply:
        """Send ``user`` after the history and append the exchange.

        ``record`` replaces the reply text in the history (for example with the sanitized
        section actually kept); the reply itself is never part of a cached prefix, so this
        does not cost cache hits.
        """
        reply = await llm.complete(
            system=self.system, user=user, purpose=purpose, history=list(self.turns), continues=True
        )
        self.turns.append({"role": "user", "content": user})
        self.turns.append({"role": "assistant", "content": reply.text if record is None else record})
        return reply

    def set_last_reply(self, text: str) -> None:
        """Replace the latest assistant turn (see ``ask``'s ``record``)."""
        if self.turns and self.turns[-1]["role"] == "assistant":
            self.turns[-1]["content"] = text


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> Any:
    """Parse the first JSON object or array in a model reply."""
    candidates: list[str] = [m.group(1) for m in _FENCE.finditer(text or "")]
    candidates.append(text or "")
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
        start = min((i for i in (candidate.find("{"), candidate.find("[")) if i >= 0), default=-1)
        if start >= 0:
            try:
                from json_repair import repair_json

                repaired = repair_json(candidate[start:], return_objects=True)
                if repaired not in ("", None):
                    return repaired
            except Exception:  # noqa: BLE001 - json_repair is best effort
                pass
    raise ValueError("no JSON value found in model reply")


def schema_hint(model: type[BaseModel]) -> str:
    return json.dumps(model.model_json_schema(), ensure_ascii=False)


async def complete_json(
    llm: LLMClient,
    *,
    system: str,
    user: str,
    schema: type[T],
    purpose: str,
    retries: int = 2,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> T:
    """Ask for a JSON answer matching ``schema``; re-ask with the error on failure.

    The schema instruction ends the system prompt rather than following the user text, so
    every call for one purpose shares the same system+schema prefix (prompt-cache friendly);
    a retry keeps that prefix and the original user text and appends only the rejection.
    """
    system_json = (
        system
        + "\n\nReturn only one JSON value that validates against this JSON schema, with no commentary:\n"
        + schema_hint(schema)
    )
    prompt = user
    last_error = ""
    for attempt in range(retries + 1):
        reply = await llm.complete(
            system=system_json,
            user=prompt,
            purpose=purpose if attempt == 0 else f"{purpose}:retry",
            temperature=temperature,
            max_tokens=max_tokens,
        )
        try:
            return schema.model_validate(extract_json(reply.text))
        except (ValueError, ValidationError) as exc:
            last_error = str(exc)[:1500]
            prompt = (
                user
                + "\n\nYour previous answer was rejected by the validator:\n"
                + last_error
                + "\nFix it and return only the corrected JSON."
            )
    raise LLMError(f"{purpose}: no valid structured answer after {retries + 1} attempts: {last_error}")


_LATEX_BLOCK = re.compile(r"<latex>(.*?)</latex>", re.S)


def extract_latex(text: str) -> str:
    """Return the body between <latex> tags, or a fenced block, or the raw text."""
    match = _LATEX_BLOCK.search(text or "")
    if match:
        return match.group(1).strip()
    fence = re.search(r"```(?:latex|tex)?\s*(.*?)```", text or "", re.S)
    if fence:
        return fence.group(1).strip()
    return (text or "").strip()


def build_llm(spec: ModelSpec, meter: UsageMeter | None = None) -> OpenJiuwenLLM:
    return OpenJiuwenLLM(spec, meter=meter)
