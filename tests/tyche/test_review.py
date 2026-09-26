import json

from tyche.llm import ScriptedLLM
from tyche.review import FindingsLedger, ReviewPanel, gate_findings_as_review
from tyche.review.panel import ReviewFinding, normalize_findings


def _finding(**kw):
    base = dict(section="analysis", severity="major", dimension="claims_supported",
                quote="the gains concentrate on questions", problem="Overclaims the mechanism.",
                fix="Narrow it.", close_criterion="Claim narrowed.", source="rigor")
    base.update(kw)
    return base


def test_unverified_quotes_are_downgraded_or_dropped():
    paper = "the gains concentrate on questions whose answer changed"
    squashed = "".join(ch for ch in paper.lower() if ch.isalnum())
    raw = [
        ReviewFinding(**{k: v for k, v in _finding().items() if k != "source"}),
        ReviewFinding(**{k: v for k, v in _finding(quote="text that is not in the paper at all", severity="major").items() if k != "source"}),
        ReviewFinding(**{k: v for k, v in _finding(quote="also not present in the paper body", severity="minor").items() if k != "source"}),
    ]
    kept, dropped = normalize_findings(raw, "rigor", squashed)
    assert [f["severity"] for f in kept] == ["major", "minor"]
    assert kept[0]["quote_verified"] and not kept[1]["quote_verified"]
    assert dropped == 1


def test_ledger_reflags_rulings_and_cap():
    ledger = FindingsLedger(reflag_cap=1)
    entry = ledger.add(_finding(), round_no=0)
    again = ledger.add(_finding(problem="Overclaims the mechanism strongly."), round_no=1)
    assert again.id == entry.id and entry.reflags == 1
    ledger.add(_finding(), round_no=2)
    assert entry.status == "unaddressed"
    other = ledger.add(_finding(section="method", quote="different", problem="Missing notation."), round_no=2)
    ledger.record_responses([{"id": other.id, "action": "rebutted", "note": "defined in eq 1"}], 2)
    ledger.apply_rulings([{"id": other.id, "status": "wontfix_accepted", "reviewer": "rigor"}], 3)
    assert other.status == "wontfix" and other.response.startswith("rebutted")
    restored = FindingsLedger.from_dict(json.loads(json.dumps(ledger.to_dict())))
    assert restored.counts() == ledger.counts()


def test_gate_findings_open_and_close_automatically():
    ledger = FindingsLedger()
    gate = gate_findings_as_review([
        {"gate": "number", "severity": "blocker", "section": "experiments", "message": "number 83.5 unknown", "evidence": "83.5"},
        {"gate": "citation", "severity": "minor", "section": "introduction", "message": "removed", "evidence": ""},
    ])
    assert len(gate) == 1 and gate[0]["source"] == "gate:number"
    ledger.sync_gate_findings(gate, 0)
    assert [e.status for e in ledger.entries] == ["open"]
    ledger.sync_gate_findings([], 1)
    assert [e.status for e in ledger.entries] == ["resolved"]


async def test_panel_aggregates_seven_dimensions():
    def reviewer(system, user):
        score = 7 if "empirical rigor" in user else 5
        return json.dumps({
            "scores": {d: score for d in ("originality", "importance", "claims_supported", "experimental_soundness",
                                          "clarity", "community_value", "contextualization")},
            "overall": score, "confidence": 3, "summary": "s",
            "findings": [dict((k, v) for k, v in _finding().items() if k != "source")],
        })

    llm = ScriptedLLM({"review": reviewer, "review:auditor": lambda s, u: '{"findings": []}'})
    panel = ReviewPanel(llm, reviewers=["rigor", "positioning", "clarity"])
    result = await panel.review(
        paper_text="Intro. The gains concentrate on questions whose answer changed.", sections={"analysis": "x"},
        uncited_related=[], prior_findings=[], results_brief="", cited_evidence={},
    )
    assert result.composite == round((7 + 5 + 5) / 3, 3)
    assert set(result.dimension_means) == {
        "originality", "importance", "claims_supported", "experimental_soundness", "clarity", "community_value",
        "contextualization",
    }
    assert len(result.findings) == 3 and all(f["quote_verified"] for f in result.findings)
    assert [c[0] for c in llm.calls].count("review:auditor") == 1
    # Prompt-cache friendliness: the three personas share one system prompt (paper included),
    # and only the short user message with the lens differs.
    persona_calls = [c for c in llm.calls if c[0].startswith("review:") and c[0] != "review:auditor"]
    assert len({system for _, system, _ in persona_calls}) == 1
    # The auditor sends the identical system prompt (schemas travel in the user turn), so even an
    # explicit cache with its breakpoint at the end of the system prompt is shared.
    _, audit_system, audit_user = next(c for c in llm.calls if c[0] == "review:auditor")
    assert audit_system == persona_calls[0][1] and "The gains concentrate" in audit_system
    # It also gets the LaTeX, the only place where \citep keys match its evidence keys.
    assert "<paper_latex>\n%% analysis\nx\n</paper_latex>" in audit_user
    assert len({user for _, _, user in persona_calls}) == 3


def test_distinct_gate_findings_stay_separate_and_are_not_reflagged():
    ledger = FindingsLedger(reflag_cap=1)
    gate = gate_findings_as_review([
        {"gate": "number", "severity": "blocker", "section": "analysis", "message": f"number {n} does not match any "
         "computed result or setup value", "evidence": f"ctx {n}"} for n in ("0.83", "0.91", "12.5")
    ])
    for round_no in range(4):  # the gate keeps reporting the same three problems
        ledger.sync_gate_findings(gate, round_no)
    open_ids = [e.id for e in ledger.open()]
    assert len(open_ids) == 3
    assert all(e.reflags == 0 and e.status == "open" for e in ledger.entries)


