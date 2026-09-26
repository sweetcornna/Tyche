"""Section-by-section writing under explicit context contracts.

Each section is written by one model call whose context is packed from the
Research Memory Engine under a token budget (see tyche.memory.context_pack):
the section contract, the plan, the allowed citations, the results brief, the
most relevant evidence cards, active lessons from earlier runs, and short
digests of the sections already written. Sections are written in dependency
order -- method and experiments first, introduction and abstract last -- so
the framing is written after the substance exists.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tyche.llm import Conversation, LLMClient, extract_latex
from tyche.memory import Block, MemoryStore, memory_block, pack, wrap_block
from tyche.paper.sanitize import SanitizeReport, sanitize_section
from tyche.planning import ResearchPlan
from tyche.prompts import load_prompt
from tyche.textutil import count_tokens, truncate_tokens, word_count
from tyche.workspace import write_json_atomic

WRITE_ORDER = ("method", "experiments", "analysis", "related_work", "introduction", "conclusion", "abstract")

SECTION_GUIDANCE: dict[str, dict[str, Any]] = {
    "abstract": {
        "goal": "One paragraph: problem, why it matters, the proposed mechanism, how it was evaluated, the key "
        "quantitative result with its uncertainty, and the takeaway.",
        "requirements": [
            "No citations and no LaTeX environments.",
            "State the main result with the exact number from the results brief.",
        ],
        "uses": ["plan", "results", "reflection", "digests"],
    },
    "introduction": {
        "goal": "Motivate the problem, identify the precise gap left by prior work, state the idea, and preview "
        "the evidence.",
        "requirements": [
            "End with a short itemize list of 2-4 contributions that the paper actually delivers.",
            "Cite the most relevant prior work when stating the gap.",
            "Preview the main result honestly, including its uncertainty.",
        ],
        "uses": ["plan", "survey", "results", "reflection", "digests", "evidence"],
    },
    "related_work": {
        "goal": "Position the work against prior research, organized by the survey themes, ending each theme "
        "with how this paper differs.",
        "requirements": [
            "Use one \\paragraph{} per theme.",
            "Cite at least {min_citations} distinct allowed keys.",
            "Contrast, do not just list: say what each line of work leaves open.",
        ],
        "uses": ["plan", "survey", "evidence", "digests"],
    },
    "method": {
        "goal": "Describe the proposed mechanism precisely enough to reimplement: problem setup and notation, the "
        "mechanism, and how it differs from the baselines.",
        "requirements": [
            "Name the method {method_name} consistently.",
            "Use an equation or a compact algorithmic description for the core mechanism.",
            "Describe only what the experiment code implements, as documented in the experiment design.",
        ],
        "uses": ["plan", "design", "evidence"],
    },
    "experiments": {
        "goal": "Setup (task, data generation, baselines, metrics, protocol) followed by the main results.",
        "requirements": [
            "Reference every available table and figure label with \\ref.",
            "Before the results, state each hypothesis of the research plan with its predicted outcome; refer to "
            "hypotheses only by labels defined here.",
            "Report the main comparison with the confidence interval and p-value from the results brief when it "
            "has them; if it has none, say the results are point estimates and do not claim significance.",
            "Describe the baselines so a reader knows why each is a fair comparison, and report any baseline the "
            "experiment reflection identifies as defective as such rather than as a competitive result.",
        ],
        "uses": ["plan", "design", "results", "reflection", "digests"],
    },
    "analysis": {
        "goal": "Interpret the results: when and why the method helps or fails, trade-offs (e.g. accuracy vs. "
        "tokens), and threats to validity.",
        "requirements": [
            "Include a \\paragraph{Limitations.} that names concrete limits of the evidence.",
            "Tie each interpretation to a specific number in the results brief.",
        ],
        "uses": ["plan", "results", "reflection", "digests", "evidence"],
    },
    "conclusion": {
        "goal": "What was shown, how strongly, and what it implies for building agents; one concrete next step.",
        "requirements": ["No new results and no citations."],
        "uses": ["plan", "results", "reflection", "digests"],
    },
}

_RESPONSES = re.compile(r"<responses>(.*?)</responses>", re.S)


@dataclass
class WritingContext:
    plan: ResearchPlan
    citations: list[dict[str, Any]]  # {key, title, year, role, themes}
    synthesis: dict[str, Any]
    results_brief: str
    design_excerpt: str
    labels: dict[str, str]
    run_id: str
    # The experiment loop's own reflection (verdict, suspected defects, mechanisms), if any.
    reflection_excerpt: str = ""


@dataclass
class SectionDraft:
    name: str
    latex: str
    report: SanitizeReport
    words: int
    responses: list[dict[str, Any]] = field(default_factory=list)


def digest(text: str, words: int = 90) -> str:
    plain = re.sub(r"\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?", " ", text)
    plain = re.sub(r"[{}$]", " ", plain)
    tokens = plain.split()
    return " ".join(tokens[:words]) + (" ..." if len(tokens) > words else "")


class SectionWriter:
    def __init__(
        self,
        llm: LLMClient,
        *,
        memory: MemoryStore,
        contracts: dict[str, dict[str, Any]],
        budget: int,
        evidence_limit: int,
        lessons_limit: int,
        manifest_dir: Path,
        max_history_tokens: int = 200_000,
    ):
        self.llm = llm
        self.memory = memory
        self.contracts = contracts
        self.budget = budget
        self.evidence_limit = evidence_limit
        self.lessons_limit = lessons_limit
        self.manifest_dir = manifest_dir
        self.max_history_tokens = max_history_tokens
        self._calls = 0
        # One append-only author conversation per writer (per stage): every call extends the
        # previous request, so the provider prefix cache serves all earlier turns.
        self.conversation: Conversation | None = None
        # What the conversation shows as each section's latest text, and which sections'
        # contract and lessons it already holds; both are rolled back with the history.
        self._latest: dict[str, str] = {}
        self._introduced: set[str] = set()

    def contract(self, name: str, ctx: WritingContext) -> dict[str, Any]:
        guide = SECTION_GUIDANCE[name]
        limits = self.contracts.get(name, {})
        fill = {"{min_citations}": str(limits.get("min_citations", 6)), "{method_name}": ctx.plan.method_name}

        def render(text: str) -> str:
            for placeholder, value in fill.items():
                text = text.replace(placeholder, value)
            return text

        uses = guide["uses"]
        shared = {
            "plan": "research_plan",
            "results": "results_brief",
            "design": "experiment_design",
            "reflection": "experiment_reflection",
            "survey": "survey_synthesis",
            "evidence": "evidence",
        }
        context = [shared[u] for u in uses if u in shared]
        if name not in ("abstract", "conclusion"):
            context.append("allowed_citations")
        if name in ("experiments", "analysis"):
            context.append("available_labels")
        return {
            "section": name,
            "goal": guide["goal"],
            "requirements": [render(req) for req in guide["requirements"]],
            "min_words": limits.get("min_words"),
            "max_words": limits.get("max_words"),
            "may_cite": name not in ("abstract", "conclusion"),
            "shared_context_to_use": context,
        }

    def _blocks(
        self,
        name: str,
        ctx: WritingContext,
        previous: dict[str, str],
        findings: list[dict[str, Any]] | None,
        current: str | None,
    ) -> list[Block]:
        """Section-specific blocks for one call; shared context lives in the system prompt.

        Within the conversation, a section's contract and lessons are sent once, other
        sections are summarised only if the history does not already hold their latest text,
        and the current section is sent only if the history does not hold it verbatim.
        Blocks come in a stable order (per-section static first, per-call variable last).
        """
        blocks: list[Block] = []
        if name not in self._introduced:
            blocks.append(
                Block("section_contract", json.dumps(self.contract(name, ctx), ensure_ascii=False, indent=1), required=True)
            )
            blocks.append(
                memory_block(
                    self.memory,
                    "lessons",
                    f"{name} {ctx.plan.working_title}",
                    kinds=["lesson"],
                    run_id=ctx.run_id,
                    limit=self.lessons_limit,
                    priority=25,
                    scopes=["global", "project"],
                    extra_filter=lambda item: item.meta.get("status") == "active",
                )
            )
        if "digests" in SECTION_GUIDANCE[name]["uses"] and previous:
            stale = {sec: body for sec, body in previous.items() if sec != name and self._latest.get(sec) != body}
            if stale:
                text = "\n".join(f"[{sec}] {digest(body)}" for sec, body in stale.items())
                blocks.append(Block("other_sections_now", text, priority=30))
        if current is not None and self._latest.get(name) != current:
            blocks.append(Block("current_section", current, required=True))
        if findings:
            blocks.append(Block("findings_to_address", json.dumps(findings, ensure_ascii=False, indent=1), required=True))
        return blocks

    def _save_manifest(self, name: str, purpose: str, manifest: dict[str, Any]) -> None:
        self._calls += 1
        write_json_atomic(self.manifest_dir / f"{self._calls:03d}_{purpose}_{name}.json", manifest)

    def shared_context(self, ctx: WritingContext) -> list[Block]:
        """Context identical for every section and every call of a run, sent once as the system prompt.

        Evidence retrieval uses a plan-level query (deterministic BM25 over this run's cards),
        so it is the same for every section and belongs here rather than in each turn.
        """
        blocks = [
            Block("research_plan", ctx.plan.model_dump_json(indent=1)),
            Block("allowed_citations", json.dumps(ctx.citations, ensure_ascii=False, indent=1)),
            Block("available_labels", json.dumps(ctx.labels, indent=1)),
            Block("results_brief", ctx.results_brief),
        ]
        if ctx.design_excerpt:
            blocks.append(Block("experiment_design", ctx.design_excerpt))
        if ctx.reflection_excerpt:
            blocks.append(Block("experiment_reflection", ctx.reflection_excerpt))
        survey = {k: ctx.synthesis.get(k) for k in ("gap", "themes", "open_problems")}
        blocks.append(Block("survey_synthesis", json.dumps(survey, ensure_ascii=False, indent=1)))
        query = " ".join([ctx.plan.working_title, ctx.plan.problem, ctx.plan.method_sketch, *ctx.plan.keywords])
        blocks.append(
            memory_block(self.memory, "evidence", query, kinds=["evidence"], run_id=ctx.run_id, limit=self.evidence_limit)
        )
        return blocks

    def _conversation_for(self, ctx: WritingContext) -> tuple[Conversation, list[Block]]:
        shared = self.shared_context(ctx)
        system = load_prompt("section_system") + "\n\n" + "\n\n".join(wrap_block(b) for b in shared)
        conv = self.conversation
        # A changed shared context (e.g. a citation admitted during review) or an overlong
        # history starts a new conversation; otherwise every call extends the current one.
        if conv is None or conv.system != system or conv.tokens() > self.max_history_tokens:
            conv = self.conversation = Conversation(system)
            self._latest = {}
            self._introduced = set()
        return conv, shared

    def export_state(self) -> dict[str, Any] | None:
        """The author conversation, for the next stage to resume (as DSH resumes sessions)."""
        if self.conversation is None:
            return None
        return {
            "system": self.conversation.system,
            "turns": list(self.conversation.turns),
            "latest": dict(self._latest),
            "introduced": sorted(self._introduced),
        }

    def import_state(self, state: dict[str, Any] | None, ctx: WritingContext) -> bool:
        """Resume a saved author conversation if its shared context is still current.

        The resumed history is byte-identical to the requests already sent, so the provider
        serves it from cache; a changed context (the system prompt differs) starts afresh.
        """
        if not state:
            return False
        conv, _ = self._conversation_for(ctx)
        if state.get("system") != conv.system:
            return False
        conv.turns = [dict(turn) for turn in state.get("turns") or []]
        self._latest = dict(state.get("latest") or {})
        self._introduced = set(state.get("introduced") or [])
        return True

    def checkpoint(self) -> tuple[int, dict[str, str], set[str], Conversation | None]:
        conv = self.conversation
        return (conv.checkpoint() if conv else 0, dict(self._latest), set(self._introduced), conv)

    def rollback(self, state: tuple[int, dict[str, str], set[str], Conversation | None]) -> None:
        """Undo the calls since ``checkpoint`` (a rejected revision): truncate, never edit."""
        mark, latest, introduced, conv = state
        if conv is not None and conv is self.conversation:
            conv.rollback(mark)
            self._latest, self._introduced = latest, introduced
        elif conv is not None:
            # The conversation was replaced after the checkpoint; resume the earlier one.
            conv.rollback(mark)
            self.conversation, self._latest, self._introduced = conv, latest, introduced

    async def _call(
        self,
        name: str,
        purpose: str,
        ctx: WritingContext,
        blocks: list[Block],
        allowed_keys: set[str],
        instruction: str,
    ) -> SectionDraft:
        conv, shared = self._conversation_for(ctx)
        context = pack(blocks, self.budget)
        manifest = context.manifest()
        manifest["shared_system_context"] = [{"name": b.name, "tokens": count_tokens(wrap_block(b))} for b in shared]
        manifest["history_turns"] = len(conv.turns)
        self._save_manifest(name, purpose, manifest)
        self.memory.touch(context.item_ids + [i for b in shared for i in b.item_ids])
        user = (context.text + "\n\n" + instruction).strip()
        reply = await conv.ask(self.llm, user, purpose=f"{purpose}:{name}")
        body, report = sanitize_section(extract_latex(reply.text), allowed_keys)
        responses: list[dict[str, Any]] = []
        match = _RESPONSES.search(reply.text)
        if match:
            try:
                parsed = json.loads(match.group(1))
                responses = [r for r in parsed if isinstance(r, dict)] if isinstance(parsed, list) else []
            except json.JSONDecodeError:
                responses = []
        if body.strip():
            # Record the text actually kept, so later turns can refer to it instead of resending it.
            record = f"<latex>\n{body.strip()}\n</latex>"
            if match:
                record += f"\n<responses>{match.group(1)}</responses>"
            conv.set_last_reply(record)
            self._latest[name] = body
        self._introduced.add(name)
        return SectionDraft(name=name, latex=body, report=report, words=word_count(body), responses=responses)

    def _current_note(self, name: str, current: str) -> str:
        if self._latest.get(name) == current:
            return f" The current text of the {name.replace('_', ' ')} section is your latest version of it above."
        return ""

    async def write(self, name: str, ctx: WritingContext, previous: dict[str, str]) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = self._blocks(name, ctx, previous, None, None)
        return await self._call(name, "write", ctx, blocks, allowed, f"Write the {name.replace('_', ' ')} section now.")

    async def revise(
        self, name: str, ctx: WritingContext, previous: dict[str, str], current: str, findings: list[dict[str, Any]]
    ) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = self._blocks(name, ctx, previous, findings, current)
        instruction = (
            f"Revise the {name.replace('_', ' ')} section to address every finding in <findings_to_address>. "
            "Change only what the findings require; keep correct content, citations, and numbers intact, and do "
            "not over-correct. Return the full revised section." + self._current_note(name, current)
        )
        return await self._call(name, "revise", ctx, blocks, allowed, instruction)

    async def shorten(self, name: str, ctx: WritingContext, current: str, target_words: int) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = self._blocks(name, ctx, {}, None, current)
        instruction = (
            f"The paper exceeds its page limit. Shorten the {name.replace('_', ' ')} section to at most "
            f"{target_words} words. Remove repetition and secondary detail first; keep every citation that "
            "supports a claim, every reported number that remains, and all \\ref labels. Return the full "
            "shortened section." + self._current_note(name, current)
        )
        return await self._call(name, "shorten", ctx, blocks, allowed, instruction)

    async def repair(self, name: str, ctx: WritingContext, current: str, error: str) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = self._blocks(name, ctx, {}, None, current)
        blocks.append(Block("latex_error", truncate_tokens(error, 600), required=True))
        instruction = (
            f"The {name.replace('_', ' ')} section fails to compile with the error in <latex_error>. Fix only the "
            "LaTeX problem; do not change the wording or content otherwise. Return the full corrected section."
            + self._current_note(name, current)
        )
        return await self._call(name, "repair", ctx, blocks, allowed, instruction)

    async def title(self, ctx: WritingContext, abstract: str) -> str:
        conv, _ = self._conversation_for(ctx)
        abstract_block = "" if self._latest.get("abstract") == abstract else f"<abstract>\n{abstract}\n</abstract>\n"
        reply = await conv.ask(
            self.llm,
            abstract_block
            + "Now title the paper. Return only the title on one line: specific, at most 14 words, naming the "
            "mechanism and the finding, no colon-separated clickbait, no quotes, no LaTeX.",
            purpose="write:title",
        )
        title = reply.text.strip().splitlines()[0].strip().strip('"').strip() if reply.text.strip() else ""
        title = re.sub(r"[\\{}$^_#&%~]", "", title)
        return title[:180] or ctx.plan.working_title
