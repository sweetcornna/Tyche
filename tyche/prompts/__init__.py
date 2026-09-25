"""Prompt templates. Each ``<name>.md`` file is loaded verbatim."""

from functools import lru_cache
from importlib import resources


@lru_cache(maxsize=None)
def load_prompt(name: str) -> str:
    return resources.files("tyche.prompts").joinpath(f"{name}.md").read_text(encoding="utf-8").strip()
