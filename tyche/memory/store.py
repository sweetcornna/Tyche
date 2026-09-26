"""Research Memory Engine.

A small, inspectable memory for research runs, stored in SQLite with an FTS5
index ranked by BM25. Each item records:

* ``kind`` -- evidence, decision, finding, lesson, preference, or note;
* ``provenance`` -- retrieved (quoted from a fetched source), observed (read
  from a tool or experiment output), or inferred (produced by a model; hold
  loosely);
* ``scope`` -- run (one paper), project (a topic line), or global (every run);
* supersession -- corrections link old to new instead of overwriting, so the
  history of a belief stays auditable;
* usage -- when an item was last packed into a prompt, for staleness checks.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from tyche.workspace import utcnow

KINDS = ("evidence", "decision", "finding", "lesson", "preference", "note")
PROVENANCE = ("retrieved", "observed", "inferred")
SCOPES = ("run", "project", "global")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    run_id TEXT,
    provenance TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    superseded_by TEXT,
    last_used_at TEXT,
    uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
CREATE INDEX IF NOT EXISTS idx_items_run ON items(run_id);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(id UNINDEXED, title, body, tags);
"""

_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_\-]{1,}")
_STOP = frozenset(
    "a an and are as at be by for from has have in into is it its of on or that the this to was were with we our "
    "their these those which how what when where why can may using use via".split()
)


@dataclass
class MemoryItem:
    id: str
    kind: str
    scope: str
    provenance: str
    body: str
    title: str = ""
    run_id: str | None = None
    source_ref: str = ""
    tags: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    superseded_by: str | None = None
    last_used_at: str | None = None
    uses: int = 0
    score: float = 0.0

    def render(self) -> str:
        """Compact prompt rendering with the provenance visible to the model."""
        ref = f" [{self.source_ref}]" if self.source_ref else ""
        head = f"({self.kind}/{self.provenance}{ref}) "
        title = f"{self.title}: " if self.title else ""
        return head + title + self.body


def fts_query(text: str, max_terms: int = 24) -> str:
    """Build a permissive OR query from free text; FTS syntax is never passed through."""
    terms: list[str] = []
    for token in _TOKEN.findall(text.lower()):
        if token in _STOP or token in terms:
            continue
        terms.append(token)
        if len(terms) >= max_terms:
            break
    return " OR ".join(f'"{term}"' for term in terms)


class MemoryStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path))
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    # -- writes --------------------------------------------------------
    def add(
        self,
        kind: str,
        body: str,
        *,
        provenance: str,
        scope: str = "run",
        run_id: str | None = None,
        title: str = "",
        source_ref: str = "",
        tags: Iterable[str] = (),
        meta: dict[str, Any] | None = None,
        item_id: str | None = None,
    ) -> str:
        if kind not in KINDS:
            raise ValueError(f"unknown memory kind {kind!r}")
        if provenance not in PROVENANCE:
            raise ValueError(f"unknown provenance {provenance!r}")
        if scope not in SCOPES:
            raise ValueError(f"unknown scope {scope!r}")
        if scope == "run" and not run_id:
            raise ValueError("run-scoped memory needs a run_id")
        new_id = item_id or self._content_id(kind, scope, run_id, title, source_ref, body)
        tag_list = sorted({t for t in tags if t})
        with self._conn:
            self._conn.execute(
                "INSERT INTO items (id, kind, scope, run_id, provenance, title, body, source_ref, tags, meta, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    new_id,
                    kind,
                    scope,
                    run_id,
                    provenance,
                    title,
                    body,
                    source_ref,
                    json.dumps(tag_list),
                    json.dumps(meta or {}, ensure_ascii=False),
                    utcnow(),
                ),
            )
            self._conn.execute(
                "INSERT INTO items_fts (id, title, body, tags) VALUES (?,?,?,?)",
                (new_id, title, body, " ".join(tag_list)),
            )
        return new_id

    def _content_id(self, *fields: str | None) -> str:
        """An id derived from the item's content, so identical inputs give identical prompts
        (memory blocks show ids) and prompt caches can match across processes. A counter keeps
        repeated identical items distinct."""
        blob = "\x1f".join(f or "" for f in fields)
        for n in range(10_000):
            digest = hashlib.sha256(f"{blob}\x1e{n}".encode("utf-8")).hexdigest()[:10]
            candidate = f"{(fields[0] or '')[:3]}-{digest}"
            if self._conn.execute("SELECT 1 FROM items WHERE id = ?", (candidate,)).fetchone() is None:
                return candidate
        raise RuntimeError("could not allocate a memory item id")

    def supersede(self, old_id: str, body: str, **fields: Any) -> str:
        """Record a correction: the old item stays, linked to its replacement."""
        old = self.get(old_id)
        if old is None:
            raise KeyError(old_id)
        if old.superseded_by:
            raise ValueError(f"{old_id} was already superseded by {old.superseded_by}; supersede that item instead")
        params = {
            "provenance": fields.pop("provenance", old.provenance),
            "scope": fields.pop("scope", old.scope),
            "run_id": fields.pop("run_id", old.run_id),
            "title": fields.pop("title", old.title),
            "source_ref": fields.pop("source_ref", old.source_ref),
            "tags": fields.pop("tags", old.tags),
            "meta": fields.pop("meta", old.meta),
        }
        if fields:
            raise TypeError(f"unexpected fields: {sorted(fields)}")
        new_id = self.add(old.kind, body, **params)
        with self._conn:
            self._conn.execute("UPDATE items SET superseded_by=? WHERE id=?", (new_id, old_id))
        return new_id

    def update_meta(self, item_id: str, **values: Any) -> None:
        item = self.get(item_id)
        if item is None:
            raise KeyError(item_id)
        meta = {**item.meta, **values}
        with self._conn:
            self._conn.execute("UPDATE items SET meta=? WHERE id=?", (json.dumps(meta, ensure_ascii=False), item_id))

    def retire_run_items(self, run_id: str, tags: Iterable[str]) -> int:
        """Hide this run's items carrying any of ``tags`` (used before a stage is rerun, so stale
        evidence from the previous attempt cannot reach later prompts). History is kept."""
        wanted = set(tags)
        retired = 0
        rows = self._conn.execute(
            "SELECT id, tags FROM items WHERE scope='run' AND run_id=? AND superseded_by IS NULL", (run_id,)
        ).fetchall()
        with self._conn:
            for row in rows:
                if wanted & set(json.loads(row["tags"] or "[]")):
                    self._conn.execute("UPDATE items SET superseded_by='retired' WHERE id=?", (row["id"],))
                    retired += 1
        return retired

    def touch(self, ids: Iterable[str]) -> None:
        now = utcnow()
        with self._conn:
            for item_id in ids:
                self._conn.execute("UPDATE items SET last_used_at=?, uses=uses+1 WHERE id=?", (now, item_id))

    # -- reads ---------------------------------------------------------
    @staticmethod
    def _row(row: sqlite3.Row, score: float = 0.0) -> MemoryItem:
        return MemoryItem(
            id=row["id"],
            kind=row["kind"],
            scope=row["scope"],
            provenance=row["provenance"],
            body=row["body"],
            title=row["title"],
            run_id=row["run_id"],
            source_ref=row["source_ref"],
            tags=json.loads(row["tags"] or "[]"),
            meta=json.loads(row["meta"] or "{}"),
            created_at=row["created_at"],
            superseded_by=row["superseded_by"],
            last_used_at=row["last_used_at"],
            uses=row["uses"],
            score=score,
        )

    def get(self, item_id: str) -> MemoryItem | None:
        row = self._conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        return self._row(row) if row else None

    def _filters(
        self,
        kinds: Iterable[str] | None,
        run_id: str | None,
        include_superseded: bool,
        scopes: Iterable[str] | None,
    ) -> tuple[str, list[Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if kinds:
            kinds = list(kinds)
            clauses.append(f"i.kind IN ({','.join('?' * len(kinds))})")
            params.extend(kinds)
        if scopes:
            scopes = list(scopes)
            clauses.append(f"i.scope IN ({','.join('?' * len(scopes))})")
            params.extend(scopes)
        if run_id is not None:
            # Run-scoped items only from this run; project/global items always visible.
            clauses.append("(i.scope != 'run' OR i.run_id = ?)")
            params.append(run_id)
        if not include_superseded:
            clauses.append("i.superseded_by IS NULL")
        return (" AND ".join(clauses) or "1=1"), params

    def list(
        self,
        *,
        kinds: Iterable[str] | None = None,
        run_id: str | None = None,
        scopes: Iterable[str] | None = None,
        include_superseded: bool = False,
    ) -> list[MemoryItem]:
        where, params = self._filters(kinds, run_id, include_superseded, scopes)
        rows = self._conn.execute(f"SELECT * FROM items i WHERE {where} ORDER BY i.created_at, i.id", params)
        return [self._row(row) for row in rows]

    def search(
        self,
        query: str,
        *,
        kinds: Iterable[str] | None = None,
        run_id: str | None = None,
        scopes: Iterable[str] | None = None,
        include_superseded: bool = False,
        limit: int = 10,
    ) -> list[MemoryItem]:
        match = fts_query(query)
        if not match:
            return []
        where, params = self._filters(kinds, run_id, include_superseded, scopes)
        sql = (
            "SELECT i.*, bm25(items_fts) AS rank FROM items_fts JOIN items i ON i.id = items_fts.id "
            f"WHERE items_fts MATCH ? AND {where} ORDER BY rank LIMIT ?"
        )
        rows = self._conn.execute(sql, [match, *params, limit])
        # SQLite's bm25() is lower-is-better; flip the sign so higher means more relevant.
        return [self._row(row, score=-float(row["rank"])) for row in rows]

    def history(self, item_id: str) -> list[MemoryItem]:
        """The supersession chain that ends at or passes through ``item_id``."""
        chain: list[MemoryItem] = []
        rows = self._conn.execute("SELECT * FROM items WHERE superseded_by=?", (item_id,)).fetchall()
        if rows:
            chain.extend(self.history(rows[0]["id"]))
        item = self.get(item_id)
        if item:
            chain.append(item)
        return chain
