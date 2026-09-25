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
        score = 7 if "empirical rigor" in system else 5
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
