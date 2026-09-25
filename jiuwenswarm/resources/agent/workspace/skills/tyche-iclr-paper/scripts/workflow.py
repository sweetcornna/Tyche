"""Executable SwarmFlow workflow for tyche-iclr-paper.

Each phase delegates to the deterministic `tyche` CLI. Stage agents run one
command and report the run state; they never write paper content themselves.
"""
import json
import re
import shlex
from string import Template

from swarmflow import agent, human, log, phase

META = {
    "name": "tyche-iclr-paper",
    "description": "Staged Tyche pipeline that produces a verified ICLR-format short paper about LLM agents.",
    "whenToUse": "Reuse when a user wants an automatically generated ICLR short paper on agent context engineering, memory engines, or self-evolution.",
    "phases": [
        {"title": "Plan", "detail": "Create the run and the falsifiable research plan; optional human approval."},
        {"title": "Survey", "detail": "Retrieve, screen, and verify literature."},
        {"title": "Experiments", "detail": "Design, implement, execute, and reflect on experiments."},
        {"title": "Analysis", "detail": "Statistics, allowed-numbers registry, tables, and figures."},
        {"title": "Writing", "detail": "Draft the ICLR 2027 short paper section by section."},
        {"title": "Review", "detail": "Seven-dimension review panel, fidelity audit, and gated revisions."},
        {"title": "Package", "detail": "Evolve writing lessons and package the verified paper."},
    ],
}

STAGE_RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "stage": {"type": "string"},
        "status": {"type": "string"},
        "exit_code": {"type": "integer"},
        "detail": {"type": "string"},
    },
}

PLAN_DECISION_SCHEMA = {
    "type": "object",
    "properties": {
        "approve": {"type": "boolean"},
        "notes": {"type": "string"},
    },
}

DIRECTIONS = ("context_engineering", "memory_engine", "self_evolution")

STAGE_PROMPT = Template(
    """You are the executor for the $stage stage of a Tyche paper run.

Run exactly this shell command from the repository root (the directory that contains pyproject.toml), and wait for it to finish; it can take a long time:

$command

Rules:
- Do not edit, create, or delete any files, and do not run any other command except the state check below.
- After the command exits, read the file workspace/runs/$run_id/state.json and look at stages.$stage.
- If the command failed, copy the last error line it printed into detail.

Return ONLY a JSON object with fields: "stage" (the string $stage), "status" (the value of stages.$stage.status, or "failed" if the file is missing), "exit_code" (integer), "detail" (one short sentence).
"""
)

PLAN_REVIEW_PROMPT = Template(
    """Tyche drafted a research plan for run $run_id. Please review the file workspace/runs/$run_id/artifacts/plan_md (latest version) or ask the assistant to show it.

Approve to continue, or reject and write notes describing what the plan should change (for example: a different baseline, a narrower question, or a different experiment family).
"""
)


def parse_args(args):
    """Normalize args to dict. Swarmflow may pass a JSON string or a dict."""
    if isinstance(args, dict):
        return args
    if isinstance(args, str):
        try:
            return json.loads(args) if args.strip() else {}
        except json.JSONDecodeError:
            return {}
    return {}


def extract_json(text, fallback=None):
    """Return a dict from an agent result that may be a dict, JSON text, or prose with JSON."""
    fallback_value = {} if fallback is None else fallback
    if isinstance(text, dict):
        return text
    if not isinstance(text, str):
        return fallback_value
    try:
        parsed = json.loads(text.strip())
        return parsed if isinstance(parsed, dict) else fallback_value
    except (json.JSONDecodeError, ValueError):
        pass
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, dict) else fallback_value
        except (json.JSONDecodeError, ValueError):
            return fallback_value
    return fallback_value


def safe_get(obj, key, default=""):
    if isinstance(obj, dict):
        value = obj.get(key, default)
        return default if value is None else value
    return default


def slug(text):
    cleaned = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return cleaned[:32].rstrip("-") or "paper"


def stage_command(run_id, stop_after, extra=""):
    base = "tyche run --resume --run-id " + shlex.quote(run_id) + " --stop-after " + stop_after
    return base + (" " + extra if extra else "")


def build_stage_prompt(stage, command, run_id):
    return STAGE_PROMPT.substitute(stage=stage, command=command, run_id=run_id)


def stage_ok(result, stage):
    return safe_get(result, "status", "failed") == "done" and safe_get(result, "stage", stage) == stage


