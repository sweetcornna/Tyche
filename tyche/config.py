"""Configuration loading for Tyche.

The default YAML ships inside the package. A user file and ``--set`` style
overrides are deep-merged on top, then ``${VAR:-default}`` placeholders are
expanded from the environment. Credentials are never stored in configuration:
models name the environment variable that holds their key.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from importlib import resources
from pathlib import Path
from typing import Any, Mapping

import yaml

_PLACEHOLDER = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}")
DIRECTIONS = ("context_engineering", "memory_engine", "self_evolution")


class ConfigError(ValueError):
    """Raised when configuration is missing or inconsistent."""


def _expand(value: Any, env: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        def repl(match: re.Match[str]) -> str:
            name, default = match.group(1), match.group(2)
            found = env.get(name)
            if found not in (None, ""):
                return str(found)
            return default if default is not None else ""

        return _PLACEHOLDER.sub(repl, value)
    if isinstance(value, dict):
        return {key: _expand(item, env) for key, item in value.items()}
    if isinstance(value, list):
        return [_expand(item, env) for item in value]
    return value


def deep_merge(base: dict[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def _default_config() -> dict[str, Any]:
    text = resources.files("tyche.configs").joinpath("tyche.default.yaml").read_text(encoding="utf-8")
    return yaml.safe_load(text) or {}


def load_direction(name: str) -> dict[str, Any]:
    """Load one topic-direction preset (seed queries, baselines, experiment families)."""
    if name not in DIRECTIONS:
        raise ConfigError(f"unknown direction {name!r}; choose one of {', '.join(DIRECTIONS)}")
    text = resources.files("tyche.configs.directions").joinpath(f"{name}.yaml").read_text(encoding="utf-8")
    return yaml.safe_load(text) or {}


def parse_override(expr: str) -> dict[str, Any]:
    """Turn ``a.b.c=value`` into a nested mapping; the value is parsed as YAML."""
    if "=" not in expr:
        raise ConfigError(f"override must look like key.path=value, got {expr!r}")
    path, raw = expr.split("=", 1)
    keys = [part for part in path.strip().split(".") if part]
    if not keys:
        raise ConfigError(f"empty key in override {expr!r}")
    value: Any = yaml.safe_load(raw)
    for key in reversed(keys):
        value = {key: value}
    return value


@dataclass(frozen=True)
class ModelSpec:
    role: str
    provider: str
    model_name: str
    api_base: str
    api_key_env: str
    timeout: float
    temperature: float | None
    max_tokens: int | None
    extra_body: dict[str, Any] = field(default_factory=dict)
    # Prompt-cache adapter setting (tyche/cache.py): "auto", a profile name, or "off".
    cache: str = "auto"
    # Optional provider cache-retention hint (OpenAI prompt_cache_retention); "" sends none.
    cache_retention: str = ""
    # Largest prompt plus completion the model accepts, in tokens; bounds multi-turn histories.
    context_window: int = 131072

    def api_key(self, env: Mapping[str, str] | None = None) -> str:
        source = os.environ if env is None else env
        return str(source.get(self.api_key_env, "") or "")

    def public_dict(self) -> dict[str, Any]:
        """Everything except the credential, for logs and provenance."""
        return {
            "role": self.role,
            "provider": self.provider,
            "model_name": self.model_name,
            "api_base": self.api_base,
            "api_key_env": self.api_key_env,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "extra_body": self.extra_body,
            "cache": self.cache,
            "cache_retention": self.cache_retention,
            "context_window": self.context_window,
        }

    def route(self) -> str:
        """The public identity of this role's prompt cache: provider caches are keyed by the
        endpoint, the model, and request parameters, never by the credential."""
        return f"{self.api_base}|{self.model_name}|t={self.temperature}|max={self.max_tokens}|{self.extra_body}"

    def cache_profile(self):
        from tyche.cache import detect_profile

        return detect_profile(self.provider, self.api_base, self.model_name, self.cache)


def _cache_setting(value: Any) -> str:
    """The ``cache`` model setting; YAML reads a bare ``off`` as false and ``on`` as true."""
    if isinstance(value, bool):
        return "auto" if value else "off"
    return str(value or "auto")


class TycheConfig:
    """Validated, environment-expanded configuration."""

    def __init__(self, data: dict[str, Any]):
        self.data = data
        self._validate()

    @classmethod
    def load(
        cls,
        path: str | Path | None = None,
        overrides: list[str | dict[str, Any]] | None = None,
        env: Mapping[str, str] | None = None,
        base: Mapping[str, Any] | None = None,
    ) -> "TycheConfig":
        """Defaults, then ``base`` (a run's saved config), then the user file, then overrides."""
        data = _default_config()
        if base:
            data = deep_merge(data, base)
        if path is not None:
            user = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
            if not isinstance(user, dict):
                raise ConfigError(f"{path} must contain a mapping")
            data = deep_merge(data, user)
        for expr in overrides or []:
            data = deep_merge(data, expr if isinstance(expr, Mapping) else parse_override(expr))
        return cls(_expand(data, os.environ if env is None else env))

    def _validate(self) -> None:
        for section in ("models", "workspace", "literature", "experiments", "paper", "review", "memory"):
            if not isinstance(self.data.get(section), dict):
                raise ConfigError(f"configuration section {section!r} is missing")
        engine = self.get("experiments.engine")
        if engine not in {"openjiuwen", "imported", "fixture"}:
            raise ConfigError(f"experiments.engine must be openjiuwen, imported or fixture, got {engine!r}")
        pages = self.get("paper.max_main_pages")
        if not isinstance(pages, int) or not 1 <= pages <= 9:
            raise ConfigError("paper.max_main_pages must be an integer between 1 and 9 (ICLR limit)")

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self.data
        for key in dotted.split("."):
            if not isinstance(node, dict) or key not in node:
                return default
            node = node[key]
        return node

    def model(self, role: str) -> ModelSpec:
        models = self.data["models"]
        base = dict(models.get("default") or {})
        for key, value in (models.get(role) or {}).items():
            if value not in (None, ""):
                base[key] = value
        if not base.get("model_name"):
            raise ConfigError(f"no model_name configured for role {role!r}")

        def _opt_float(value: Any) -> float | None:
            return None if value in (None, "") else float(value)

        def _opt_int(value: Any) -> int | None:
            return None if value in (None, "") else int(value)

        spec = ModelSpec(
            role=role,
            provider=str(base.get("provider") or "OpenAI"),
            model_name=str(base["model_name"]),
            api_base=str(base.get("api_base") or ""),
            api_key_env=str(base.get("api_key_env") or "API_KEY"),
            timeout=float(base.get("timeout") or 600),
            temperature=_opt_float(base.get("temperature")),
            max_tokens=_opt_int(base.get("max_tokens")),
            extra_body=dict(base.get("extra_body") or {}),
            cache=_cache_setting(base.get("cache")),
            cache_retention=str(base.get("cache_retention") or ""),
            context_window=_opt_int(base.get("context_window")) or 131072,
        )
        try:
            spec.cache_profile()
        except ValueError as exc:
            raise ConfigError(f"models.{role}.cache: {exc}") from exc
        return spec

    def workspace_root(self) -> Path:
        return Path(str(self.get("workspace.root") or "workspace")).expanduser().resolve()

    def digest(self) -> str:
        blob = json.dumps(self.data, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(blob).hexdigest()[:16]
