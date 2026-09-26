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

from tyche.llm import LLMClient, extract_latex
from tyche.memory import Block, MemoryStore, memory_block, pack
from tyche.paper.sanitize import SanitizeReport, sanitize_section
from tyche.planning import ResearchPlan
from tyche.prompts import load_prompt
from tyche.textutil import truncate_tokens, word_count
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
            "Report the main comparison with the confidence interval and p-value from the results brief.",
            "Describe the baselines so a reader knows why each is a fair comparison.",
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
    ):
        self.llm = llm
        self.memory = memory
        self.contracts = contracts
        self.budget = budget
        self.evidence_limit = evidence_limit
        self.lessons_limit = lessons_limit
        self.manifest_dir = manifest_dir
        self._calls = 0

    def contract(self, name: str, ctx: WritingContext) -> dict[str, Any]:
        guide = SECTION_GUIDANCE[name]
        limits = self.contracts.get(name, {})
        fill = {"{min_citations}": str(limits.get("min_citations", 6)), "{method_name}": ctx.plan.method_name}

        def render(text: str) -> str:
            for placeholder, value in fill.items():
                text = text.replace(placeholder, value)
            return text

        return {
            "section": name,
            "goal": guide["goal"],
            "requirements": [render(req) for req in guide["requirements"]],
            "min_words": limits.get("min_words"),
            "max_words": limits.get("max_words"),
        }

    def _blocks(
        self,
        name: str,
        ctx: WritingContext,
        previous: dict[str, str],
        findings: list[dict[str, Any]] | None,
        current: str | None,
    ) -> list[Block]:
        uses = SECTION_GUIDANCE[name]["uses"]
        blocks = [Block("section_contract", json.dumps(self.contract(name, ctx), ensure_ascii=False, indent=1), required=True)]
        blocks.append(Block("research_plan", ctx.plan.model_dump_json(indent=1), required=True))
        allowed = [] if name in ("abstract", "conclusion") else ctx.citations
        blocks.append(Block("allowed_citations", json.dumps(allowed, ensure_ascii=False, indent=1), required=True))
        blocks.append(Block("available_labels", json.dumps(ctx.labels if name == "experiments" or name == "analysis" else {}, indent=1), required=True))
        if "results" in uses:
            blocks.append(Block("results_brief", ctx.results_brief, required=True))
        if "design" in uses and ctx.design_excerpt:
            blocks.append(Block("experiment_design", ctx.design_excerpt, priority=10))
        if "reflection" in uses and ctx.reflection_excerpt:
            blocks.append(Block("experiment_reflection", ctx.reflection_excerpt, priority=12))
        if "survey" in uses:
            survey = {
                "gap": ctx.synthesis.get("gap"),
                "themes": ctx.synthesis.get("themes"),
                "open_problems": ctx.synthesis.get("open_problems"),
            }
            blocks.append(Block("survey_synthesis", json.dumps(survey, ensure_ascii=False, indent=1), priority=15))
        if "evidence" in uses:
            query = " ".join([ctx.plan.working_title, ctx.plan.problem, ctx.plan.method_sketch, *ctx.plan.keywords])
            blocks.append(
                memory_block(
                    self.memory,
                    "evidence",
                    query,
                    kinds=["evidence"],
                    run_id=ctx.run_id,
                    limit=self.evidence_limit,
                    priority=20,
                )
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
        if "digests" in uses and previous:
            text = "\n".join(f"[{sec}] {digest(body)}" for sec, body in previous.items() if sec != name)
            blocks.append(Block("previous_sections", text, priority=30))
        if current is not None:
            blocks.append(Block("current_section", current, required=True))
        if findings:
            blocks.append(Block("findings_to_address", json.dumps(findings, ensure_ascii=False, indent=1), required=True))
        return blocks

    def _save_manifest(self, name: str, purpose: str, manifest: dict[str, Any]) -> None:
        self._calls += 1
        write_json_atomic(self.manifest_dir / f"{self._calls:03d}_{purpose}_{name}.json", manifest)

    async def _call(self, name: str, purpose: str, blocks: list[Block], allowed_keys: set[str], instruction: str) -> SectionDraft:
        context = pack(blocks, self.budget)
        self._save_manifest(name, purpose, context.manifest())
        self.memory.touch(context.item_ids)
        reply = await self.llm.complete(
            system=load_prompt("section_system"),
            user=context.text + "\n\n" + instruction,
            purpose=f"{purpose}:{name}",
        )
        body, report = sanitize_section(extract_latex(reply.text), allowed_keys)
        responses: list[dict[str, Any]] = []
        match = _RESPONSES.search(reply.text)
        if match:
            try:
                parsed = json.loads(match.group(1))
                responses = [r for r in parsed if isinstance(r, dict)] if isinstance(parsed, list) else []
            except json.JSONDecodeError:
                responses = []
        return SectionDraft(name=name, latex=body, report=report, words=word_count(body), responses=responses)

    async def write(self, name: str, ctx: WritingContext, previous: dict[str, str]) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = self._blocks(name, ctx, previous, None, None)
        return await self._call(name, "write", blocks, allowed, f"Write the {name.replace('_', ' ')} section now.")

    async def revise(
        self, name: str, ctx: WritingContext, previous: dict[str, str], current: str, findings: list[dict[str, Any]]
    ) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = self._blocks(name, ctx, previous, findings, current)
        instruction = (
            f"Revise the {name.replace('_', ' ')} section to address every finding in <findings_to_address>. "
            "Change only what the findings require; keep correct content, citations, and numbers intact, and do "
            "not over-correct. Return the full revised section."
        )
        return await self._call(name, "revise", blocks, allowed, instruction)

    async def shorten(self, name: str, ctx: WritingContext, current: str, target_words: int) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = [
            Block("section_contract", json.dumps(self.contract(name, ctx), ensure_ascii=False), required=True),
            Block("allowed_citations", json.dumps(ctx.citations if allowed else [], ensure_ascii=False), required=True),
            Block("current_section", current, required=True),
        ]
        instruction = (
            f"The paper exceeds its page limit. Shorten this section to at most {target_words} words. Remove "
            "repetition and secondary detail first; keep every citation that supports a claim, every reported "
            "number that remains, and all \\ref labels."
        )
        return await self._call(name, "shorten", blocks, allowed, instruction)

    async def repair(self, name: str, ctx: WritingContext, current: str, error: str) -> SectionDraft:
        allowed = {c["key"] for c in ctx.citations} if name not in ("abstract", "conclusion") else set()
        blocks = [
            Block("latex_error", truncate_tokens(error, 600), required=True),
            Block("allowed_citations", json.dumps(ctx.citations if allowed else [], ensure_ascii=False), required=True),
            Block("current_section", current, required=True),
        ]
        instruction = (
            "This section fails to compile with the error in <latex_error>. Fix only the LaTeX problem; do not "
            "change the wording or content otherwise. Return the full corrected section."
        )
        return await self._call(name, "repair", blocks, allowed, instruction)

    async def title(self, ctx: WritingContext, abstract: str) -> str:
        reply = await self.llm.complete(
            system=(
                "You title ICLR short papers. Return only the title on one line: specific, at most 14 words, "
                "naming the mechanism and the finding, no colon-separated clickbait, no quotes."
            ),
            user="<research_plan>\n" + ctx.plan.model_dump_json(indent=1) + "\n</research_plan>\n<abstract>\n"
            + abstract
            + "\n</abstract>",
            purpose="write:title",
        )
        title = reply.text.strip().splitlines()[0].strip().strip('"').strip()
        title = re.sub(r"[\\{}$^_#&%~]", "", title)
        return title[:180] or ctx.plan.working_title
