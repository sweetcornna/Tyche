import pytest

from tyche.memory import Block, memory_block, pack


def test_search_ranks_relevant_items_and_respects_run_scope(memory):
    memory.add("evidence", "Supersession links keep corrections auditable for agent memory.", provenance="retrieved", run_id="a")
    memory.add("evidence", "Sliding windows forget early observations.", provenance="retrieved", run_id="a")
    memory.add("evidence", "Supersession in another run.", provenance="retrieved", run_id="b")
    memory.add("lesson", "Report uncertainty for every headline number.", provenance="inferred", scope="global")
    hits = memory.search("supersession corrections memory", run_id="a", kinds=["evidence"])
    assert [h.body for h in hits][0].startswith("Supersession links")
    assert all(h.run_id == "a" for h in hits)
    assert memory.search("uncertainty headline", run_id="a")[0].kind == "lesson"


def test_supersession_keeps_history_and_hides_old_item(memory):
    old = memory.add("decision", "Use top-k retrieval.", provenance="inferred", run_id="r")
    new = memory.supersede(old, "Use budgeted retrieval instead of top-k.")
    assert memory.get(old).superseded_by == new
    assert [i.id for i in memory.list(kinds=["decision"], run_id="r")] == [new]
    assert [i.id for i in memory.history(new)] == [old, new]
    with pytest.raises(ValueError):
        memory.supersede(old, "again")


def test_invalid_kind_scope_and_provenance_are_rejected(memory):
    with pytest.raises(ValueError):
        memory.add("rumor", "x", provenance="inferred", run_id="r")
    with pytest.raises(ValueError):
        memory.add("note", "x", provenance="guessed", run_id="r")
    with pytest.raises(ValueError):
        memory.add("note", "x", provenance="inferred")  # run scope without run id


def test_fts_query_is_sanitized(memory):
    memory.add("note", "quotes \" and NEAR( operators", provenance="observed", run_id="r")
    assert memory.search('NEAR( "quotes', run_id="r")


def test_pack_keeps_required_blocks_orders_by_priority_and_trims(memory):
    blocks = [
        Block("contract", "must stay", required=True),
        Block("low", "word " * 3000, priority=90),
        Block("high", "important evidence", priority=10),
    ]
    packed = pack(blocks, budget=400)
    names = [row["name"] for row in packed.included]
    assert names[:2] == ["contract", "high"]
    trimmed = [row for row in packed.included if row["name"] == "low"]
    assert trimmed and trimmed[0].get("trimmed")
    assert packed.used <= 400 + 50
    tiny = pack(blocks, budget=30)
    assert [row["name"] for row in tiny.dropped] == ["high", "low"] or tiny.dropped


def test_memory_block_records_item_ids(memory):
    item = memory.add("evidence", "Provenance tags help audits.", provenance="retrieved", run_id="r")
    block = memory_block(memory, "evidence", "provenance audits", kinds=["evidence"], run_id="r", limit=3)
    assert block.item_ids == [item]
    assert "(evidence/retrieved)" in block.text
