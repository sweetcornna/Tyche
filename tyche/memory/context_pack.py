"""Context engineering: build prompts under an explicit token budget.

A pack is assembled from *blocks*. Required blocks (task instructions, the
section contract) always go in; optional blocks are admitted by priority and
then by retrieval score until the budget is spent; an oversized optional block
is trimmed to the remaining budget, never dropped silently. Every pack writes
a manifest (what was included, what was cut, token counts) so each model call
can be audited and the context policy itself can be studied.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from tyche.memory.store import MemoryItem, MemoryStore
from tyche.textutil import count_tokens, truncate_tokens


@dataclass
class Block:
    name: str
    text: str
    priority: int = 50  # lower number = admitted earlier
    required: bool = False
    score: float = 0.0
    item_ids: list[str] = field(default_factory=list)


@dataclass
class ContextPack:
    text: str
    budget: int
    used: int
    included: list[dict[str, Any]]
    dropped: list[dict[str, Any]]

    def manifest(self) -> dict[str, Any]:
        return {
            "budget": self.budget,
            "used": self.used,
            "included": self.included,
            "dropped": self.dropped,
        }

    @property
    def item_ids(self) -> list[str]:
        ids: list[str] = []
        for row in self.included:
            ids.extend(row.get("item_ids", []))
        return ids


def _wrap(block: Block) -> str:
    return f"<{block.name}>\n{block.text.strip()}\n</{block.name}>"


def pack(blocks: Iterable[Block], budget: int) -> ContextPack:
    blocks = list(blocks)
    required = [b for b in blocks if b.required]
    optional = sorted((b for b in blocks if not b.required), key=lambda b: (b.priority, -b.score))
    parts: list[str] = []
    included: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    used = 0
    for block in required:
        text = _wrap(block)
        tokens = count_tokens(text)
        parts.append(text)
        used += tokens
        included.append({"name": block.name, "tokens": tokens, "required": True, "item_ids": block.item_ids})
    for block in optional:
        text = _wrap(block)
        tokens = count_tokens(text)
        remaining = budget - used
        if tokens <= remaining:
            parts.append(text)
            used += tokens
            included.append({"name": block.name, "tokens": tokens, "item_ids": block.item_ids})
        elif remaining > 200:
            trimmed = Block(block.name, truncate_tokens(block.text, remaining - 40), block.priority)
            text = _wrap(trimmed)
            tokens = count_tokens(text)
            parts.append(text)
            used += tokens
            included.append({"name": block.name, "tokens": tokens, "trimmed": True, "item_ids": block.item_ids})
        else:
            dropped.append({"name": block.name, "tokens": tokens})
    return ContextPack(text="\n\n".join(parts), budget=budget, used=used, included=included, dropped=dropped)


def memory_block(
    store: MemoryStore,
    name: str,
    query: str,
    *,
    kinds: list[str],
    run_id: str | None,
    limit: int,
    priority: int = 50,
    scopes: list[str] | None = None,
    extra_filter=None,
) -> Block:
    """Retrieve memories relevant to ``query`` and render them as one block."""
    items: list[MemoryItem] = store.search(query, kinds=kinds, run_id=run_id, scopes=scopes, limit=limit * 3)
    if extra_filter is not None:
        items = [item for item in items if extra_filter(item)]
    items = items[:limit]
    if not items:
        return Block(name=name, text="(none)", priority=priority, score=0.0)
    text = "\n".join(f"- [{item.id}] {item.render()}" for item in items)
    return Block(
        name=name,
        text=text,
        priority=priority,
        score=max(item.score for item in items),
        item_ids=[item.id for item in items],
    )
