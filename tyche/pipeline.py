"""The Tyche pipeline: plan -> survey -> experiments -> analysis -> write -> review -> evolve -> package.

Every stage reads its inputs from saved artifacts and writes new artifact
versions, so a run can stop after any stage (``stop_after``), be inspected or
edited, and resume. A stage that cannot produce valid output raises
:class:`StageError`; nothing downstream runs on missing evidence.
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tyche import STAGES, __version__
from tyche.analysis import analyze, build_registry, comparison_table, results_brief, results_figure, results_table
from tyche.analysis.registry import NumberRegistry
from tyche.config import TycheConfig
from tyche.evolution import EvolutionPolicy, distill_lessons, export_evolutions, update_lessons
from tyche.experiments import ExperimentEngine
from tyche.literature import Paper
from tyche.literature.bibtex import assign_keys, to_bibtex
from tyche.literature.survey import Surveyor, prerank, write_survey_outputs
from tyche.llm import LLMClient, UsageMeter
from tyche.memory import MemoryStore
from tyche.paper.compose import PaperComposer
from tyche.paper.statements import ai_use_statement, reproducibility_statement
from tyche.paper.writer import SectionWriter, WritingContext
from tyche.planning import ResearchPlan, make_plan, plan_markdown
from tyche.review import FindingsLedger, ReviewPanel, RevisionLoop
from tyche.textutil import sanitize_untrusted, truncate_tokens
from tyche.workspace import StageError, Workspace, sha256_file, utcnow, write_json_atomic


@dataclass
class Services:
    planner: LLMClient
    writer: LLMClient
    reviewer: LLMClient
    searchers: list[Any]
    verifier: Any
    s2: Any
    engine: ExperimentEngine
    meter: UsageMeter
    model_names: list[str] = field(default_factory=list)


class Pipeline:
    def __init__(
        self,
        config: TycheConfig,
        ws: Workspace,
        services: Services,
        memory: MemoryStore,
        direction: dict[str, Any],
        *,
        allow_gate_failures: bool = False,
        operator_notes: str = "",
        skill_export_dir: Path | None = None,
        echo=print,
    ):
        self.cfg = config
        self.ws = ws
        self.svc = services
        self.memory = memory
        self.direction = direction
        self.allow_gate_failures = allow_gate_failures
        self.operator_notes = operator_notes
        self.skill_export_dir = skill_export_dir
        self.echo = echo

    # -- helpers -------------------------------------------------------
    def log(self, kind: str, **fields: Any) -> None:
        self.ws.event(kind, **fields)

    @property
    def run_id(self) -> str:
        return self.ws.run_id

    def plan(self) -> ResearchPlan:
        return ResearchPlan.model_validate(self.ws.load_json("plan"))

    async def run(self, *, stop_after: str | None = None, only: str | None = None) -> dict[str, Any]:
        if stop_after and stop_after not in STAGES:
            raise StageError(f"unknown stage {stop_after!r}")
        stages = [only] if only else list(STAGES)
        for stage in stages:
            if only is None and self.ws.stage_status(stage) == "done":
                self.echo(f"[tyche] {stage}: already done, skipping")
                if stage == stop_after:
                    break
                continue
            self.echo(f"[tyche] {stage}: running")
            self.svc.meter.stage = stage
            self.ws.mark_stage(stage, "running")
            try:
                info = await getattr(self, f"stage_{stage}")()
            except Exception as exc:
                self._flush_usage()
                self.ws.mark_stage(stage, "failed", error=f"{type(exc).__name__}: {exc}"[:2000])
                raise
            self._flush_usage()
            self.ws.mark_stage(stage, "done", **(info or {}))
            self.echo(f"[tyche] {stage}: done {json.dumps(info or {}, ensure_ascii=False)[:300]}")
            if stage == stop_after:
                break
        return self.ws.state

    def _flush_usage(self) -> None:
        """Append this process's model usage to the run's usage log, so resumed runs keep totals."""
        path = self.ws.run_dir / "usage.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            for rec in self.svc.meter.records:
                handle.write(json.dumps(rec.__dict__, ensure_ascii=False) + "\n")
        self.svc.meter.records.clear()

    def usage_summary(self) -> dict[str, Any]:
        meter = UsageMeter()
        path = self.ws.run_dir / "usage.jsonl"
        if path.exists():
            from tyche.llm import UsageRecord

            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    meter.records.append(UsageRecord(**json.loads(line)))
        return meter.summary()

    # -- S0 plan -------------------------------------------------------
    async def stage_plan(self) -> dict[str, Any]:
        plan, manifest = await make_plan(
            self.svc.planner,
            topic=self.ws.state["topic"],
            direction=self.direction,
            memory=self.memory,
            run_id=self.run_id,
            budget=int(self.cfg.get("memory.context_budgets.plan", 6000)),
            operator_notes=self.operator_notes,
        )
        rec = self.ws.save_json("plan", plan.model_dump(), stage="plan")
        self.ws.save_text("plan_md", plan_markdown(plan), stage="plan", inputs=[rec.id])
        write_json_atomic(self.ws.stage_dir("plan") / "context_manifest.json", manifest)
        return {"method": plan.method_name, "title": plan.working_title}

    # -- S1 survey -----------------------------------------------------
    async def stage_survey(self) -> dict[str, Any]:
        plan = self.plan()
        surveyor = Surveyor(
            self.svc.planner,
            searchers=self.svc.searchers,
            verifier=self.svc.verifier,
            s2=self.svc.s2,
            memory=self.memory,
            run_id=self.run_id,
            settings=dict(self.cfg.get("literature") or {}),
            log=self.log,
        )
        result = await surveyor.run(plan, self.direction)
        paths = write_survey_outputs(result, self.ws.stage_dir("survey"))
        plan_id = self.ws.latest("plan").id
        for name, path in (("refs_bib", paths["bib"]), ("research_summary", paths["summary"]),
                           ("source_manifest", paths["manifest"]), ("candidate_pool", paths["pool"])):
            self.ws.save_file(name, path, stage="survey", inputs=[plan_id])
        return {k: v for k, v in result.stats.items() if k != "source_errors"} | {
            "source_errors": len(result.stats.get("source_errors", []))
        }

    # -- S2 experiments ------------------------------------------------
    async def stage_experiments(self) -> dict[str, Any]:
        plan = self.plan()
        work = self.ws.stage_dir("experiments") / "engine"
        outcome = await self.svc.engine.run(
            plan, summary_path=self.ws.latest_path("research_summary"), work_dir=work, run_id=self.run_id
        )
        self.ws.save_json("experiments", outcome.summary(), stage="experiments")
        if outcome.status != "completed" or len(outcome.variants) < 2:
            raise StageError(
                f"experiments did not complete ({outcome.engine}): {outcome.notes}. No paper is written without "
                "results; fix the experiment or rerun with --engine imported --results-dir <dir>."
            )
        inputs = [self.ws.latest("plan").id, self.ws.latest("research_summary").id]
        if outcome.metrics_dir:
            self.ws.save_tree("experiment_results", outcome.metrics_dir, stage="experiments", inputs=inputs)
        if outcome.design_path:
            self.ws.save_file("experiment_design", outcome.design_path, stage="experiments", inputs=inputs)
        if outcome.code_dir:
            self.ws.save_tree("experiment_code", outcome.code_dir, stage="experiments", inputs=inputs)
        for path in outcome.reflections:
            self.ws.save_file("reflection", path, stage="experiments", inputs=inputs)
        self.ws.set_meta(experiment_engine=outcome.engine, synthetic=outcome.synthetic)
        return {"engine": outcome.engine, "variants": sorted(outcome.variants), "synthetic": outcome.synthetic}

    # -- S3 analysis ---------------------------------------------------
    async def stage_analysis(self) -> dict[str, Any]:
        from tyche.experiments import read_metrics_dir

        plan = self.plan()
        variants = read_metrics_dir(self.ws.latest_path("experiment_results"))
        seed = int(self.cfg.get("analysis.seed", 0))
        analysis = analyze(
            variants,
            plan_metrics=plan.metrics,
            method_name=plan.method_name,
            resamples=int(self.cfg.get("analysis.bootstrap_resamples", 2000)),
            permutations=int(self.cfg.get("analysis.permutation_resamples", 5000)),
            confidence=float(self.cfg.get("analysis.confidence", 0.95)),
            seed=seed,
        )
        design = self._design_text()
        # Numbers quoted verbatim from verified abstracts (evidence cards) may be restated about prior work.
        quotes = " ".join(card.get("quote", "") for card in self._manifest().get("evidence_cards", []))
        registry = build_registry(
            analysis, setup_texts={"design": design, "plan": plan_markdown(plan), "evidence_quotes": quotes}
        )
        out = self.ws.stage_dir("analysis")
        n_items = max((s.n for ms in analysis.variants.values() for s in ms.values()), default=0)
        caption = (
            "Main results. Each cell is the mean"
            + (" with the 95\\% bootstrap confidence-interval half-width over evaluation items" if n_items else "")
            + "; the best value per column is bold, and arrows mark whether higher or lower is better."
        )
        (out / "table_main.tex").write_text(results_table(analysis, caption=caption), encoding="utf-8")
        (out / "table_paired.tex").write_text(comparison_table(analysis), encoding="utf-8")
        fig = results_figure(analysis, out / "fig_results.pdf")
        inputs = [self.ws.latest("experiment_results").id]
        self.ws.save_json("analysis", analysis.to_dict(), stage="analysis", inputs=inputs)
        self.ws.save_json("numbers", registry.to_list(), stage="analysis", inputs=inputs)
        self.ws.save_text("results_brief", results_brief(analysis), stage="analysis", inputs=inputs)
        self.ws.save_file("table_main", out / "table_main.tex", stage="analysis", inputs=inputs)
        self.ws.save_file("table_paired", out / "table_paired.tex", stage="analysis", inputs=inputs)
        if fig:
            self.ws.save_file("fig_results", fig, stage="analysis", inputs=inputs)
        self.ws.set_meta(analysis_seed=seed)
        for line in results_brief(analysis).splitlines():
            if line.strip().startswith("-"):
                self.memory.add("evidence", line.strip("- ").strip(), provenance="observed", run_id=self.run_id,
                                title="experiment result", source_ref="analysis", tags=["result"])
        return {"proposed": analysis.proposed, "comparisons": len(analysis.comparisons), "numbers": len(registry.entries)}

    def _design_text(self) -> str:
        if self.ws.latest("experiment_design") is not None:
            return self.ws.load_text("experiment_design")
        return plan_markdown(self.plan())

    # -- shared writing context ------------------------------------------
    def _manifest(self) -> dict[str, Any]:
        return json.loads(self.ws.latest_path("source_manifest").read_text(encoding="utf-8"))

    def _writing_context(self) -> tuple[WritingContext, dict[str, Any]]:
        plan = self.plan()
        manifest = self._manifest()
        synthesis = manifest.get("synthesis", {})
        themes_by_key: dict[str, list[str]] = {}
        for theme in synthesis.get("themes", []):
            for key in theme.get("paper_ids", []):
                themes_by_key.setdefault(key, []).append(theme.get("name", ""))
        citations = [
            {
                "key": p["key"],
                "title": p["title"],
                "year": p.get("year"),
                "role": p.get("role"),
                "themes": themes_by_key.get(p["key"], []),
            }
            for p in manifest.get("papers", [])
        ]
        labels = {"tab:main": "main results table (all variants, all metrics)", "fig:results": "bar chart of the main results with 95% CIs"}
        paired = self.ws.latest_path("table_paired").read_text(encoding="utf-8") if self.ws.latest("table_paired") else ""
        if paired.strip():
            labels["tab:paired"] = "paired comparisons of the proposed method against each baseline"
        ctx = WritingContext(
            plan=plan,
            citations=citations,
            synthesis=synthesis,
            results_brief=self.ws.load_text("results_brief"),
            design_excerpt=truncate_tokens(self._design_text(), 2500),
            labels=labels,
            run_id=self.run_id,
        )
        return ctx, manifest

    def _composer(self, ctx: WritingContext) -> PaperComposer:
        paper_cfg = dict(self.cfg.get("paper") or {})
        contracts = dict(paper_cfg.get("sections") or {})
        writer = SectionWriter(
            self.svc.writer,
            memory=self.memory,
            contracts=contracts,
            budget=int(self.cfg.get("memory.context_budgets.section", 9000)),
            evidence_limit=int(self.cfg.get("memory.evidence_per_section", 12)),
            lessons_limit=int(self.cfg.get("memory.lessons_per_section", 5)),
            manifest_dir=self.ws.stage_dir("write") / "context_manifests",
        )
        figure = self.ws.latest_path("fig_results") if self.ws.latest("fig_results") else None
        floats = self.ws.latest_path("table_main").read_text(encoding="utf-8")
        if figure is not None:
            floats += (
                "\n\\begin{figure}[t]\n\\centering\n\\includegraphics[width=\\linewidth]{figures/"
                + figure.name
                + "}\n\\caption{Mean performance of each variant with 95\\% bootstrap confidence intervals; the "
                "proposed method is shown in red.}\n\\label{fig:results}\n\\end{figure}\n"
            )
        if "tab:paired" in ctx.labels:
            floats += "\n" + self.ws.latest_path("table_paired").read_text(encoding="utf-8")
        meta = {
            "models": self.svc.model_names,
            "experiment_engine": self.ws.meta("experiment_engine", "openjiuwen"),
            "analysis_seed": self.ws.meta("analysis_seed"),
        }
        bib = self.ws.stage_dir("write") / "refs.bib"
        if not bib.exists():
            shutil.copy2(self.ws.latest_path("refs_bib"), bib)
        figures = [figure] if figure is not None else []
        if figure is not None:
            # write_build copies figures by file name; keep the canonical name.
            named = self.ws.stage_dir("write") / "fig_results.pdf"
            shutil.copy2(figure, named)
            figures = [named]
            floats = floats.replace(f"figures/{figure.name}", "figures/fig_results.pdf")
        return PaperComposer(
            writer,
            ctx,
            bib_path=bib,
            figures=figures,
            floats={"experiments": floats},
            ai_statement=ai_use_statement(meta, str(paper_cfg.get("human_review_statement", ""))),
            reproducibility=reproducibility_statement(meta),
            registry=NumberRegistry.from_list(self.ws.load_json("numbers")),
            bib_keys=set(re.findall(r"@\w+\{([^,]+),", bib.read_text(encoding="utf-8"))),
            contracts=contracts,
            labels=list(ctx.labels),
            max_main_pages=int(paper_cfg.get("max_main_pages", 5)),
            latex_timeout=int(paper_cfg.get("latex_timeout", 180)),
            repair_attempts=int(paper_cfg.get("compile_repair_attempts", 3)),
            trim_attempts=int(paper_cfg.get("trim_attempts", 3)),
            anonymous=bool(paper_cfg.get("anonymous", True)),
            authors=list(paper_cfg.get("authors") or []),
            log=self.log,
        )

    # -- S4 write --------------------------------------------------------
    async def stage_write(self) -> dict[str, Any]:
        ctx, _ = self._writing_context()
        composer = self._composer(ctx)
        await composer.draft()
        inputs = [self.ws.latest(n).id for n in ("plan", "refs_bib", "results_brief", "numbers") if self.ws.latest(n)]
        self.ws.save_json(
            "draft",
            {"title": composer.title, "sections": composer.sections, "removed_citations": composer.removed},
            stage="write",
            inputs=inputs,
        )
        return {"title": composer.title, "words": sum(len(s.split()) for s in composer.sections.values())}

    # -- S5 review -------------------------------------------------------
    async def stage_review(self) -> dict[str, Any]:
        ctx, manifest = self._writing_context()
        composer = self._composer(ctx)
        draft = self.ws.load_json("draft")
        composer.load(draft["title"], draft["sections"])
        composer.removed = {k: list(v) for k, v in (draft.get("removed_citations") or {}).items()}
        review_cfg = dict(self.cfg.get("review") or {})
        panel = ReviewPanel(
            self.svc.reviewer,
            reviewers=list(review_cfg.get("reviewers") or ["rigor", "positioning", "clarity"]),
            samples=int(review_cfg.get("samples_per_reviewer", 1)),
            budget=int(self.cfg.get("memory.context_budgets.review", 24000)),
            auditor=bool(review_cfg.get("auditor", True)),
        )
        ledger = FindingsLedger(reflag_cap=int(review_cfg.get("reflag_cap", 2)))
        uncited = self._uncited_related(manifest, ctx)
        evidence = self._cited_evidence(manifest)

        async def review_fn(build, prior):
            round_ = await panel.review(
                paper_text=build.text,
                sections=composer.sections,
                uncited_related=[{"id": u["id"], "title": u["title"], "year": u["year"]} for u in uncited],
                prior_findings=prior,
                results_brief=ctx.results_brief,
                cited_evidence=evidence,
            )
            await self._admit_requested_citations(round_.findings, uncited, composer, ctx)
            return round_

        loop = RevisionLoop(
            composer,
            ledger,
            review_fn,
            out_dir=self.ws.stage_dir("review"),
            max_rounds=int(review_cfg.get("max_rounds", 3)),
            target=float(review_cfg.get("target_composite", 7.5)),
            tolerance=float(review_cfg.get("acceptance_tolerance", 0.15)),
            plateau_rounds=int(review_cfg.get("plateau_rounds", 2)),
            max_findings=int(review_cfg.get("max_findings_per_revision", 8)),
            log=self.log,
        )
        result = await loop.run()
        best = result.best
        inputs = [self.ws.latest("draft").id]
        self.ws.save_json("paper", {"title": result.best_title, "sections": result.best_sections}, stage="review", inputs=inputs)
        self.ws.save_json("ledger", ledger.to_dict(), stage="review", inputs=inputs)
        self.ws.save_json("review_rounds", result.rounds, stage="review", inputs=inputs)
        self.ws.save_json("gates", best.gates.to_dict(), stage="review", inputs=inputs)
        if best.compile.ok and best.pdf is not None:
            self.ws.save_file("paper_pdf", best.pdf, stage="review", inputs=inputs)
            src = self.ws.stage_dir("review") / "best_source"
            if src.exists():
                shutil.rmtree(src)
            shutil.copytree(
                best.build_dir, src, ignore=shutil.ignore_patterns("*.aux", "*.log", "*.fls", "*.fdb_latexmk", "*.blg", "*.out")
            )
            self.ws.save_tree("paper_source", src, stage="review", inputs=inputs)
        if result.best_review is not None:
            self.ws.save_json("review_scores", result.best_review.to_dict(), stage="review", inputs=inputs)
        injected = self._injected_lesson_ids()
        self.ws.set_meta(injected_lessons=sorted(injected))
        return {
            "compiled": best.compile.ok,
            "gates_passed": best.gates.passed,
            "composite": result.best_review.composite if result.best_review else None,
            "overall": result.best_review.overall_mean if result.best_review else None,
            "rounds": len(result.rounds) - 1,
            "main_pages": best.main_pages,
            "ledger": ledger.counts(),
        }

    def _uncited_related(self, manifest: dict[str, Any], ctx: WritingContext) -> list[dict[str, Any]]:
        pool_path = self.ws.latest_path("candidate_pool")
        pool = [Paper.from_dict(p) for p in json.loads(pool_path.read_text(encoding="utf-8"))]
        cited_titles = {p["title"].lower() for p in manifest.get("papers", [])}
        remaining = [p for p in pool if p.title.lower() not in cited_titles]
        plan = ctx.plan
        ranked = prerank(remaining, " ".join([plan.working_title, plan.problem, plan.method_sketch, *plan.keywords]))
        out = []
        for i, (_, paper) in enumerate(ranked[:15], start=1):
            out.append({"id": f"R{i:02d}", "title": paper.title, "year": paper.year, "paper": paper})
        return out

    def _cited_evidence(self, manifest: dict[str, Any]) -> dict[str, str]:
        cards: dict[str, list[str]] = {}
        for card in manifest.get("evidence_cards", []):
            cards.setdefault(card["key"], []).append(card["claim"])
        evidence = {}
        for paper in manifest.get("papers", []):
            text = f"{paper['title']} ({paper.get('year')}). {sanitize_untrusted(paper.get('abstract', ''), 500)}"
            if cards.get(paper["key"]):
                text += " Cards: " + " | ".join(cards[paper["key"]])
            evidence[paper["key"]] = text
        return evidence

    async def _admit_requested_citations(self, findings, uncited, composer: PaperComposer, ctx: WritingContext) -> None:
        """If reviewers ask for a retrieved-but-uncited paper (R-id), verify it and make it citable."""
        wanted = set()
        for finding in findings:
            wanted.update(re.findall(r"\bR\d{2}\b", f"{finding.get('problem', '')} {finding.get('fix', '')}"))
        chosen = [u for u in uncited if u["id"] in wanted and not u.get("admitted")]
        if not chosen:
            return
        papers = [u["paper"] for u in chosen]
        checks = await self.svc.verifier.verify(papers)
        existing = set(composer.bib_keys)
        bib_text = composer.bib_path.read_text(encoding="utf-8")
        for item, paper in zip(chosen, papers):
            if not checks[paper.identity_keys()[0]].citable:
                continue
            key = next(iter(assign_keys([paper])))
            while key in existing:
                key += "x"
            existing.add(key)
            bib_text += "\n" + to_bibtex(key, paper)
            composer.bib_keys.add(key)
            ctx.citations.append({"key": key, "title": paper.title, "year": paper.year, "role": "reviewer-requested", "themes": []})
            for finding in findings:
                for field_name in ("problem", "fix"):
                    finding[field_name] = str(finding.get(field_name, "")).replace(item["id"], f"\\citep{{{key}}}")
            item["admitted"] = True
            self.memory.add("evidence", f"{paper.title} ({paper.year}). {sanitize_untrusted(paper.abstract, 600)}",
                            provenance="retrieved", run_id=self.run_id, title=paper.title, source_ref=key,
                            tags=["abstract", "reviewer-requested"])
            self.log("review.citation_admitted", key=key, title=paper.title)
        composer.bib_path.write_text(bib_text, encoding="utf-8")

    def _injected_lesson_ids(self) -> set[str]:
        ids: set[str] = set()
        for manifest in (self.ws.stage_dir("write") / "context_manifests").glob("*.json"):
            data = json.loads(manifest.read_text(encoding="utf-8"))
            for row in data.get("included", []):
                if row.get("name") == "lessons":
                    ids.update(row.get("item_ids", []))
        return ids

    # -- S6 evolve -------------------------------------------------------
    async def stage_evolve(self) -> dict[str, Any]:
        ledger = FindingsLedger.from_dict(self.ws.load_json("ledger"))
        lessons = await distill_lessons(self.svc.planner, ledger)
        evo = dict(self.cfg.get("evolution") or {})
        policy = EvolutionPolicy(
            promote_after_runs=int(evo.get("promote_after_runs", 2)),
            promote_after_helped=int(evo.get("promote_after_helped", 1)),
            retire_after_misses=int(evo.get("retire_after_misses", 2)),
        )
        changes = update_lessons(
            self.memory,
            lessons,
            ledger=ledger,
            run_id=self.run_id,
            injected_ids=set(self.ws.meta("injected_lessons", [])),
            policy=policy,
        )
        self.ws.save_json("evolution", {"lessons": [lesson.model_dump() for lesson in lessons], "changes": changes}, stage="evolve")
        exported = export_evolutions(self.memory, self.ws.stage_dir("evolve"))
        if self.skill_export_dir is not None:
            export_evolutions(self.memory, self.skill_export_dir)
        active = sum(1 for c in changes if c["status"] == "active")
        return {"lessons": len(lessons), "active": active, "evolutions_json": str(exported)}

    # -- S7 package ------------------------------------------------------
    async def stage_package(self) -> dict[str, Any]:
        gates = self.ws.load_json("gates")
        if self.ws.latest("paper_pdf") is None:
            raise StageError("no compiled paper to package")
        if not gates.get("passed") and not self.allow_gate_failures:
            blockers = [f for f in gates.get("findings", []) if f["severity"] == "blocker"]
            raise StageError(
                f"{len(blockers)} gate blocker(s) remain; refusing to package an unverified paper. First: "
                + "; ".join(f"{b['gate']}/{b['section']}: {b['message']}" for b in blockers[:3])
                + ". Rerun review, fix by hand, or pass --allow-gate-failures to package it marked UNVERIFIED."
            )
        out = self.ws.stage_dir("package")
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        pdf = out / "paper.pdf"
        shutil.copy2(self.ws.latest_path("paper_pdf"), pdf)
        shutil.copytree(self.ws.latest_path("paper_source"), out / "paper_source")
        shutil.copy2(self.ws.latest_path("ledger"), out / "review_ledger.json")
        shutil.copy2(self.ws.latest_path("gates"), out / "gates.json")
        drift = self.ws.verify_provenance()
        provenance = {
            "tyche_version": __version__,
            "run_id": self.run_id,
            "created_at": utcnow(),
            "config_digest": self.ws.state.get("config_digest"),
            "artifacts": [r.__dict__ for r in self.ws.records()],
            "drifted_artifacts": drift,
            "paper_pdf_sha256": sha256_file(pdf),
        }
        write_json_atomic(out / "provenance.json", provenance)
        report = self._run_report(gates)
        (out / "run_report.md").write_text(report, encoding="utf-8")
        return {"pdf": str(pdf), "verified": bool(gates.get("passed")), "drifted": len(drift)}

    def _run_report(self, gates: dict[str, Any]) -> str:
        state = self.ws.state
        rounds = self.ws.load_json("review_rounds") if self.ws.latest("review_rounds") else []
        self._flush_usage()
        usage = self.usage_summary()
        lines = [
            f"# Tyche run report: {self.run_id}",
            "",
            f"- Topic: {state.get('topic')}",
            f"- Direction: {state.get('direction')}",
            f"- Experiment engine: {self.ws.meta('experiment_engine')}"
            + (" (SYNTHETIC FIXTURE -- not a research result)" if self.ws.meta("synthetic") else ""),
            f"- Gates: {'PASSED' if gates.get('passed') else 'FAILED -- UNVERIFIED PAPER'}",
            f"- Main-text pages: {gates.get('stats', {}).get('main_pages')}",
            f"- Distinct citations: {gates.get('stats', {}).get('distinct_citations')}",
            "",
            "## Review rounds",
            "",
            "| round | accepted | composite | overall | blockers |",
            "|---|---|---|---|---|",
        ]
        for r in rounds:
            lines.append(f"| {r['round']} | {r['accepted']} | {r.get('composite')} | {r.get('overall')} | {r.get('blockers')} |")
        lines += [
            "",
            "The composite is Tyche's own unweighted mean over the seven Agentic-Reviewer dimensions. It is a "
            "relative signal between drafts, not a prediction of the paperreview.ai score.",
            "",
            "## Stages",
            "",
        ]
        for stage, row in state.get("stages", {}).items():
            lines.append(f"- {stage}: {row.get('status')}")
        lines += ["", "## Model usage", "", f"- Total: {usage['total']}"]
        for stage, row in usage["by_stage"].items():
            lines.append(f"- {stage}: {row}")
        if gates.get("findings"):
            lines += ["", "## Remaining gate findings", ""]
            for f in gates["findings"]:
                lines.append(f"- [{f['severity']}] {f['gate']}/{f['section']}: {f['message']}")
        return "\n".join(lines) + "\n"
