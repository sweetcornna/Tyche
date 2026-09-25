import json

from tyche.evolution import EvolutionPolicy, Lesson, export_evolutions, update_lessons
from tyche.review import FindingsLedger


def _ledger(accepted: bool, delta: float) -> FindingsLedger:
    ledger = FindingsLedger()
    entry = ledger.add({"source": "rigor", "severity": "major", "section": "analysis", "problem": "overclaim",
                        "quote": "q", "fix": "f", "close_criterion": "c", "dimension": "claims_supported"}, round_no=0)
    ledger.mark_revision([entry.id], accepted=accepted, score_delta=delta, round_no=1)
    return ledger


def test_lessons_are_promoted_only_after_recurring_and_helping(memory):
    policy = EvolutionPolicy(promote_after_runs=2, promote_after_helped=1, retire_after_misses=2)
    lesson = Lesson(category="Overclaiming Results", lesson="Narrow claims.", sections=["analysis"], finding_ids=["F001"])
    first = update_lessons(memory, [lesson], ledger=_ledger(True, 0.4), run_id="r1", injected_ids=set(), policy=policy)
    assert first[0]["status"] == "candidate"
    second = update_lessons(memory, [lesson], ledger=_ledger(True, 0.2), run_id="r2", injected_ids=set(), policy=policy)
    assert second[0]["status"] == "active"
    [item] = memory.list(kinds=["lesson"], scopes=["global"])
    assert item.meta["category"] == "overclaiming_results" and item.meta["helped"] == 2


def test_active_lessons_retire_when_they_stop_helping(memory):
    policy = EvolutionPolicy(promote_after_runs=1, promote_after_helped=1, retire_after_misses=2)
    lesson = Lesson(category="vague_claims", lesson="Be specific.", finding_ids=["F001"])
    update_lessons(memory, [lesson], ledger=_ledger(True, 0.1), run_id="r1", injected_ids=set(), policy=policy)
    [item] = memory.list(kinds=["lesson"], scopes=["global"])
    assert item.meta["status"] == "active"
    for run in ("r2", "r3"):
        update_lessons(memory, [lesson], ledger=_ledger(False, -0.3), run_id=run, injected_ids={item.id}, policy=policy)
    [item] = memory.list(kinds=["lesson"], scopes=["global"])
    assert item.meta["status"] == "retired"


def test_export_uses_jiuwenswarm_evolution_format(memory, tmp_path):
    memory.add("lesson", "Report CIs.", provenance="inferred", scope="global",
               meta={"category": "ci", "status": "active", "helped": 2, "support_runs": ["a", "b"]})
    memory.add("lesson", "Candidate only.", provenance="inferred", scope="global", meta={"status": "candidate"})
    path = export_evolutions(memory, tmp_path / "skill")
    from openjiuwen.agent_evolving.checkpointing.types import EvolutionLog

    log = EvolutionLog.from_dict(json.loads(path.read_text()))
    assert log.skill_id == "tyche-paper"
    assert [e.change.content for e in log.entries] == ["Report CIs."]
    assert log.entries[0].change.section == "Instructions"


def test_rerunning_evolve_for_the_same_run_does_not_double_count(memory):
    policy = EvolutionPolicy(promote_after_runs=2, promote_after_helped=1, retire_after_misses=2)
    lesson = Lesson(category="x", lesson="Do x.", finding_ids=["F001"])
    for _ in range(3):
        update_lessons(memory, [lesson], ledger=_ledger(True, 0.2), run_id="r1", injected_ids=set(), policy=policy)
    [item] = memory.list(kinds=["lesson"], scopes=["global"])
    assert item.meta["helped"] == 1 and item.meta["support_runs"] == ["r1"] and item.meta["status"] == "candidate"


def test_export_keeps_other_evolution_records(memory, tmp_path):
    from openjiuwen.agent_evolving.checkpointing.types import EvolutionLog, EvolutionPatch, EvolutionRecord

    skill = tmp_path / "skill"
    skill.mkdir()
    foreign = EvolutionLog.empty("tyche-paper")
    foreign.entries.append(EvolutionRecord.make("user", "ctx", EvolutionPatch(section="Instructions", action="append",
                                                                               content="Human note.")))
    (skill / "evolutions.json").write_text(json.dumps(foreign.to_dict()))
    memory.add("lesson", "Report CIs.", provenance="inferred", scope="global",
               meta={"category": "ci", "status": "active", "helped": 1, "support_runs": ["a", "b"]})
    export_evolutions(memory, skill)
    export_evolutions(memory, skill)  # idempotent
    log = EvolutionLog.from_dict(json.loads((skill / "evolutions.json").read_text()))
    assert sorted(e.change.content for e in log.entries) == ["Human note.", "Report CIs."]
