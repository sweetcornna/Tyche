"""Clients for arXiv, Semantic Scholar, OpenAlex, and Crossref.

Each client turns API responses into :class:`Paper` records. Nothing here asks
a language model for bibliographic facts: titles, authors, years, and
identifiers come only from these services.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from typing import Any

from tyche.literature.http import HttpClient, HttpError
from tyche.literature.models import Paper
from tyche.textutil import sanitize_untrusted

_ATOM = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
_ARXIV_ID = re.compile(r"(?:arxiv\.org/(?:abs|pdf)/)?(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?", re.I)


def normalize_arxiv_id(raw: str) -> str:
    match = _ARXIV_ID.search(raw or "")
    return match.group(1) if match else ""


def _xml_ok(body: str) -> None:
    try:
        ET.fromstring(body)
    except ET.ParseError as exc:
        raise ValueError(f"unparseable Atom feed: {exc}") from exc


def _json_ok(body: str) -> None:
    value = json.loads(body)  # JSONDecodeError is a ValueError
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")


def _year(value: Any) -> int | None:
    try:
        year = int(str(value)[:4])
    except (TypeError, ValueError):
        return None
    return year if 1900 <= year <= 2100 else None


class ArxivClient:
    name = "arxiv"
    base = "https://export.arxiv.org/api/query"

    def __init__(self, http: HttpClient):
        self.http = http

    @staticmethod
    def parse(feed: str, query: str = "") -> list[Paper]:
        try:
            root = ET.fromstring(feed)
        except ET.ParseError as exc:
            raise ValueError(f"unparseable Atom feed: {exc}") from exc
        papers = []
        for entry in root.findall("a:entry", _ATOM):
            title = sanitize_untrusted(entry.findtext("a:title", default="", namespaces=_ATOM))
            ident = entry.findtext("a:id", default="", namespaces=_ATOM)
            if not title or "arxiv.org" not in ident:
                continue
            doi = entry.findtext("arxiv:doi", default="", namespaces=_ATOM) or ""
            venue = entry.findtext("arxiv:journal_ref", default="", namespaces=_ATOM) or ""
            papers.append(
                Paper(
                    title=title,
                    authors=[
                        sanitize_untrusted(a.findtext("a:name", default="", namespaces=_ATOM))
                        for a in entry.findall("a:author", _ATOM)
                    ],
                    year=_year(entry.findtext("a:published", default="", namespaces=_ATOM)),
                    venue=sanitize_untrusted(venue),
                    abstract=sanitize_untrusted(entry.findtext("a:summary", default="", namespaces=_ATOM)),
                    arxiv_id=normalize_arxiv_id(ident),
                    doi=doi.strip().lower(),
                    url=f"https://arxiv.org/abs/{normalize_arxiv_id(ident)}",
                    sources=["arxiv"],
                    queries=[query] if query else [],
                )
            )
        return papers

    async def search(self, query: str, limit: int) -> list[Paper]:
        terms = " AND ".join(f"all:{word}" for word in re.findall(r"[A-Za-z0-9\-]+", query)[:8])
        feed = await self.http.get_text(
            self.base,
            {"search_query": terms or f"all:{query}", "start": 0, "max_results": limit, "sortBy": "relevance"},
            validate=_xml_ok,
        )
        return self.parse(feed, query)

    async def by_ids(self, ids: list[str]) -> list[Paper]:
        ids = [normalize_arxiv_id(i) for i in ids if normalize_arxiv_id(i)]
        if not ids:
            return []
        feed = await self.http.get_text(
            self.base, {"id_list": ",".join(ids), "max_results": len(ids)}, validate=_xml_ok
        )
        return self.parse(feed)


_S2_FIELDS = "title,authors,year,venue,abstract,externalIds,citationCount,url"


class SemanticScholarClient:
    name = "semantic_scholar"
    base = "https://api.semanticscholar.org/graph/v1"

    def __init__(self, http: HttpClient, api_key: str = ""):
        self.http = http
        self.headers = {"x-api-key": api_key} if api_key else None

    @staticmethod
    def to_paper(item: dict[str, Any], query: str = "") -> Paper | None:
        if not item or not item.get("title"):
            return None
        ext = item.get("externalIds") or {}
        doi = str(ext.get("DOI") or "").lower()
        arxiv = normalize_arxiv_id(ext.get("ArXiv", ""))
        if not arxiv and doi.startswith("10.48550/arxiv."):
            arxiv = doi.split("arxiv.", 1)[1]
        return Paper(
            title=sanitize_untrusted(item["title"]),
            authors=[sanitize_untrusted(a.get("name", "")) for a in item.get("authors") or [] if a.get("name")],
            year=_year(item.get("year")),
            venue=sanitize_untrusted(item.get("venue") or ""),
            abstract=sanitize_untrusted(item.get("abstract") or ""),
            arxiv_id=arxiv,
            doi=doi,
            s2_id=str(item.get("paperId") or ""),
            url=item.get("url") or "",
            citation_count=item.get("citationCount"),
            sources=["semantic_scholar"],
            queries=[query] if query else [],
        )

    async def search(self, query: str, limit: int) -> list[Paper]:
        body = await self.http.get_text(
            f"{self.base}/paper/search", {"query": query, "limit": limit, "fields": _S2_FIELDS}, self.headers,
            validate=_json_ok,
        )
        data = json.loads(body).get("data") or []
        return [p for p in (self.to_paper(item, query) for item in data) if p]

    async def lookup(self, identifier: str) -> Paper | None:
        """identifier: ``arXiv:<id>``, ``DOI:<doi>``, or an S2 paper id."""
        try:
            body = await self.http.get_text(
                f"{self.base}/paper/{identifier}", {"fields": _S2_FIELDS}, self.headers, validate=_json_ok
            )
        except HttpError as exc:
            if exc.status == 404:
                return None
            raise
        return self.to_paper(json.loads(body))

    async def neighbours(self, s2_id: str, direction: str, limit: int) -> list[Paper]:
        """One hop along the citation graph: direction is 'references' or 'citations'."""
        key = "citedPaper" if direction == "references" else "citingPaper"
        body = await self.http.get_text(
            f"{self.base}/paper/{s2_id}/{direction}", {"fields": _S2_FIELDS, "limit": limit}, self.headers,
            validate=_json_ok,
        )
        data = json.loads(body).get("data") or []
        return [p for p in (self.to_paper(item.get(key) or {}) for item in data) if p]


class OpenAlexClient:
    name = "openalex"
    base = "https://api.openalex.org"

    def __init__(self, http: HttpClient, mailto: str = "", api_key: str = ""):
        self.http = http
        self.mailto = mailto
        self.api_key = api_key

    @staticmethod
    def rebuild_abstract(index: dict[str, list[int]] | None) -> str:
        if not index:
            return ""
        slots: dict[int, str] = {}
        for word, positions in index.items():
            for pos in positions:
                slots[pos] = word
        return " ".join(slots[i] for i in sorted(slots))

    @classmethod
    def to_paper(cls, item: dict[str, Any], query: str = "") -> Paper | None:
        title = item.get("display_name") or item.get("title")
        if not title:
            return None
        ids = item.get("ids") or {}
        doi = str(item.get("doi") or ids.get("doi") or "").lower().replace("https://doi.org/", "")
        arxiv = ""
        for loc in item.get("locations") or []:
            landing = (loc or {}).get("landing_page_url") or ""
            if "arxiv.org" in landing:
                arxiv = normalize_arxiv_id(landing)
                break
        if not arxiv and doi.startswith("10.48550/arxiv."):
            arxiv = doi.split("arxiv.", 1)[1]
        venue = ((item.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
        return Paper(
            title=sanitize_untrusted(title),
            authors=[
                sanitize_untrusted(((a or {}).get("author") or {}).get("display_name", ""))
                for a in item.get("authorships") or []
            ],
            year=_year(item.get("publication_year")),
            venue=sanitize_untrusted(venue),
            abstract=sanitize_untrusted(cls.rebuild_abstract(item.get("abstract_inverted_index"))),
            arxiv_id=arxiv,
            doi=doi,
            openalex_id=str(item.get("id") or ""),
            url=str(item.get("id") or ""),
            citation_count=item.get("cited_by_count"),
            sources=["openalex"],
            queries=[query] if query else [],
        )

    async def search(self, query: str, limit: int) -> list[Paper]:
        params: dict[str, Any] = {"search": query, "per-page": limit}
        if self.mailto:
            params["mailto"] = self.mailto
        # The key rides in the query string (OpenAlex accepts no header) but is kept out of
        # cache keys and error messages.
        body = await self.http.get_text(
            f"{self.base}/works", params, validate=_json_ok, secret_params={"api_key": self.api_key}
        )
        return [p for p in (self.to_paper(item, query) for item in json.loads(body).get("results") or []) if p]


class CrossrefClient:
    name = "crossref"
    base = "https://api.crossref.org"

    def __init__(self, http: HttpClient, mailto: str = ""):
        self.http = http
        self.mailto = mailto

    @staticmethod
    def to_paper(item: dict[str, Any]) -> Paper | None:
        titles = item.get("title") or []
        if not titles:
            return None
        year = None
        for key in ("published-print", "published-online", "issued", "created"):
            parts = ((item.get(key) or {}).get("date-parts") or [[None]])[0]
            if parts and parts[0]:
                year = _year(parts[0])
                break
        authors = []
        for author in item.get("author") or []:
            name = " ".join(x for x in (author.get("given"), author.get("family")) if x)
            if name:
                authors.append(sanitize_untrusted(name))
        venue = (item.get("container-title") or [""])[0]
        subtitle = (item.get("subtitle") or [""])[0]
        title = titles[0] + (f": {subtitle}" if subtitle and subtitle.lower() not in titles[0].lower() else "")
        return Paper(
            title=sanitize_untrusted(title),
            authors=authors,
            year=year,
            venue=sanitize_untrusted(venue),
            doi=str(item.get("DOI") or "").lower(),
            url=item.get("URL") or "",
            sources=["crossref"],
        )

    async def by_doi(self, doi: str) -> Paper | None:
        params = {"mailto": self.mailto} if self.mailto else None
        try:
            body = await self.http.get_text(f"{self.base}/works/{doi}", params, validate=_json_ok)
        except HttpError as exc:
            if exc.status == 404:
                return None
            raise
        return self.to_paper(json.loads(body).get("message") or {})