async def run(args):
    args = parse_args(args)
    topic = str(safe_get(args, "topic", "")).strip()
    direction = str(safe_get(args, "direction", "memory_engine"))
    if not topic or direction not in DIRECTIONS:
        log("tyche-iclr-paper needs a topic and a direction in: " + ", ".join(DIRECTIONS))
        return {"status": "degraded", "reason": "missing topic or invalid direction"}
    run_id = str(safe_get(args, "run_id", "")) or "swarm-" + slug(topic)
    engine = str(safe_get(args, "engine", "openjiuwen"))
    engine_flag = ""
    if engine == "imported":
        engine_flag = "--engine imported --results-dir " + shlex.quote(str(safe_get(args, "results_dir", "")))
    results = []

    phase("Plan")
    create = (
        "tyche run --topic " + shlex.quote(topic) + " --direction " + direction + " --run-id "
        + shlex.quote(run_id) + " --stop-after plan " + engine_flag
    ).strip()
    raw = await agent(build_stage_prompt("plan", create, run_id), label="plan", phase="Plan", schema=STAGE_RESULT_SCHEMA)
    result = extract_json(raw, fallback={"stage": "plan", "status": "failed"})
    results.append(result)
    if not stage_ok(result, "plan"):
        log("Plan stage failed: " + str(safe_get(result, "detail", "no detail")))
        return {"status": "failed", "run_id": run_id, "stages": results}
    if bool(safe_get(args, "review_plan", False)):
        decision = await human(
            PLAN_REVIEW_PROMPT.substitute(run_id=run_id), schema=PLAN_DECISION_SCHEMA, label="plan-approval", phase="Plan"
        )
        decision = extract_json(decision, fallback={"approve": True, "notes": ""})
        notes = str(safe_get(decision, "notes", "")).strip()
        if not safe_get(decision, "approve", True) and notes:
            replan = stage_command(run_id, "plan", "--stage plan --notes " + shlex.quote(notes))
            raw = await agent(build_stage_prompt("plan", replan, run_id), label="replan", phase="Plan", schema=STAGE_RESULT_SCHEMA)
            result = extract_json(raw, fallback={"stage": "plan", "status": "failed"})
            results.append(result)
            if not stage_ok(result, "plan"):
                return {"status": "failed", "run_id": run_id, "stages": results}

    phase("Survey")
    raw = await agent(
        build_stage_prompt("survey", stage_command(run_id, "survey"), run_id), label="survey", phase="Survey",
        schema=STAGE_RESULT_SCHEMA,
    )
    result = extract_json(raw, fallback={"stage": "survey", "status": "failed"})
    results.append(result)
    if not stage_ok(result, "survey"):
        return {"status": "failed", "run_id": run_id, "stages": results}

    phase("Experiments")
    raw = await agent(
        build_stage_prompt("experiments", stage_command(run_id, "experiments", engine_flag), run_id),
        label="experiments", phase="Experiments", schema=STAGE_RESULT_SCHEMA,
    )
    result = extract_json(raw, fallback={"stage": "experiments", "status": "failed"})
    results.append(result)
    if not stage_ok(result, "experiments"):
        return {"status": "failed", "run_id": run_id, "stages": results}

    phase("Analysis")
    raw = await agent(
        build_stage_prompt("analysis", stage_command(run_id, "analysis"), run_id), label="analysis", phase="Analysis",
        schema=STAGE_RESULT_SCHEMA,
    )
    result = extract_json(raw, fallback={"stage": "analysis", "status": "failed"})
    results.append(result)
    if not stage_ok(result, "analysis"):
        return {"status": "failed", "run_id": run_id, "stages": results}

    phase("Writing")
    raw = await agent(
        build_stage_prompt("write", stage_command(run_id, "write"), run_id), label="write", phase="Writing",
        schema=STAGE_RESULT_SCHEMA,
    )
    result = extract_json(raw, fallback={"stage": "write", "status": "failed"})
    results.append(result)
    if not stage_ok(result, "write"):
        return {"status": "failed", "run_id": run_id, "stages": results}

    phase("Review")
    raw = await agent(
        build_stage_prompt("review", stage_command(run_id, "review"), run_id), label="review", phase="Review",
        schema=STAGE_RESULT_SCHEMA,
    )
    result = extract_json(raw, fallback={"stage": "review", "status": "failed"})
    results.append(result)
    if not stage_ok(result, "review"):
        return {"status": "failed", "run_id": run_id, "stages": results}

    phase("Package")
    raw = await agent(
        build_stage_prompt("package", stage_command(run_id, "package"), run_id), label="package", phase="Package",
        schema=STAGE_RESULT_SCHEMA,
    )
    result = extract_json(raw, fallback={"stage": "package", "status": "failed"})
    results.append(result)
    status = "complete" if stage_ok(result, "package") else "failed"
    log("Tyche run " + run_id + " finished with status " + status)
    return {
        "status": status,
        "run_id": run_id,
        "paper": "workspace/runs/" + run_id + "/package/paper.pdf",
        "stages": results,
    }
