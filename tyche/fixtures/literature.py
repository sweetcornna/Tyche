"""Synthetic scholarly-API responses for the offline selftest and unit tests.

Every record here is fictional and marked as such (arXiv ids start with
``0000.``, authors are named "Fixture"/"Testcase"), so fixture output can
never be mistaken for, or cite, real literature.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import httpx

FIXTURE_PAPERS = [
    {
        "id": "0000.00001",
        "title": "Synthetic Fixture Study of Episodic Memory Ledgers for Language Agents",
        "authors": ["Ada Fixture", "Bo Testcase"],
        "year": 2024,
        "abstract": "We study episodic memory ledgers that let language agents record observations with provenance. "
        "Agents that keep superseded facts linked to their corrections answer questions about changing state "
        "more reliably than agents that overwrite memory.",
    },
    {
        "id": "0000.00002",
        "title": "Fixture Benchmark for Long-Horizon Conversational Memory in Agents",
        "authors": ["Cai Fixture", "Dana Testcase"],
        "year": 2024,
        "abstract": "We introduce a synthetic benchmark of multi-session conversations in which facts are introduced, "
        "updated, and retracted. Retrieval-based memory degrades when stale facts are not retired.",
    },
    {
        "id": "0000.00003",
        "title": "Sliding Window Context Management for Tool-Using Agents: A Fixture Analysis",
        "authors": ["Eve Fixture"],
        "year": 2023,
        "abstract": "Sliding window context policies keep only the most recent turns of an agent trajectory. "
        "They are cheap but forget early observations that later steps depend on.",
    },
    {
        "id": "0000.00004",
        "title": "Summarization-Based Memory Consolidation for Agents: Fixture Evidence",
        "authors": ["Finn Testcase", "Gus Fixture"],
        "year": 2023,
        "abstract": "Rolling summaries compress interaction history into short notes. "
        "Summaries reduce prompt tokens but can silently drop details that become relevant later.",
    },
    {
        "id": "0000.00005",
        "title": "Retrieval-Augmented Agent Memory with Relevance Budgets: A Synthetic Study",
        "authors": ["Hana Fixture", "Ivo Testcase"],
        "year": 2025,
        "abstract": "Retrieval-augmented memory selects past records by similarity under a token budget. "
        "Budget-aware retrieval trades recall against prompt length in predictable ways.",
    },
    {
        "id": "0000.00006",
        "title": "Full-Context Baselines for Agent Memory Evaluation: A Fixture Report",
        "authors": ["Jo Fixture"],
        "year": 2024,
        "abstract": "Keeping the full interaction history in context is a strong but expensive baseline for agent memory. "
        "Its cost grows linearly with the number of sessions.",
    },
    {
        "id": "0000.00007",
        "title": "Provenance Tracking for Knowledge Updates in Language Model Agents: Fixture Notes",
        "authors": ["Kai Testcase", "Lu Fixture"],
        "year": 2025,
        "abstract": "Knowledge updates are easier to audit when every stored claim carries its source and time. "
        "Provenance tags let an agent prefer the most recent valid statement about an entity.",
    },
    {
        "id": "0000.00008",
        "title": "Position Effects in Long Agent Contexts: A Synthetic Replication",
        "authors": ["Mo Fixture", "Nia Testcase"],
        "year": 2024,
        "abstract": "Models attend unevenly to information placed in the middle of long contexts. "
        "Agents that pack evidence near the question recover more of it.",
    },
]

EXPANSION_PAPERS = [
    {
        "id": "0000.00009",
        "title": "Forgetting Policies for Persistent Agent Memory: A Fixture Survey",
        "authors": ["Omar Fixture"],
        "year": 2025,
        "abstract": "Persistent agent memory needs explicit forgetting policies. "
        "Retiring contradicted records reduces stale answers without deleting the audit trail.",
    },
    {
        "id": "0000.00010",
        "title": "Token-Efficient Memory Retrieval for Conversational Agents: Fixture Results",
        "authors": ["Pia Testcase"],
        "year": 2025,
        "abstract": "Token-efficient retrieval keeps prompts short while preserving the facts needed to answer. "
        "Small retrieval budgets suffice when records are deduplicated.",
    },
]


def _atom(entries: list[dict]) -> str:
    parts = ['<?xml version="1.0" encoding="UTF-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom" '
             'xmlns:arxiv="http://arxiv.org/schemas/atom">']
    for p in entries:
        authors = "".join(f"<author><name>{a}</name></author>" for a in p["authors"])
        parts.append(
            f"<entry><id>http://arxiv.org/abs/{p['id']}v1</id><published>{p['year']}-03-01T00:00:00Z</published>"
            f"<title>{p['title']}</title><summary>{p['abstract']}</summary>{authors}</entry>"
        )
    parts.append("</feed>")
    return "".join(parts)


def _s2(p: dict, citations: int = 10) -> dict:
    return {
        "paperId": "s2fixture" + p["id"].replace(".", ""),
        "title": p["title"],
        "authors": [{"name": a} for a in p["authors"]],
        "year": p["year"],
        "venue": "",
        "abstract": p["abstract"],
        "externalIds": {"ArXiv": p["id"]},
        "citationCount": citations,
        "url": f"https://www.semanticscholar.org/paper/s2fixture{p['id']}",
    }


def _handler(request: httpx.Request) -> httpx.Response:
    url = urlsplit(str(request.url))
    query = parse_qs(url.query)
    host = url.hostname or ""
    if host == "export.arxiv.org":
        if "id_list" in query:
            wanted = set(query["id_list"][0].split(","))
            pool = FIXTURE_PAPERS + EXPANSION_PAPERS
            return httpx.Response(200, text=_atom([p for p in pool if p["id"] in wanted]))
        return httpx.Response(200, text=_atom(FIXTURE_PAPERS[:6]))
    if host == "api.semanticscholar.org":
        path = url.path
        if path.endswith("/paper/search"):
            data = [_s2(p, 20 - i) for i, p in enumerate(FIXTURE_PAPERS[3:])]
            return httpx.Response(200, text=json.dumps({"data": data}))
        if path.endswith("/references"):
            return httpx.Response(200, text=json.dumps({"data": [{"citedPaper": _s2(EXPANSION_PAPERS[0], 5)}]}))
        if path.endswith("/citations"):
            return httpx.Response(200, text=json.dumps({"data": [{"citingPaper": _s2(EXPANSION_PAPERS[1], 3)}]}))
        return httpx.Response(404, text="{}")
    if host == "api.openalex.org":
        results = []
        for p in FIXTURE_PAPERS[:2]:
            results.append(
                {
                    "id": "https://openalex.org/Wfixture" + p["id"].replace(".", ""),
                    "display_name": p["title"],
                    "publication_year": p["year"],
                    "authorships": [{"author": {"display_name": a}} for a in p["authors"]],
                    "abstract_inverted_index": {w: [i] for i, w in enumerate(p["abstract"].split())},
                    "locations": [{"landing_page_url": f"https://arxiv.org/abs/{p['id']}"}],
                    "cited_by_count": 4,
                }
            )
        return httpx.Response(200, text=json.dumps({"results": results}))
    return httpx.Response(404, text="{}")


def mock_transport() -> httpx.MockTransport:
    return httpx.MockTransport(_handler)