def test_gate_sections_map_from_file_paths_and_page_limit_gets_shortening_fix():
    [compile_err, page] = gate_findings_as_review([
        {"gate": "compile", "severity": "blocker", "section": "sections/related_work.tex", "message": "LaTeX error"},
        {"gate": "structure", "severity": "blocker", "section": "main", "message": "main text is 7 pages; the limit is 5"},
    ])
    assert compile_err["section"] == "related_work"
    assert page["section"] == "general" and page["fix"].startswith("Shorten")


class _FakeWriter:
    async def revise(self, name, ctx, previous, current, findings):
        from tyche.paper.sanitize import SanitizeReport
        from tyche.paper.writer import SectionDraft

        return SectionDraft(name, current + " revised", SanitizeReport(), 3,
                            responses=[{"id": f["id"], "action": "fixed", "note": "done"} for f in findings])


class _FakeComposer:
    def __init__(self, builds):
        self.sections = {"analysis": "draft 0.83"}
        self.removed = {"analysis": []}
        self.title = "t"
        self.ctx = None
        self.writer = _FakeWriter()
        self._builds = iter(builds)

    async def build(self, build_dir):
        return next(self._builds)


def _build(compiled, blockers):
    from pathlib import Path

    from tyche.gates import GateFinding, GateReport
    from tyche.paper.compose import BuildResult
    from tyche.paper.latex import CompileResult

    findings = [GateFinding("number", "blocker", "analysis", f"number {n} does not match", f"ctx {n}") for n in blockers]
    if not compiled:
        findings.append(GateFinding("compile", "blocker", "sections/analysis.tex", "LaTeX error: Missing $", "line 3"))
    return BuildResult(Path("."), CompileResult(compiled, Path("p.pdf") if compiled else None, [], [], [], 0, 1),
                       GateReport(findings), 1, "The gains concentrate on questions whose answer changed.")


def _round(composite, findings=(), rulings=()):
    from tyche.review.panel import PanelRound

    return PanelRound({}, {}, composite, composite, list(findings), list(rulings))


async def test_rejected_revision_rolls_back_text_and_ledger(tmp_path):
    from tyche.review import RevisionLoop

    reviewer_finding = dict(section="analysis", severity="major", dimension="claims_supported", source="rigor",
                            quote="gains concentrate on questions", problem="Overclaims.", fix="Narrow.",
                            close_criterion="Narrowed.")
    reviews = iter([
        _round(6.0, [reviewer_finding]),
        _round(4.0, rulings=[{"id": "F002", "status": "resolved", "reviewer": "rigor"}]),  # worse: must be rejected
    ])

    async def review_fn(build, prior):
        return next(reviews)

    # Same blocker count, lower score: rejected. (A candidate that removes blockers is accepted;
    # see test_removing_gate_blockers_beats_a_higher_score.)
    composer = _FakeComposer([_build(True, ["0.83"]), _build(True, ["0.83"])])
    ledger = FindingsLedger()
    loop = RevisionLoop(composer, ledger, review_fn, out_dir=tmp_path, max_rounds=1, target=9.0, tolerance=0.15,
                        plateau_rounds=3, max_findings=8)
    result = await loop.run()
    assert result.rounds[1]["accepted"] is False
    assert composer.sections == {"analysis": "draft 0.83"}
    statuses = {e.id: e.status for e in ledger.entries}
    assert statuses == {"G001": "open", "F002": "open"}  # neither the gate fix nor the ruling survives rejection
    assert all(e.response == "" for e in ledger.entries)
    assert all(e.revision_accepted is False for e in ledger.entries)


async def test_compiling_candidate_beats_a_non_compiling_draft(tmp_path):
    from tyche.review import RevisionLoop

    async def review_fn(build, prior):
        return _round(5.0)

    # Round 0 does not compile (one compile blocker); the revision compiles but the now-visible
    # number gate reports two blockers. The compiling draft must still win.
    composer = _FakeComposer([_build(False, []), _build(True, ["1.5", "2.5"])])
    ledger = FindingsLedger()
    loop = RevisionLoop(composer, ledger, review_fn, out_dir=tmp_path, max_rounds=1, target=9.0, tolerance=0.15,
                        plateau_rounds=3, max_findings=8)
    result = await loop.run()
    assert result.rounds[1]["accepted"] is True and result.best.compile.ok
    assert [e.section for e in ledger.entries if e.source == "gate:compile"] == ["analysis"]


async def test_removing_gate_blockers_beats_a_higher_score(tmp_path):
    from tyche.review import RevisionLoop

    reviews = iter([_round(5.2), _round(4.4)])

    async def review_fn(build, prior):
        return next(reviews)

    # Round 0 scores higher but fails a gate and could never be packaged; the revision passes.
    composer = _FakeComposer([_build(True, ["0.25"]), _build(True, [])])
    loop = RevisionLoop(composer, FindingsLedger(), review_fn, out_dir=tmp_path, max_rounds=1, target=9.0,
                        tolerance=0.15, plateau_rounds=3, max_findings=8)
    result = await loop.run()
    assert result.rounds[1]["accepted"] is True
    assert result.best.gates.passed
