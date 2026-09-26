"""Literature retrieval, verification, and BibTeX generation."""

from pathlib import Path
from typing import Any

from tyche.literature.http import HttpClient
from tyche.literature.models import Paper, dedupe
from tyche.literature.sources import ArxivClient, CrossrefClient, OpenAlexClient, SemanticScholarClient
from tyche.literature.verify import Verifier


def build_clients(settings: dict[str, Any], cache_path: Path | None, env: dict[str, str], transport=None):
    """Construct the HTTP client, search clients, and verifier from configuration."""
    http = HttpClient(
        cache_path=cache_path,
        cache_ttl_days=float(settings.get("cache_ttl_days", 30)),
        timeout=float(settings.get("request_timeout", 30)),
        min_interval=dict(settings.get("min_interval_seconds") or {}),
        contact_email=str(settings.get("contact_email") or ""),
        transport=transport,
    )
    enabled = set(settings.get("sources") or ["arxiv", "semantic_scholar", "openalex"])
    s2_key = env.get(str(settings.get("semantic_scholar_api_key_env") or "S2_API_KEY"), "")
    arxiv = ArxivClient(http)
    s2 = SemanticScholarClient(http, s2_key)
    openalex_key = env.get(str(settings.get("openalex_api_key_env") or "OPENALEX_API_KEY"), "")
    openalex = OpenAlexClient(http, str(settings.get("contact_email") or ""), openalex_key)
    crossref = CrossrefClient(http, str(settings.get("contact_email") or ""))
    searchers = []
    if "arxiv" in enabled:
        searchers.append(arxiv)
    if "semantic_scholar" in enabled:
        searchers.append(s2)
    if "openalex" in enabled:
        searchers.append(openalex)
    verifier = Verifier(arxiv=arxiv, crossref=crossref, s2=s2 if "semantic_scholar" in enabled else None)
    return http, searchers, verifier, (s2 if "semantic_scholar" in enabled else None)


__all__ = [
    "ArxivClient",
    "CrossrefClient",
    "HttpClient",
    "OpenAlexClient",
    "Paper",
    "SemanticScholarClient",
    "Verifier",
    "build_clients",
    "dedupe",
]
