"""Draft, assemble, compile, repair, trim, and gate the paper."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tyche.analysis.registry import NumberRegistry
from tyche.gates import GateReport, run_gates
from tyche.paper.latex import (
    CompileResult,
    PaperSource,
    compile_pdf,
    main_text_pages,
    pdf_text,
    write_build,
)
from tyche.paper.writer import WRITE_ORDER, SectionWriter, WritingContext
from tyche.textutil import word_count


@dataclass
class BuildResult:
    build_dir: Path
    compile: CompileResult
    gates: GateReport
    main_pages: int
    text: str
    repairs: list[str] = field(default_factory=list)
    trims: list[str] = field(default_factory=list)

    @property
    def pdf(self) -> Path | None:
        return self.compile.pdf

    def summary(self) -> dict[str, Any]:
        return {
            "build_dir": str(self.build_dir),
            "compiled": self.compile.ok,
            "pages": self.compile.pages,
            "main_pages": self.main_pages,
            "gates_passed": self.gates.passed,
            "blockers": len(self.gates.blockers),
            "repairs": self.repairs,
            "trims": self.trims,
        }


class PaperComposer:
    def __init__(
        self,
        writer: SectionWriter,
        ctx: WritingContext,
        *,
        bib_path: Path,
        figures: list[Path],
        floats: dict[str, str],
        ai_statement: str,
        reproducibility: str,
        registry: NumberRegistry,
        bib_keys: set[str],
        contracts: dict[str, dict[str, Any]],
        labels: list[str],
        max_main_pages: int,
        latex_timeout: int = 180,
        repair_attempts: int = 3,
        trim_attempts: int = 3,
        anonymous: bool = True,
        authors: list[dict[str, str]] | None = None,
        log=None,
    ):
        self.writer = writer
        self.ctx = ctx
        self.bib_path = bib_path
        self.figures = figures
        self.floats = floats
        self.ai_statement = ai_statement
        self.reproducibility = reproducibility
        self.registry = registry
        self.bib_keys = bib_keys
        self.contracts = contracts
        self.labels = labels
        self.max_main_pages = max_main_pages
        self.latex_timeout = latex_timeout
        self.repair_attempts = repair_attempts
        self.trim_attempts = trim_attempts
        self.anonymous = anonymous
        self.authors = authors or []
        self.log = log or (lambda *a, **k: None)
        self.sections: dict[str, str] = {}
        self.removed: dict[str, list[str]] = {}
        self.title = ctx.plan.working_title

    # -- drafting ------------------------------------------------------
    async def draft(self) -> None:
        for name in WRITE_ORDER:
            draft = await self.writer.write(name, self.ctx, self.sections)
            self.sections[name] = draft.latex
            self.removed[name] = list(draft.report.removed_citations)
            self.log("write.section", section=name, words=draft.words, fixes=draft.report.fixes)
        self.title = await self.writer.title(self.ctx, self.sections["abstract"])

    def load(self, title: str, sections: dict[str, str]) -> None:
        self.title = title
        self.sections = dict(sections)

    def source(self) -> PaperSource:
        return PaperSource(
            title=self.title,
            abstract=self.sections.get("abstract", ""),
            sections={k: v for k, v in self.sections.items() if k != "abstract"},
            ai_statement=self.ai_statement,
            reproducibility=self.reproducibility,
            floats=self.floats,
            authors=self.authors,
            anonymous=self.anonymous,
            method_heading=self.ctx.plan.method_name and f"The {self.ctx.plan.method_name} Method" or "Method",
        )

    # -- building ------------------------------------------------------
    def _compile(self, build_dir: Path) -> tuple[CompileResult, int, str]:
        if build_dir.exists():
            shutil.rmtree(build_dir)
        tex = write_build(self.source(), build_dir, bib_path=self.bib_path, figures=self.figures)
        result = compile_pdf(tex, timeout=self.latex_timeout)
        if result.ok and result.pdf is not None:
            return result, main_text_pages(result.pdf), pdf_text(result.pdf)
        return result, 0, ""

    async def build(self, build_dir: Path) -> BuildResult:
        repairs: list[str] = []
        trims: list[str] = []
        result, main_pages, text = self._compile(build_dir)
        attempts = 0
        while not result.ok and attempts < self.repair_attempts:
            attempts += 1
            err = result.errors[0] if result.errors else None
            target = None
            if err and err.file.startswith("sections/"):
                target = Path(err.file).stem
            if target in self.sections or (target == "abstract"):
                message = f"{err.file}:{err.line}: {err.message}\n{result.log_tail[-800:]}"
                draft = await self.writer.repair(target, self.ctx, self.sections[target], message)
                self.sections[target] = draft.latex
                repairs.append(f"{target}: {err.message[:120]}")
            else:
                repairs.append(f"unattributed error: {err.message[:160] if err else 'unknown'}")
                break
            result, main_pages, text = self._compile(build_dir)
        tries = 0
        while result.ok and main_pages > self.max_main_pages and tries < self.trim_attempts:
            tries += 1
            ratio = self.max_main_pages / max(main_pages, 1)
            candidates = sorted(
                (n for n in self.sections if n not in ("abstract", "conclusion")),
                key=lambda n: word_count(self.sections[n]),
                reverse=True,
            )[:3]
            for name in candidates:
                target_words = max(80, int(word_count(self.sections[name]) * ratio * 0.92))
                draft = await self.writer.shorten(name, self.ctx, self.sections[name], target_words)
                if draft.latex.strip():
                    self.sections[name] = draft.latex
                    trims.append(f"{name} -> {draft.words} words")
            result, main_pages, text = self._compile(build_dir)
        gates = run_gates(
            sections=self.sections,
            compile_result=result,
            main_pages=main_pages,
            max_main_pages=self.max_main_pages,
            registry=self.registry,
            bib_keys=self.bib_keys,
            contracts=self.contracts,
            labels=self.labels,
            removed_citations=self.removed,
            pdf_text=text,
        )
        self.log("build", dir=str(build_dir), compiled=result.ok, main_pages=main_pages, blockers=len(gates.blockers))
        return BuildResult(build_dir, result, gates, main_pages, text, repairs, trims)
