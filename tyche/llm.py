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


@dataclass
class UsageRecord:
    purpose: str
    stage: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_s: float


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
            )
        )

    def summary(self) -> dict[str, Any]:
        by_stage: dict[str, dict[str, int]] = {}
        for rec in self.records:
            row = by_stage.setdefault(rec.stage or "unscoped", {"calls": 0, "input_tokens": 0, "output_tokens": 0})
            row["calls"] += 1
            row["input_tokens"] += rec.input_tokens
            row["output_tokens"] += rec.output_tokens
        total = {
            "calls": len(self.records),
            "input_tokens": sum(r.input_tokens for r in self.records),
            "output_tokens": sum(r.output_tokens for r in self.records),
        }
        return {"total": total, "by_stage": by_stage}


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
    ) -> LLMReply:
        started = time.monotonic()
        message = await self._model.invoke(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
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
        )
        if self.meter is not None:
            self.meter.add(purpose, reply)
        return reply


Handler = Callable[[str, str], "str | Awaitable[str]"]


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
    ) -> LLMReply:
        self.calls.append((purpose, system, user))
        result = self._handler(purpose)(system, user)
        if asyncio.iscoroutine(result):
            result = await result
        from tyche.textutil import count_tokens

        reply = LLMReply(
            text=str(result),
            input_tokens=count_tokens(system) + count_tokens(user),
            output_tokens=count_tokens(str(result)),
            model=self.name,
        )
        if self.meter is not None:
            self.meter.add(purpose, reply)
        return reply


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
    """Ask for a JSON answer matching ``schema``; re-ask with the error on failure."""
    instruction = (
        "\n\nReturn only one JSON value that validates against this JSON schema, "
        "with no commentary:\n" + schema_hint(schema)
    )
    prompt = user + instruction
    last_error = ""
    for attempt in range(retries + 1):
        reply = await llm.complete(
            system=system,
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
                + instruction
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
