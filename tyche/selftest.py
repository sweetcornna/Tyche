"""Offline end-to-end selftest.

Runs every Tyche stage -- plan, survey, experiments, analysis, write, review,
evolve, package -- without network access or an API key:

* language-model calls are answered by deterministic handlers that read the
  same prompts a real model would see (so prompt plumbing is exercised);
* scholarly APIs are served by a mock transport with fictional records;
* experiments come from the packaged synthetic metrics fixture.

The LaTeX toolchain is real: the selftest produces a compiled ICLR 2027 PDF
and requires every deterministic gate to pass. Its output is clearly marked
as a synthetic fixture and is not a research result.
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from tyche.config import TycheConfig, load_direction
from tyche.experiments import fixture_engine
from tyche.fixtures.literature import mock_transport
from tyche.literature import build_clients
from tyche.llm import ScriptedLLM, UsageMeter
from tyche.memory import MemoryStore
from tyche.pipeline import Pipeline, Services
from tyche.workspace import Workspace


def _block(text: str, name: str) -> str:
    match = re.search(rf"<{name}>\n(.*?)\n</{name}>", text, re.S)
    return match.group(1) if match else ""


_SECTION_IN_TURN = re.compile(r"(?:Write|Revise|Shorten|The) the ([a-z ]+?) section")


def _current_section(user: str, history: list[dict[str, str]]) -> str:
    """The section text a turn works on: sent in the turn, or the latest version in the conversation."""
    sent = _block(user, "current_section")
    if sent:
        return sent
    match = _SECTION_IN_TURN.search(user)
    if not match:
        return ""
    name = match.group(1)
    for i in range(len(history) - 1, 0, -1):
        turn, before = history[i], history[i - 1]
        if turn["role"] == "assistant" and f"the {name} section" in before["content"]:
            found = re.search(r"<latex>\n?(.*?)\n?</latex>", turn["content"], re.S)
            if found:
                return found.group(1)
    return ""


def _json_block(text: str, name: str) -> Any:
    raw = _block(text, name)
    try:
        return json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return None


PLAN = {
    "working_title": "Provenance-Tagged Memory Ledgers for LLM Agents (Selftest Fixture)",
    "problem": "Agents that overwrite memory answer questions about changing facts with stale information.",
    "motivation": "Long-running assistants must track facts that change across sessions.",
    "research_questions": ["Does keeping superseded facts linked to corrections reduce stale answers?"],
    "hypotheses": [
        {
            "statement": "A provenance-tagged ledger answers change-sensitive questions more accurately than a sliding window.",
            "prediction": "Higher accuracy than sliding_window at comparable prompt tokens.",
        }
    ],
    "method_name": "LedgerMem",
    "method_sketch": "Store each observation with its source and time; link corrections to the facts they supersede; "
    "retrieve only the latest valid record per entity under a token budget.",
    "baselines": ["full_context", "sliding_window"],
    "experiment_family": "evolving_fact_stream",
    "task_description": "Synthetic stream of sessions that introduce, update, and retract entity facts.",
    "metrics": ["accuracy", "prompt_tokens_per_query"],
    "contributions": [
        "A memory design that links corrections to superseded facts.",
        "A controlled comparison against full-context and sliding-window memory.",
    ],
    "scope_limits": ["Synthetic fixture data only."],
    "keywords": ["agent memory", "provenance", "knowledge update"],
    "search_queries": ["agent memory provenance", "long horizon conversational memory", "memory consolidation agents"],
}

WORDS = {
    "intro": (
        "Language agents increasingly operate over many sessions, and the facts they rely on change while they work. "
        "A user moves, a project deadline shifts, a tool returns a corrected value. Memory designs that overwrite "
        "records or truncate history lose the link between a fact and its correction, and the agent then answers "
        "with whatever version it happened to keep. "
    ),
    "filler": (
        "This selftest paragraph exists to exercise the pipeline end to end; it describes a fictional study built "
        "from a synthetic fixture and makes no claim about real systems. "
    ),
}


def _results(brief: str) -> dict[str, str]:
    out: dict[str, str] = {}
    m = re.search(r"- proposed: ([0-9.,]+) \(95% CI ([0-9.,]+) to ([0-9.,]+), n = (\d+)\)", brief)
    if m:
        out.update(acc=m.group(1), lo=m.group(2), hi=m.group(3), n=m.group(4))
    m = re.search(r"accuracy vs (\w+): diff ([0-9.\-]+) \(95% CI ([0-9.\-]+) to ([0-9.\-]+)\), p = ([0-9.]+)", brief)
    if m:
        out.update(base=m.group(1), diff=m.group(2), dlo=m.group(3), dhi=m.group(4), p=m.group(5))
    return out


def _section(name: str, user: str) -> str:
    cites = [c["key"] for c in (_json_block(user, "allowed_citations") or [])]
    r = _results(_block(user, "results_brief"))
    cite = lambda i: f"\\citep{{{cites[i % len(cites)]}}}" if cites else ""  # noqa: E731
    if name == "abstract":
        return (
            "Agents that overwrite memory answer questions about changing facts with stale information. We describe "
            "LedgerMem, a memory design that keeps each fact with its source and links corrections to the facts they "
            "supersede, and we evaluate it on a synthetic stream of sessions in this selftest fixture. LedgerMem "
            f"reaches an accuracy of {r.get('acc', '')} (95\\% CI {r.get('lo', '')} to {r.get('hi', '')}) while "
            "using fewer prompt tokens than keeping the full history. The fixture is synthetic, so the result "
            "only demonstrates the reporting pipeline and supports no claim about real agents. " + WORDS["filler"]
        )
    if name == "introduction":
        return (
            WORDS["intro"] + f"Prior work stores episodic records {cite(0)} or compresses history into summaries "
            f"{cite(3)}, and benchmarks show that stale facts hurt retrieval-based memory {cite(1)}. " + WORDS["filler"]
            + WORDS["intro"] + "We ask whether an explicit supersession link is enough to fix this failure. "
            + WORDS["filler"] * 2
            + "\n\n\\begin{itemize}\n\\item A memory design, LedgerMem, that links corrections to superseded facts.\n"
            "\\item A controlled comparison against full-context and sliding-window memory with paired statistics.\n"
            "\\end{itemize}\n"
        )
    if name == "related_work":
        text = "\\paragraph{Episodic and summary memory.} "
        text += " ".join(f"One line of work studies memory records {cite(i)}." for i in range(0, 3))
        text += " These designs keep records but do not link a fact to its correction. " + WORDS["filler"]
        text += "\n\n\\paragraph{Context management and retrieval.} "
        text += " ".join(f"Another line manages what enters the context {cite(i)}." for i in range(3, 7))
        text += " None of them treats supersession as a first-class relation. " + WORDS["filler"] * 2
        return text
    if name == "method":
        return (
            "\\paragraph{Setup.} An agent observes a stream of sessions; each session asserts, updates, or retracts "
            "facts about entities, and queries arrive at any time. " + WORDS["filler"]
            + "\n\n\\paragraph{Ledger.} LedgerMem stores every observation as a record $r = (e, a, v, s, t)$ with "
            "entity $e$, attribute $a$, value $v$, source $s$, and time $t$. A correction creates a new record and a "
            "supersession edge from the old record. At query time the retriever returns, for each entity and "
            "attribute, the latest record that has not been superseded:\n"
            "\\begin{equation}\n\\hat{v}(e,a) = v_{r^*}, \\quad r^* = \\arg\\max_{r:\\, e_r=e,\\, a_r=a,\\, "
            "r \\notin S} t_r .\n\\end{equation}\n" + WORDS["filler"] * 3
            + "Records are packed into the prompt in order of relevance until the token budget is spent. "
            + WORDS["filler"] * 2
        )
    if name == "experiments":
        text = (
            "\\paragraph{Protocol.} We compare LedgerMem with a full-context baseline, which keeps the entire history, "
            "and a sliding-window baseline, which keeps only recent turns. Each variant answers the same synthetic "
            "questions; we report accuracy and prompt tokens per query. " + WORDS["filler"] * 2
        )
        text += (
            f"\n\n\\paragraph{{Results.}} Table~\\ref{{tab:main}} and Figure~\\ref{{fig:results}} summarize the fixture. "
            f"LedgerMem reaches {r.get('acc', '')} accuracy (95\\% CI {r.get('lo', '')} to {r.get('hi', '')}, "
            f"n = {r.get('n', '')}). "
        )
        if "diff" in r:
            text += (
                f"Against {r['base'].replace('_', ' ')}, the paired difference is {r['diff']} (95\\% CI {r['dlo']} to "
                f"{r['dhi']}, $p = {r['p']}$), reported in Table~\\ref{{tab:paired}}. "
            )
        return text + WORDS["filler"] * 2
    if name == "analysis":
        return (
            "The gains concentrate on questions whose answer changed during the stream, which is where supersession "
            "links matter. " + WORDS["filler"] * 2
            + "\n\n\\paragraph{Limitations.} The data are a synthetic fixture, the task is narrow, and no real model "
            "was queried; the numbers demonstrate the reporting pipeline only. " + WORDS["filler"]
        )
    if name == "conclusion":
        return (
            "LedgerMem links corrections to the facts they supersede. On the selftest fixture it answers "
            "change-sensitive questions with fewer prompt tokens than keeping the full history. " + WORDS["filler"]
        )
    return WORDS["filler"]


def _latex(body: str, responses: list[dict[str, Any]] | None = None) -> str:
    out = f"<latex>\n{body}\n</latex>"
    if responses is not None:
        out += "\n<responses>" + json.dumps(responses) + "</responses>"
    return out


def handlers() -> dict[str, Any]:
    state = {"reviews": 0}

    def plan(system: str, user: str) -> str:
        return json.dumps(PLAN)

    def queries(system: str, user: str) -> str:
        return json.dumps({"queries": ["agent memory ledger", "conversational memory benchmark", "context management agents"]})

    def screen(system: str, user: str) -> str:
        items = _json_block(user, "candidates") or []
        return json.dumps(
            {"decisions": [{"id": c["id"], "relevance": 3, "role": "mechanism", "reason": "fixture"} for c in items]}
        )

    def cards(system: str, user: str) -> str:
        papers = _json_block(user, "papers") or []
        out = []
        for p in papers:
            sentence = p["abstract"].split(". ")[0]
            out.append({"id": p["id"], "claim": f"The work reports: {sentence.lower()}.", "quote": sentence})
        return json.dumps({"cards": out})

    def synthesis(system: str, user: str) -> str:
        ids = [p["id"] for p in (_json_block(user, "papers") or [])]
        half = max(1, len(ids) // 2)
        return json.dumps(
            {
                "short_summary": "Fixture literature covers memory records, summaries, retrieval, and context policies.",
                "key_findings": ["Overwriting memory loses corrections.", "Summaries drop details."],
                "open_problems": ["Linking corrections to superseded facts."],
                "themes": [
                    {"name": "Episodic and summary memory", "summary": "Records and summaries.", "paper_ids": ids[:half]},
                    {"name": "Context management", "summary": "What enters the context.", "paper_ids": ids[half:] or ids[:1]},
                ],
                "gap": "No fixture paper treats supersession as a first-class relation.",
            }
        )

    def write(system: str, user: str) -> str:
        # Shared context (citations, results brief) is in the system prompt; the contract is in the user message.
        name = json.loads(_block(user, "section_contract"))["section"]
        return _latex(_section(name, system + "\n" + user))

    def title(system: str, user: str) -> str:
        return "Selftest Fixture: Provenance-Tagged Memory Ledgers for LLM Agents"

    def revise(system: str, user: str, history: list[dict[str, str]]) -> str:
        current = _current_section(user, history)
        findings = _json_block(user, "findings_to_address") or []
        addition = " We state explicitly that this pattern is descriptive and was not tested separately."
        responses = [{"id": f["id"], "action": "fixed", "note": "narrowed the claim"} for f in findings]
        return _latex(current.rstrip() + addition, responses)

    def passthrough(system: str, user: str, history: list[dict[str, str]]) -> str:
        return _latex(_current_section(user, history))

    def review(system: str, user: str) -> str:
        state["reviews"] += 1
        # The paper and prior findings are in the shared system prompt; the persona lens is in the user message.
        prior = _json_block(system, "prior_findings") or []
        bump = 1 if prior else 0
        scores = {d: 5 + bump for d in (
            "originality", "importance", "claims_supported", "experimental_soundness", "clarity",
            "community_value", "contextualization")}
        findings = []
        if not prior and "empirical rigor" in user:
            findings.append(
                {
                    "section": "analysis",
                    "severity": "major",
                    "dimension": "claims_supported",
                    "quote": "The gains concentrate on questions whose answer changed",
                    "problem": "The mechanism explanation is asserted without a targeted analysis.",
                    "fix": "Mark the explanation as descriptive or narrow it.",
                    "close_criterion": "The text no longer presents the explanation as tested.",
                }
            )
        return json.dumps(
            {
                "scores": scores,
                "overall": 5 + bump,
                "confidence": 3,
                "summary": "Selftest review of a synthetic fixture paper.",
                "strengths": ["Complete pipeline output."],
                "weaknesses": ["Synthetic data."],
                "findings": findings,
                "prior_rulings": [{"id": p["id"], "status": "resolved", "note": "addressed"} for p in prior],
            }
        )

    def auditor(system: str, user: str) -> str:
        return json.dumps({"findings": []})

    def lessons(system: str, user: str) -> str:
        ledger = _json_block(user, "ledger") or []
        ids = [row["id"] for row in ledger if not row["source"].startswith("gate")]
        return json.dumps(
            {
                "lessons": [
                    {
                        "category": "untested_mechanism_explanations",
                        "lesson": "Label explanations of why a method helps as descriptive unless an analysis tests them.",
                        "sections": ["analysis"],
                        "finding_ids": ids,
                    }
                ]
            }
        )

    return {
        "plan": plan,
        "survey:queries": queries,
        "survey:screen": screen,
        "survey:cards": cards,
        "survey:synthesis": synthesis,
        "write:title": title,
        "write": write,
        "revise": revise,
        "shorten": passthrough,
        "repair": passthrough,
        "review:auditor": auditor,
        "review": review,
        "evolve:lessons": lessons,
    }


async def run_selftest(
    keep: Path | None = None, echo=print, root: Path | None = None, run_id: str = "selftest"
) -> dict[str, Any]:
    """Run the selftest in ``root`` (kept) or in a temporary directory (removed afterwards)."""
    from tyche.paper.latex import latex_available

    missing = [tool for tool, path in latex_available().items() if path is None]
    if missing:
        raise RuntimeError(f"selftest needs the TeX/poppler tools: missing {', '.join(missing)}")
    temporary = root is None
    root = Path(tempfile.mkdtemp(prefix="tyche-selftest-")) if root is None else Path(root)
    try:
        config = TycheConfig.load(
            overrides=[
                f"workspace.root={root}",
                "experiments.engine=fixture",
                "review.max_rounds=2",
                "literature.min_papers=4",
            ],
            env={},
        )
        meter = UsageMeter()
        llm = ScriptedLLM(handlers(), name="selftest-scripted", meter=meter)
        literature = dict(config.get("literature"))
        literature["min_interval_seconds"] = {}
        http, searchers, verifier, s2 = build_clients(literature, cache_path=None, env={}, transport=mock_transport())
        ws = Workspace.create(root, run_id, topic=PLAN["working_title"], direction="memory_engine",
                              config_digest=config.digest())
        memory = MemoryStore(root / "memory.db")
        services = Services(
            planner=llm, writer=llm, reviewer=llm, searchers=searchers, verifier=verifier, s2=s2,
            engine=fixture_engine(), meter=meter, model_names=["selftest-scripted (no real model)"],
        )
        pipeline = Pipeline(config, ws, services, memory, load_direction("memory_engine"), echo=echo)
        try:
            await pipeline.run()
        finally:
            await http.aclose()
        package = ws.stage_dir("package")
        gates = json.loads((package / "gates.json").read_text(encoding="utf-8"))
        provenance = json.loads((package / "provenance.json").read_text(encoding="utf-8"))
        rounds = json.loads(ws.latest_path("review_rounds").read_text(encoding="utf-8"))
        usage = pipeline.usage_summary()
        summary = {
            "pdf": str(package / "paper.pdf"),
            "gates_passed": gates["passed"],
            "main_pages": gates["stats"]["main_pages"],
            "distinct_citations": gates["stats"]["distinct_citations"],
            "review_rounds": [(r["round"], r["accepted"], r["composite"]) for r in rounds],
            "drifted_artifacts": provenance["drifted_artifacts"],
            "lessons": [i.meta.get("status") for i in memory.list(kinds=["lesson"], scopes=["global"])],
            # Provider-independent prompt-cache check of the request shape (tyche/cache.py).
            "prefix_reuse_rate": {
                stage: row["prefix_reuse_rate"] for stage, row in (usage["by_stage"] | {"total": usage["total"]}).items()
            },
            "cache_breaks": usage["total"]["cache_breaks"],
        }
        memory.close()
        if keep is not None:
            keep.mkdir(parents=True, exist_ok=True)
            shutil.copy2(package / "paper.pdf", keep / "selftest_paper.pdf")
            shutil.copy2(package / "run_report.md", keep / "selftest_run_report.md")
            summary["kept"] = str(keep)
        ok = (
            summary["gates_passed"]
            and (package / "paper.pdf").exists()
            and not summary["drifted_artifacts"]
            and summary["main_pages"] >= 1
            and summary["cache_breaks"] == 0
        )
        summary["ok"] = bool(ok)
        return summary
    finally:
        if temporary:
            shutil.rmtree(root, ignore_errors=True)
