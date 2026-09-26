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
import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from tyche.config import ModelSpec

T = TypeVar("T", bound=BaseModel)


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


@dataclass
class UsageRecord:
    purpose: str
    stage: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_s: float
    cached_tokens: int = 0


@dataclass
class UsageMeter:
    """Token accounting per stage and purpose, written into the run report."""

    records: list[UsageRecord] = field(default_factory=list)
    stage: str = ""

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
            )
        )

    def summary(self) -> dict[str, Any]:
        by_stage: dict[str, dict[str, Any]] = {}
        for rec in self.records:
            row = by_stage.setdefault(
                rec.stage or "unscoped", {"calls": 0, "input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0}
            )
            row["calls"] += 1
            row["input_tokens"] += rec.input_tokens
            row["cached_input_tokens"] += rec.cached_tokens
            row["output_tokens"] += rec.output_tokens
        for row in by_stage.values():
            row["uncached_input_tokens"] = row["input_tokens"] - row["cached_input_tokens"]
            row["cache_hit_rate"] = _rate(row["cached_input_tokens"], row["input_tokens"])
        total = {
            "calls": len(self.records),
            "input_tokens": sum(r.input_tokens for r in self.records),
            "cached_input_tokens": sum(r.cached_tokens for r in self.records),
            "output_tokens": sum(r.output_tokens for r in self.records),
        }
        total["uncached_input_tokens"] = total["input_tokens"] - total["cached_input_tokens"]
        total["cache_hit_rate"] = _rate(total["cached_input_tokens"], total["input_tokens"])
        return {"total": total, "by_stage": by_stage}


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
    ) -> LLMReply: ...


class OpenJiuwenLLM:
    """LLMClient backed by openjiuwen's unified model client."""

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
        self._model = init_model(
            spec.provider,
            spec.model_name,
            api_key,
            spec.api_base,
            temperature=spec.temperature,
            max_tokens=spec.max_tokens,
            timeout=spec.timeout,
            verify_ssl=True,
            extra_body=spec.extra_body or None,
        )

    @property
    def openjiuwen_model(self) -> Any:
        """The underlying openjiuwen Model, shared with the experiment engine."""
        return self._model

    async def complete(
        self,
        *,
        system: str,
        user: str,
        purpose: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        history: list[dict[str, str]] | None = None,
    ) -> LLMReply:
        started = time.monotonic()
        message = await self._model.invoke(
            [{"role": "system", "content": system}, *(history or []), {"role": "user", "content": user}],
            temperature=temperature if temperature is not None else self.spec.temperature,
            max_tokens=max_tokens or self.spec.max_tokens,
        )
        content = message.content if isinstance(message.content, str) else json.dumps(message.content)
        usage = message.usage_metadata
        reply = LLMReply(
            text=content or "",
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            model=self.spec.model_name,
            latency_s=time.monotonic() - started,
            cached_tokens=int(getattr(usage, "cache_read_tokens", 0) or 0),
        )
        if self.meter is not None:
            self.meter.add(purpose, reply)
        return reply


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
    ) -> LLMReply:
        self.calls.append((purpose, system, user))
        self.histories.append(list(history or []))
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
        )
        if self.meter is not None:
            self.meter.add(purpose, reply)
        return reply


@dataclass
class Conversation:
    """An append-only multi-turn exchange with one model role.

    Every request is the previous request plus its reply plus one new user turn, so the
    provider's prefix cache (DeepSeek and OpenAI-compatible automatic caching; Anthropic
    and OpenRouter through openjiuwen's cache_control on the system block and last
    message) serves all earlier turns; only the newest turn and the last reply are
    uncached. Earlier turns are never edited. A rejected step is undone by truncating
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
        reply = await llm.complete(system=self.system, user=user, purpose=purpose, history=list(self.turns))
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
