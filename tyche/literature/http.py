"""Polite, cached HTTP access for public scholarly APIs.

* One minimum interval per host (arXiv asks for about 3 seconds).
* Retries with exponential backoff on 429 and 5xx responses.
* An SQLite response cache keyed by URL, so reruns and resumes do not hammer
  the APIs and a completed survey can be replayed offline.
* An injectable ``httpx`` transport, which tests use to serve fixtures.
"""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx

from tyche import __version__


class HttpError(RuntimeError):
    def __init__(self, url: str, status: int | None, detail: str):
        super().__init__(f"{url}: {status or 'no response'} {detail}")
        self.url = url
        self.status = status


class ResponseCache:
    def __init__(self, path: Path | None, ttl_days: float):
        self.ttl = ttl_days * 86400
        self._conn = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._conn = sqlite3.connect(str(path))
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, url TEXT, body TEXT, fetched REAL)"
            )
            self._conn.commit()

    @staticmethod
    def key(url: str) -> str:
        return hashlib.sha256(url.encode("utf-8")).hexdigest()

    def get(self, url: str) -> str | None:
        if self._conn is None:
            return None
        row = self._conn.execute(
            "SELECT body, fetched FROM responses WHERE key=?", (self.key(url),)
        ).fetchone()
        if row and (time.time() - row[1]) <= self.ttl:
            return row[0]
        return None

    def put(self, url: str, body: str) -> None:
        if self._conn is None:
            return
        with self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO responses (key, url, body, fetched) VALUES (?,?,?,?)",
                (self.key(url), url, body, time.time()),
            )


class HttpClient:
    def __init__(
        self,
        *,
        cache_path: Path | None = None,
        cache_ttl_days: float = 30,
        timeout: float = 30,
        min_interval: dict[str, float] | None = None,
        contact_email: str = "",
        transport: httpx.AsyncBaseTransport | None = None,
        max_retries: int = 3,
    ):
        agent = f"Tyche/{__version__} (research agent; +https://github.com/sweetcornna/Tyche"
        agent += f"; mailto:{contact_email})" if contact_email else ")"
        self._client = httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": agent},
            follow_redirects=True,
            transport=transport,
        )
        self.cache = ResponseCache(cache_path, cache_ttl_days)
        self.min_interval = dict(min_interval or {})
        self.max_retries = max_retries
        self._last: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self.requests_made = 0
        self.cache_hits = 0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _throttle(self, host: str) -> None:
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            wait = self.min_interval.get(host, 0.0) - (time.monotonic() - self._last.get(host, 0.0))
            if wait > 0:
                await asyncio.sleep(wait)
            self._last[host] = time.monotonic()

    async def get_text(self, url: str, params: dict[str, Any] | None = None, headers: dict[str, str] | None = None) -> str:
        full = url + ("?" + urlencode(params, doseq=True) if params else "")
        cached = self.cache.get(full)
        if cached is not None:
            self.cache_hits += 1
            return cached
        host = urlsplit(full).hostname or ""
        delay = 1.5
        last_detail = ""
        for attempt in range(self.max_retries + 1):
            await self._throttle(host)
            try:
                response = await self._client.get(full, headers=headers)
            except httpx.HTTPError as exc:
                last_detail = f"{type(exc).__name__}: {exc}"
                status = None
            else:
                self.requests_made += 1
                status = response.status_code
                if status == 200:
                    body = response.text
                    self.cache.put(full, body)
                    return body
                if status == 404:
                    raise HttpError(full, status, "not found")
                last_detail = response.text[:200]
                if status not in (429, 500, 502, 503, 504):
                    raise HttpError(full, status, last_detail)
            if attempt < self.max_retries:
                await asyncio.sleep(delay)
                delay *= 2
        raise HttpError(full, None, f"gave up after retries: {last_detail}")
