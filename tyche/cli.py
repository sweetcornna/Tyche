"""Command-line interface: ``tyche run | status | review | doctor | lessons | selftest``."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from tyche import STAGES, __version__
from tyche.config import DIRECTIONS, ConfigError, TycheConfig, load_direction
from tyche.llm import LLMError
from tyche.workspace import StageError, Workspace, read_json, write_json_atomic


def _load_env_files() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:  # pragma: no cover - python-dotenv ships with openjiuwen
        return
    load_dotenv(Path.cwd() / ".env", override=False)
    load_dotenv(Path.home() / ".jiuwenswarm" / "config" / ".env", override=False)


def _config(args: argparse.Namespace, base: dict[str, Any] | None = None) -> TycheConfig:
    overrides: list[str | dict[str, Any]] = list(getattr(args, "set", None) or [])
    if getattr(args, "engine", None):
        overrides.append({"experiments": {"engine": args.engine}})
    if getattr(args, "results_dir", None):
        overrides.append({"experiments": {"results_dir": str(Path(args.results_dir).expanduser().resolve())}})
    if getattr(args, "workspace", None):
        overrides.append({"workspace": {"root": str(Path(args.workspace).expanduser().resolve())}})
    return TycheConfig.load(getattr(args, "config", None), overrides, base=base)


def build_services(config: TycheConfig):
    from tyche.experiments import ImportedEngine, OpenJiuwenEngine, fixture_engine
    from tyche.literature import build_clients
    from tyche.llm import OpenJiuwenLLM, UsageMeter
    from tyche.pipeline import Services

    meter = UsageMeter()
    specs = {role: config.model(role) for role in ("planner", "writer", "reviewer", "experiments")}
    planner = OpenJiuwenLLM(specs["planner"], meter=meter)
    writer = OpenJiuwenLLM(specs["writer"], meter=meter)
    reviewer = OpenJiuwenLLM(specs["reviewer"], meter=meter)
    root = config.workspace_root()
    http, searchers, verifier, s2 = build_clients(
        dict(config.get("literature") or {}), cache_path=root / "cache" / "http.sqlite", env=dict(os.environ)
    )
    engine_name = config.get("experiments.engine")
    if engine_name == "imported":
        results_dir = config.get("experiments.results_dir")
        engine = ImportedEngine(Path(results_dir) if results_dir else None)
    elif engine_name == "fixture":
        engine = fixture_engine()
    else:
        exp_llm = OpenJiuwenLLM(specs["experiments"], meter=meter)
        engine = OpenJiuwenEngine(exp_llm.openjiuwen_model, specs["experiments"], dict(config.get("experiments") or {}))
    names = sorted({s.model_name for s in specs.values()})
    services = Services(
        planner=planner, writer=writer, reviewer=reviewer, searchers=searchers, verifier=verifier, s2=s2,
        engine=engine, meter=meter, model_names=names,
    )
    return services, http


def _save_run_config(ws: Workspace, config: TycheConfig) -> None:
    """Persist the resolved configuration (no secrets: models name only their key variable)."""
    write_json_atomic(ws.run_dir / "config.json", config.data)


async def _cmd_run(args: argparse.Namespace) -> int:
    from tyche.memory import MemoryStore
    from tyche.pipeline import Pipeline

    config = _config(args)
    root = config.workspace_root()
    exists = bool(args.run_id) and (root / "runs" / str(args.run_id) / "state.json").exists()
    if args.resume or (args.resume_if_exists and exists):
        if not args.run_id:
            raise ConfigError("--resume needs --run-id")
        ws = Workspace.open(root, args.run_id)
        topic, direction = ws.state["topic"], ws.state["direction"]
        if (args.topic and args.topic != topic) or (args.direction and args.direction != direction):
            raise ConfigError(f"run {args.run_id!r} already exists with a different topic or direction")
        saved = read_json(ws.run_dir / "config.json")
        # A resumed run keeps its own configuration; flags given now are layered on top and saved.
        config = _config(args, base=saved)
        if saved != config.data:
            _save_run_config(ws, config)
            ws.event("config.updated", digest=config.digest())
        services, http = build_services(config)
        if args.stage:
            ws.reset_from(args.stage)
    else:
        if not args.topic or not args.direction:
            raise ConfigError("a new run needs --topic and --direction")
        from datetime import datetime, timezone

        from tyche.textutil import slugify

        run_id = args.run_id or f"{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{slugify(args.topic, 32)}"
        topic, direction = args.topic, args.direction
        load_direction(direction)
        # Build services first so missing credentials fail before an empty run directory is created.
        services, http = build_services(config)
        ws = Workspace.create(root, run_id, topic=topic, direction=direction, config_digest=config.digest())
        _save_run_config(ws, config)
    notes = ""
    if args.notes:
        path = Path(args.notes)
        notes = path.read_text(encoding="utf-8") if path.exists() else args.notes
    memory = MemoryStore(root / "memory.db")
    skill_dir = Path(args.export_skill_dir).expanduser() if args.export_skill_dir else None
    pipeline = Pipeline(
        config,
        ws,
        services,
        memory,
        load_direction(direction),
        allow_gate_failures=args.allow_gate_failures,
        operator_notes=notes,
        skill_export_dir=skill_dir,
    )
    try:
        await pipeline.run(stop_after=args.stop_after, only=args.stage)
    finally:
        await http.aclose()
        memory.close()
    print(f"[tyche] run {ws.run_id} at {ws.run_dir}")
    for name in ("paper.pdf", "paper_UNVERIFIED.pdf"):
        package = ws.run_dir / "package" / name
        if package.exists():
            print(f"[tyche] paper: {package}")
    return 0


def _cmd_status(args: argparse.Namespace) -> int:
    config = _config(args)
    root = config.workspace_root()
    if not args.run_id:
        runs = sorted((root / "runs").glob("*/state.json")) if (root / "runs").exists() else []
        for state_path in runs:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            done = [s for s, row in state.get("stages", {}).items() if row.get("status") == "done"]
            print(f"{state['run_id']}: {len(done)}/{len(STAGES)} stages done -- {state.get('topic', '')[:70]}")
        return 0
    ws = Workspace.open(root, args.run_id)
    print(json.dumps(ws.state, ensure_ascii=False, indent=2))
    return 0


async def _cmd_review(args: argparse.Namespace) -> int:
    from tyche.llm import OpenJiuwenLLM, UsageMeter
    from tyche.paper.latex import pdf_text
    from tyche.review import ReviewPanel

    config = _config(args)
    text = pdf_text(Path(args.pdf))
    if not text.strip():
        raise ConfigError(f"could not extract text from {args.pdf}")
    meter = UsageMeter()
    panel = ReviewPanel(
        OpenJiuwenLLM(config.model("reviewer"), meter=meter),
        reviewers=list(config.get("review.reviewers") or ["rigor", "positioning", "clarity"]),
        samples=int(config.get("review.samples_per_reviewer", 1)),
        budget=int(config.get("memory.context_budgets.review", 24000)),
        auditor=False,
    )
    result = await panel.review(
        paper_text=text, sections={}, uncited_related=[], prior_findings=[], results_brief="", cited_evidence={}
    )
    out = result.to_dict() | {"usage": meter.summary()}
    if args.out:
        Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"composite (Tyche, unweighted 7-dimension mean): {result.composite}")
    print(f"overall (mean ICLR rating): {result.overall_mean}")
    for dim, value in result.dimension_means.items():
        print(f"  {dim}: {value}")
    for f in result.findings:
        print(f"- [{f['severity']}] {f['section']}: {f['problem']}")
    return 0


async def _probe(url: str) -> str:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            response = await client.get(url)
        return f"reachable (HTTP {response.status_code})"
    except Exception as exc:  # noqa: BLE001 - report any failure mode
        return f"UNREACHABLE ({type(exc).__name__})"


async def _cmd_doctor(args: argparse.Namespace) -> int:
    from tyche.paper.latex import latex_available

    config = _config(args)
    problems = 0
    print(f"tyche {__version__}, python {sys.version.split()[0]}")
    try:
        import openjiuwen  # noqa: F401

        print("openjiuwen: importable")
    except Exception as exc:  # noqa: BLE001
        problems += 1
        print(f"openjiuwen: NOT importable ({exc})")
    for tool, path in latex_available().items():
        print(f"{tool}: {path or 'MISSING'}")
        problems += 0 if path else 1
    for role in ("planner", "writer", "reviewer", "experiments"):
        spec = config.model(role)
        has_key = bool(spec.api_key())
        problems += 0 if has_key else 1
        print(f"model[{role}]: {spec.model_name} via {spec.api_base} ({spec.provider}); "
              f"{spec.api_key_env} {'set' if has_key else 'NOT SET'}")
    probes = {
        "arXiv": "https://export.arxiv.org/api/query?search_query=all:agent&max_results=1",
        "Semantic Scholar": "https://api.semanticscholar.org/graph/v1/paper/search?query=agent&limit=1",
        "OpenAlex": "https://api.openalex.org/works?search=agent&per-page=1",
        "Crossref": "https://api.crossref.org/works?rows=1",
        "model endpoint": config.model("writer").api_base,
    }
    for name, url in probes.items():
        status = await _probe(url)
        problems += 0 if status.startswith("reachable") else 1
        print(f"{name}: {status}")
    if args.ping_model:
        from tyche.llm import OpenJiuwenLLM

        reply = await OpenJiuwenLLM(config.model("writer")).complete(
            system="Reply with the single word OK.", user="ping", purpose="doctor"
        )
        print(f"model ping: {reply.text.strip()[:40]!r} ({reply.input_tokens}+{reply.output_tokens} tokens)")
    print("doctor: OK" if problems == 0 else f"doctor: {problems} problem(s) found")
    return 0 if problems == 0 else 1


def _cmd_lessons(args: argparse.Namespace) -> int:
    from tyche.memory import MemoryStore

    config = _config(args)
    db = config.workspace_root() / "memory.db"
    if not db.exists():
        print("no memory database yet")
        return 0
    store = MemoryStore(db)
    for item in store.list(kinds=["lesson"], scopes=["global"]):
        meta = item.meta
        print(
            f"[{meta.get('status', '?'):9}] {meta.get('category', '')}: runs={len(meta.get('support_runs', []))} "
            f"helped={meta.get('helped', 0)} misses={meta.get('misses', 0)}\n    {item.body}"
        )
    store.close()
    return 0


async def _cmd_selftest(args: argparse.Namespace) -> int:
    from tyche.selftest import run_selftest

    try:
        summary = await run_selftest(Path(args.keep) if args.keep else None)
    except RuntimeError as exc:
        print(f"selftest: FAILED -- {exc}", file=sys.stderr)
        return 1
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("selftest: PASSED" if summary["ok"] else "selftest: FAILED")
    return 0 if summary["ok"] else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tyche", description="Evidence-bound ICLR short-paper agent on JiuwenSwarm")
    parser.add_argument("--version", action="version", version=f"tyche {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--config", help="YAML file merged over the packaged defaults")
        p.add_argument("--set", action="append", metavar="KEY=VALUE", help="override one setting, e.g. review.max_rounds=2")
        p.add_argument("--workspace", help="workspace root (default: $TYCHE_HOME or ./workspace)")

    run = sub.add_parser("run", help="run or resume the paper pipeline")
    common(run)
    run.add_argument("--topic", help="research topic, in any language")
    run.add_argument("--direction", choices=DIRECTIONS, help="topic direction preset")
    run.add_argument("--run-id")
    run.add_argument("--resume", action="store_true", help="continue an existing run from its first unfinished stage")
    run.add_argument(
        "--resume-if-exists",
        action="store_true",
        help="with --run-id: resume that run if it exists (topic and direction must match), otherwise create it",
    )
    run.add_argument("--stop-after", choices=STAGES, help="stop after this stage (inspect or edit, then --resume)")
    run.add_argument(
        "--stage", choices=STAGES, help="with --resume: rerun exactly this stage and mark every later stage pending"
    )
    run.add_argument("--engine", choices=["openjiuwen", "imported", "fixture"], help="experiment engine")
    run.add_argument("--results-dir", help="with --engine imported: directory of <variant>.metrics.json files")
    run.add_argument("--notes", help="operator notes (text or a file path) for the planner")
    run.add_argument("--allow-gate-failures", action="store_true", help="package even if gates fail (marked UNVERIFIED)")
    run.add_argument("--export-skill-dir", help="also write active lessons to this JiuwenSwarm skill directory")

    status = sub.add_parser("status", help="list runs or show one run's state")
    common(status)
    status.add_argument("--run-id")

    review = sub.add_parser("review", help="simulated 7-dimension review of any paper PDF")
    common(review)
    review.add_argument("pdf")
    review.add_argument("--out", help="write the full review JSON here")

    doctor = sub.add_parser("doctor", help="check toolchain, credentials, and network access")
    common(doctor)
    doctor.add_argument("--ping-model", action="store_true", help="also send one tiny model request")

    lessons = sub.add_parser("lessons", help="list cross-run writing lessons and their status")
    common(lessons)

    selftest = sub.add_parser("selftest", help="offline end-to-end test with scripted models and fixtures")
    selftest.add_argument("--keep", help="copy the selftest PDF and report to this directory")
    return parser


def main(argv: list[str] | None = None) -> int:
    _load_env_files()
    args = build_parser().parse_args(argv)
    try:
        if args.command == "run":
            return asyncio.run(_cmd_run(args))
        if args.command == "status":
            return _cmd_status(args)
        if args.command == "review":
            return asyncio.run(_cmd_review(args))
        if args.command == "doctor":
            return asyncio.run(_cmd_doctor(args))
        if args.command == "lessons":
            return _cmd_lessons(args)
        if args.command == "selftest":
            return asyncio.run(_cmd_selftest(args))
    except (ConfigError, StageError, LLMError) as exc:
        print(f"[tyche] error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - one readable line; TYCHE_DEBUG=1 shows the traceback
        if os.environ.get("TYCHE_DEBUG"):
            raise
        print(f"[tyche] error: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("[tyche] the failed stage is recorded; fix the cause and rerun with --resume", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
