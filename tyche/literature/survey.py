"""Stage S1: literature survey grounded in scholarly APIs.

Flow: query plan -> multi-source retrieval -> dedupe -> lexical pre-rank ->
LLM screening on abstracts -> one-hop citation-graph expansion -> verification
-> evidence cards (each claim must quote its abstract verbatim) -> themes.

The model never supplies bibliographic facts. It only chooses queries, judges
relevance, and summarizes text that was actually retrieved.
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, Field

from tyche.literature.bibtex import assign_keys, bibliography
from tyche.literature.http import HttpError
from tyche.literature.models import Paper, dedupe
from tyche.literature.sources import SemanticScholarClient
from tyche.literature.verify import Verifier
from tyche.llm import LLMClient, complete_json
from tyche.memory import MemoryStore
from tyche.planning import ResearchPlan
from tyche.prompts import load_prompt
from tyche.textutil import sanitize_untrusted
from tyche.workspace import StageError


class SearchClient(Protocol):
    name: str

    async def search(self, query: str, limit: int) -> list[Paper]: ...


class QueryPlan(BaseModel):
    queries: list[str] = Field(min_length=3, max_length=12)


class ScreenDecision(BaseModel):
    id: str
    relevance: int = Field(ge=0, le=3)
    role: str = Field(description="baseline | mechanism | benchmark | analysis | background")
    reason: str


class ScreenResult(BaseModel):
    decisions: list[ScreenDecision]


class EvidenceCard(BaseModel):
    id: str
    claim: str
    quote: str


class EvidenceResult(BaseModel):
    cards: list[EvidenceCard]


class Theme(BaseModel):
    name: str
    summary: str
    paper_ids: list[str] = Field(min_length=1)


class Synthesis(BaseModel):
    short_summary: str
    key_findings: list[str] = Field(min_length=2, max_length=8)
    open_problems: list[str] = Field(min_length=1, max_length=6)
    themes: list[Theme] = Field(min_length=2, max_length=4)
    gap: str = Field(description="The specific gap the planned paper addresses.")


@dataclass
class SurveyResult:
    papers: dict[str, Paper]
    roles: dict[str, str]
    relevance: dict[str, int]
    excluded: list[dict[str, Any]]
    cards: list[dict[str, Any]]
    synthesis: Synthesis
    candidate_pool: list[Paper]
    stats: dict[str, Any] = field(default_factory=dict)


_WORD = re.compile(r"[a-z0-9][a-z0-9\-]+")


def _terms(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if len(w) > 2]


def prerank(pool: list[Paper], query_text: str) -> list[tuple[float, Paper]]:
    """BM25 over title+abstract against the plan text, plus mild citation and recency priors."""
    docs = [_terms(f"{p.title} {p.title} {p.abstract}") for p in pool]
    n = len(docs) or 1
    avgdl = sum(len(d) for d in docs) / n or 1.0
    df = Counter()
    for doc in docs:
        df.update(set(doc))
    q = set(_terms(query_text))
    scored = []
    for paper, doc in zip(pool, docs):
        tf = Counter(doc)
        score = 0.0
        for term in q:
            if term not in tf:
                continue
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            freq = tf[term]
            score += idf * freq * 2.2 / (freq + 1.2 * (0.25 + 0.75 * len(doc) / avgdl))
        score += 0.4 * math.log1p(paper.citation_count or 0)
        if paper.year and paper.year >= 2022:
            score += 0.5
        if not paper.abstract:
            score *= 0.5
        scored.append((score, paper))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored


def _card_quote_ok(quote: str, abstract: str) -> bool:
    norm = lambda s: re.sub(r"\s+", " ", s).strip().lower()  # noqa: E731
    q = norm(quote)
    return len(q) >= 20 and q in norm(abstract)


def _candidates_block(items: list[tuple[str, Paper]], abstract_chars: int = 900) -> str:
    rows = []
    for pid, paper in items:
        rows.append(
            {
                "id": pid,
                "title": paper.title,
                "year": paper.year,
                "venue": paper.venue,
                "abstract": sanitize_untrusted(paper.abstract, abstract_chars),
            }
        )
    return json.dumps(rows, ensure_ascii=False, indent=1)


class Surveyor:
    def __init__(
        self,
        llm: LLMClient,
        *,
        searchers: list[SearchClient],
        verifier: Verifier,
        s2: SemanticScholarClient | None,
        memory: MemoryStore,
        run_id: str,
        settings: dict[str, Any],
        log=None,
    ):
        self.llm = llm
        self.searchers = searchers
        self.verifier = verifier
        self.s2 = s2
        self.memory = memory
        self.run_id = run_id
        self.cfg = settings
        self.log = log or (lambda *args, **kwargs: None)
        self.errors: list[str] = []

    async def _queries(self, plan: ResearchPlan, direction: dict[str, Any]) -> list[str]:
        user = (
            "<research_plan>\n" + plan.model_dump_json(indent=1) + "\n</research_plan>\n"
            "<seed_queries>\n" + json.dumps(direction.get("seed_queries", []), ensure_ascii=False) + "\n</seed_queries>"
        )
        result = await complete_json(
            self.llm, system=load_prompt("survey_queries"), user=user, schema=QueryPlan, purpose="survey:queries"
        )
        merged: list[str] = []
        for query in [*result.queries, *plan.search_queries, *direction.get("seed_queries", [])]:
            query = sanitize_untrusted(query, 160)
            if query and query.lower() not in {q.lower() for q in merged}:
                merged.append(query)
        return merged[: int(self.cfg.get("max_queries", 8))]

    async def _retrieve(self, queries: list[str]) -> list[Paper]:
        found: list[Paper] = []
        limit = int(self.cfg.get("per_query_results", 12))
        for query in queries:
            for searcher in self.searchers:
                try:
                    found.extend(await searcher.search(query, limit))
                except (HttpError, ValueError) as exc:
                    self.errors.append(f"{searcher.name}: {exc}")
                    self.log("survey.source_error", source=searcher.name, error=str(exc)[:300])
        return found

    async def _canonical(self, direction: dict[str, Any]) -> list[Paper]:
        papers = []
        for name in direction.get("canonical_works", []):
            try:
                paper = await self.verifier.resolve_title(name)
            except HttpError as exc:
                self.errors.append(f"canonical lookup {name!r}: {exc}")
                continue
            if paper is not None:
                paper.queries.append("canonical")
                papers.append(paper)
        return papers

    async def _screen(self, plan: ResearchPlan, candidates: list[Paper]) -> dict[int, ScreenDecision]:
        decisions: dict[int, ScreenDecision] = {}
        batch = 15
        for start in range(0, len(candidates), batch):
            chunk = list(enumerate(candidates[start : start + batch], start=start))
            items = [(f"C{idx:03d}", paper) for idx, paper in chunk]
            user = (
                "<research_plan>\n" + plan.model_dump_json(indent=1) + "\n</research_plan>\n"
                "<candidates>\n" + _candidates_block(items) + "\n</candidates>"
            )
            result = await complete_json(
                self.llm,
                system=load_prompt("survey_screen"),
                user=user,
                schema=ScreenResult,
                purpose="survey:screen",
            )
            valid = {pid: idx for (pid, _), (idx, _) in zip(items, chunk)}
            for decision in result.decisions:
                if decision.id in valid:
                    decisions[valid[decision.id]] = decision
        return decisions

    async def _expand(self, seeds: list[Paper], known: list[Paper]) -> list[Paper]:
        if self.s2 is None:
            return []
        per_seed = int(self.cfg.get("expansion_per_seed", 10))
        found: list[Paper] = []
        for seed in seeds:
            if not seed.s2_id:
                continue
            for direction in ("references", "citations"):
                try:
                    found.extend(await self.s2.neighbours(seed.s2_id, direction, per_seed))
                except HttpError as exc:
                    self.errors.append(f"expansion {seed.s2_id}/{direction}: {exc}")
        known_keys = {k for p in known for k in p.identity_keys()}
        fresh = [p for p in dedupe(found) if not set(p.identity_keys()) & known_keys]
        for paper in fresh:
            paper.queries.append("citation-graph")
        return fresh

    async def _cards(self, keyed: dict[str, Paper]) -> list[dict[str, Any]]:
        per_paper = int(self.cfg.get("evidence_cards_per_paper", 2))
        cards: list[dict[str, Any]] = []
        entries = [(key, p) for key, p in keyed.items() if p.abstract]
        for start in range(0, len(entries), 6):
            chunk = entries[start : start + 6]
            user = (
                f"<cards_per_paper>{per_paper}</cards_per_paper>\n"
                "<papers>\n" + _candidates_block(chunk, abstract_chars=2500) + "\n</papers>"
            )
            result = await complete_json(
                self.llm,
                system=load_prompt("survey_cards"),
                user=user,
                schema=EvidenceResult,
                purpose="survey:cards",
            )
            counts: Counter[str] = Counter()
            for card in result.cards:
                paper = keyed.get(card.id)
                if paper is None or counts[card.id] >= per_paper:
                    continue
                if not _card_quote_ok(card.quote, paper.abstract):
                    continue
                counts[card.id] += 1
                item_id = self.memory.add(
                    "evidence",
                    f"{sanitize_untrusted(card.claim, 400)} Quote: \"{sanitize_untrusted(card.quote, 500)}\"",
                    provenance="retrieved",
                    run_id=self.run_id,
                    title=paper.title,
                    source_ref=card.id,
                    tags=["survey"],
                )
                cards.append({"memory_id": item_id, "key": card.id, "claim": card.claim, "quote": card.quote})
        return cards

    async def _synthesize(
        self, plan: ResearchPlan, keyed: dict[str, Paper], roles: dict[str, str], cards: list[dict[str, Any]]
    ) -> Synthesis:
        listing = [
            {"id": key, "title": p.title, "year": p.year, "role": roles.get(key, "background")}
            for key, p in keyed.items()
        ]
        user = (
            "<research_plan>\n" + plan.model_dump_json(indent=1) + "\n</research_plan>\n"
            "<papers>\n" + json.dumps(listing, ensure_ascii=False, indent=1) + "\n</papers>\n"
            "<evidence_cards>\n" + json.dumps(cards, ensure_ascii=False, indent=1) + "\n</evidence_cards>"
        )
        result = await complete_json(
            self.llm, system=load_prompt("survey_synthesis"), user=user, schema=Synthesis, purpose="survey:synthesis"
        )
        for theme in result.themes:
            theme.paper_ids = [pid for pid in theme.paper_ids if pid in keyed]
        result.themes = [t for t in result.themes if t.paper_ids]
        if len(result.themes) < 1:
            raise StageError("survey synthesis produced no themes grounded in retrieved papers")
        return result

    async def run(self, plan: ResearchPlan, direction: dict[str, Any]) -> SurveyResult:
        queries = await self._queries(plan, direction)
        self.log("survey.queries", count=len(queries))
        pool = dedupe(await self._retrieve(queries) + await self._canonical(direction))
        if not pool:
            raise StageError(
                "literature retrieval returned nothing; check network access to arXiv/Semantic Scholar/OpenAlex. "
                "Errors: " + "; ".join(self.errors[:5])
            )
        plan_text = " ".join(
            [plan.working_title, plan.problem, plan.method_sketch, plan.task_description, *plan.keywords, *plan.baselines]
        )
        ranked = [p for _, p in prerank(pool, plan_text)]
        canonical = [p for p in pool if "canonical" in p.queries]
        head = ranked[: int(self.cfg.get("prerank_pool", 60))]
        head += [p for p in canonical if p not in head]
        decisions = await self._screen(plan, head)
        max_papers = int(self.cfg.get("max_papers", 24))
        min_papers = int(self.cfg.get("min_papers", 8))

        def pick(threshold: int, papers: list[Paper], decided: dict[int, ScreenDecision]) -> list[tuple[Paper, ScreenDecision]]:
            chosen = [(papers[i], d) for i, d in decided.items() if d.relevance >= threshold]
            chosen.sort(key=lambda pd: (-pd[1].relevance, papers.index(pd[0])))
            return chosen

        kept = pick(2, head, decisions)
        if len(kept) < min_papers:
            kept = pick(1, head, decisions)
        kept = kept[:max_papers]

        seeds = [p for p, _ in kept[: int(self.cfg.get("expansion_seeds", 5))]]
        fresh = await self._expand(seeds, pool)
        if fresh and len(kept) < max_papers:
            fresh_ranked = [p for _, p in prerank(fresh, plan_text)][:30]
            extra_decisions = await self._screen(plan, fresh_ranked)
            extra = pick(2, fresh_ranked, extra_decisions)
            kept += extra[: max_papers - len(kept)]
            pool += fresh

        papers = [p for p, _ in kept]
        verification = await self.verifier.verify(papers)
        excluded: list[dict[str, Any]] = []
        citable: list[tuple[Paper, ScreenDecision]] = []
        for paper, decision in kept:
            check = verification[paper.identity_keys()[0]]
            if check.citable:
                citable.append((paper, decision))
            else:
                excluded.append({"title": paper.title, "notes": check.notes})
        if len(citable) < min(min_papers, 3):
            raise StageError(
                f"only {len(citable)} verifiable papers survived screening; refusing to write a related-work "
                "section on too little evidence"
            )
        keyed = assign_keys([p for p, _ in citable])
        roles = {key: d.role for key, (p, d) in zip(keyed, citable)}
        relevance = {key: d.relevance for key, (p, d) in zip(keyed, citable)}
        for key, paper in keyed.items():
            self.memory.add(
                "evidence",
                f"{paper.title} ({paper.year}). {sanitize_untrusted(paper.abstract, 600)}",
                provenance="retrieved",
                run_id=self.run_id,
                title=paper.title,
                source_ref=key,
                tags=["abstract", roles[key]],
                meta={"verified_by": verification[paper.identity_keys()[0]].verified_by},
            )
        cards = await self._cards(keyed)
        synthesis = await self._synthesize(plan, keyed, roles, cards)
        stats = {
            "queries": queries,
            "retrieved": len(pool),
            "screened": len(head),
            "kept": len(keyed),
            "excluded": len(excluded),
            "evidence_cards": len(cards),
            "source_errors": self.errors[:20],
        }
        return SurveyResult(
            papers=keyed,
            roles=roles,
            relevance=relevance,
            excluded=excluded,
            cards=cards,
            synthesis=synthesis,
            candidate_pool=pool,
            stats=stats,
        )


def write_survey_outputs(result: SurveyResult, out_dir: Path) -> dict[str, Path]:
    """Write refs.bib, research_summary.md (auto_research-compatible), and the manifest."""
    out_dir.mkdir(parents=True, exist_ok=True)
    bib = out_dir / "refs.bib"
    bib.write_text(bibliography(result.papers), encoding="utf-8")
    syn = result.synthesis
    lines = ["# Research Summary", "", "## Short Summary", syn.short_summary, "", "## Key Findings"]
    lines += [f"- {item}" for item in syn.key_findings]
    lines += ["", "## Open Problems"] + [f"- {item}" for item in syn.open_problems]
    lines += ["", "## Research Gap", syn.gap, "", "## Related Work Themes"]
    for theme in syn.themes:
        lines += [f"### {theme.name}", theme.summary, "Papers: " + ", ".join(theme.paper_ids), ""]
    lines += ["## Sources"]
    for key, paper in result.papers.items():
        ident = f"arXiv:{paper.arxiv_id}" if paper.arxiv_id else (f"doi:{paper.doi}" if paper.doi else paper.url)
        lines.append(f"- [{key}] {paper.title} ({paper.year}). {ident}")
    summary = out_dir / "research_summary.md"
    summary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = out_dir / "source-manifest.json"
    manifest.write_text(
        json.dumps(
            {
                "papers": [
                    {
                        "key": key,
                        **paper.to_dict(),
                        "role": result.roles.get(key),
                        "relevance": result.relevance.get(key),
                    }
                    for key, paper in result.papers.items()
                ],
                "excluded": result.excluded,
                "evidence_cards": result.cards,
                "synthesis": result.synthesis.model_dump(),
                "stats": result.stats,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    pool = out_dir / "candidate-pool.json"
    pool.write_text(
        json.dumps([p.to_dict() for p in result.candidate_pool], ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    return {"bib": bib, "summary": summary, "manifest": manifest, "pool": pool}
