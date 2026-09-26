import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from pydantic import BaseModel

from tyche.config import TycheConfig
from tyche.llm import LLMError, OpenJiuwenLLM, ScriptedLLM, UsageMeter, complete_json, extract_json, extract_latex


class Answer(BaseModel):
    value: int


def test_extract_json_handles_fences_prose_and_repairs():
    assert extract_json('```json\n{"value": 1}\n```') == {"value": 1}
    assert extract_json('Sure! {"value": 2} hope that helps') == {"value": 2}
    assert extract_json("{'value': 3,}") == {"value": 3}
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_extract_latex_prefers_tags():
    assert extract_latex("x <latex>\nA\n</latex> y") == "A"
    assert extract_latex("```latex\nB\n```") == "B"
    assert extract_latex("plain") == "plain"


async def test_complete_json_retries_with_validation_error():
    replies = iter(['{"value": "not a number"}', '{"value": 7}'])
    llm = ScriptedLLM({"ask": lambda s, u: next(replies)})
    result = await complete_json(llm, system="s", user="u", schema=Answer, purpose="ask")
    assert result.value == 7
    assert [c[0] for c in llm.calls] == ["ask", "ask:retry"]
    assert "rejected by the validator" in llm.calls[1][2]


async def test_complete_json_gives_up_loudly():
    llm = ScriptedLLM({"ask": lambda s, u: "nothing"})
    with pytest.raises(LLMError):
        await complete_json(llm, system="s", user="u", schema=Answer, purpose="ask", retries=1)


def test_scripted_llm_rejects_unknown_purposes():
    llm = ScriptedLLM({"write": lambda s, u: "x"})
    assert llm._handler("write:method")
    with pytest.raises(LLMError):
        llm._handler("review:rigor")


def test_missing_api_key_fails_before_any_request(monkeypatch):
    monkeypatch.delenv("API_KEY", raising=False)
    with pytest.raises(LLMError, match="API_KEY"):
        OpenJiuwenLLM(TycheConfig.load(env={}).model("writer"))


@pytest.fixture
def openai_compatible_server():
    seen = {}

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - http.server API
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            seen["body"] = json.loads(raw)
            seen["auth"] = self.headers.get("Authorization")
            seen.setdefault("bodies", []).append(seen["body"])
            seen.setdefault("headers", []).append(dict(self.headers))
            refused = seen.get("refuse")
            if refused and refused.encode() in raw:
                # How a strict OpenAI-compatible endpoint answers an unknown request field.
                error = json.dumps({"error": {"message": f"Unrecognized request argument supplied: {refused}",
                                              "type": "invalid_request_error"}}).encode()
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(error)))
                self.end_headers()
                self.wfile.write(error)
                return
            payload = json.dumps({
                "id": "c1", "object": "chat.completion", "created": 0, "model": seen["body"]["model"],
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": '{"value": 42}'}}],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 5,
                    "total_tokens": 17,
                    # DeepSeek's context-cache fields.
                    "prompt_cache_hit_tokens": 8,
                    "prompt_cache_miss_tokens": 4,
                },
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1", seen
    server.shutdown()
    server.server_close()


async def test_openjiuwen_client_round_trip(openai_compatible_server, monkeypatch):
    base, seen = openai_compatible_server
    monkeypatch.setenv("API_KEY", "sk-local-test")
    config = TycheConfig.load(env={"API_BASE": base, "MODEL_NAME": "mock-model"})
    meter = UsageMeter()
    meter.stage = "plan"
    llm = OpenJiuwenLLM(config.model("planner"), meter=meter)
    result = await complete_json(llm, system="sys", user="usr", schema=Answer, purpose="plan")
    assert result.value == 42
    assert seen["body"]["model"] == "mock-model"
    assert [m["role"] for m in seen["body"]["messages"]] == ["system", "user"]
    assert seen["auth"] == "Bearer sk-local-test"
    row = meter.summary()["by_stage"]["plan"]
    assert {k: row[k] for k in ("calls", "input_tokens", "cached_input_tokens", "cache_write_tokens",
                                "output_tokens", "uncached_input_tokens", "cache_hit_rate",
                                "calls_without_cache_report", "cache_breaks")} == {
        "calls": 1,
        "input_tokens": 12,
        "cached_input_tokens": 8,
        "cache_write_tokens": 0,
        "output_tokens": 5,
        "uncached_input_tokens": 4,
        "cache_hit_rate": 0.667,
        "calls_without_cache_report": 0,
        "cache_breaks": 0,
    }
    # A local endpoint gets the self-hosted profile: no hints, plain string messages.
    assert llm.profile.name == "self_hosted"
    assert "prompt_cache_key" not in seen["body"]
    # The schema instruction is part of the (cacheable) system prompt, not the user text.
    system, user = (m["content"] for m in seen["body"]["messages"])
    assert "JSON schema" in system and user == "usr"


def _client(base, monkeypatch, **model):
    from tyche.llm import OpenJiuwenLLM as Client

    monkeypatch.setenv("API_KEY", "sk-local-test")
    config = TycheConfig.load(
        overrides=[{"models": {"default": model}}], env={"API_BASE": base, "MODEL_NAME": "mock-model"}
    )
    meter = UsageMeter()
    return Client(config.model("writer"), meter=meter), meter


async def test_openai_profile_sends_a_prompt_cache_key_per_shared_prefix(openai_compatible_server, monkeypatch):
    base, seen = openai_compatible_server
    llm, _ = _client(base, monkeypatch, cache="openai", cache_retention="24h")
    await llm.complete(system="shared system", user="one", purpose="a")
    await llm.complete(system="shared system", user="two", purpose="b")
    await llm.complete(system="another system", user="three", purpose="c")
    keys = [b["prompt_cache_key"] for b in seen["bodies"]]
    assert keys[0] == keys[1] != keys[2]
    assert all(b["prompt_cache_retention"] == "24h" for b in seen["bodies"])
    assert all(isinstance(m["content"], str) for b in seen["bodies"] for m in b["messages"])


async def test_explicit_profile_marks_a_conversation_and_keeps_replies_plain(openai_compatible_server, monkeypatch):
    from tyche.llm import Conversation

    base, seen = openai_compatible_server
    llm, meter = _client(base, monkeypatch, cache="explicit")
    convo = Conversation(system="shared system " * 20)
    await convo.ask(llm, "first question", purpose="t1")
    await convo.ask(llm, "second question", purpose="t2")
    first, second = seen["bodies"]
    assert [isinstance(m["content"], list) for m in first["messages"]] == [True, True]
    assert [m["role"] for m in second["messages"]] == ["system", "user", "assistant", "user"]
    assert [isinstance(m["content"], list) for m in second["messages"]] == [True, True, False, True]
    assert second["messages"][1]["content"][0]["cache_control"] == {"type": "ephemeral"}
    total = meter.summary()["total"]
    assert total["cache_breaks"] == 0 and total["prefix_reuse_rate"] > 0


async def test_refused_cache_markers_fall_back_to_plain_requests(openai_compatible_server, monkeypatch):
    base, seen = openai_compatible_server
    seen["refuse"] = "cache_control"
    llm, meter = _client(base, monkeypatch, cache="explicit")
    reply = await llm.complete(system="s " * 50, user="u", purpose="a")
    assert reply.text == '{"value": 42}'
    assert llm.hints_enabled is False
    refused, retried = seen["bodies"]
    assert isinstance(refused["messages"][0]["content"], list)
    assert all(isinstance(m["content"], str) for m in retried["messages"])
    await llm.complete(system="s " * 50, user="v", purpose="b")
    assert len(seen["bodies"]) == 3 and "cache_control" not in json.dumps(seen["bodies"][2])
    assert meter.summary()["total"]["calls"] == 2


async def test_refused_routing_key_is_dropped_from_every_later_request(openai_compatible_server, monkeypatch):
    base, seen = openai_compatible_server
    seen["refuse"] = "prompt_cache_key"
    llm, _ = _client(base, monkeypatch, cache="openai")
    await llm.complete(system="s", user="u", purpose="a")
    await llm.complete(system="s", user="v", purpose="b")
    assert "prompt_cache_key" in seen["bodies"][0]
    # The per-role key was part of the model's configuration; it is rebuilt without it.
    assert all("prompt_cache_key" not in b for b in seen["bodies"][1:])


async def test_other_bad_requests_are_not_retried(openai_compatible_server, monkeypatch):
    base, seen = openai_compatible_server
    seen["refuse"] = "mock-model"
    llm, _ = _client(base, monkeypatch, cache="explicit")
    with pytest.raises(Exception):
        await llm.complete(system="s " * 50, user="u", purpose="a")
    assert len(seen["bodies"]) == 1 and llm.hints_enabled is True


async def test_xai_profile_routes_with_a_conversation_header(openai_compatible_server, monkeypatch):
    base, seen = openai_compatible_server
    llm, _ = _client(base, monkeypatch, cache="xai")
    await llm.complete(system="s", user="u", purpose="a")
    headers = {k.lower(): v for k, v in seen["headers"][0].items()}
    assert headers["x-grok-conv-id"].startswith("tyche-")


async def test_requests_tyche_does_not_build_carry_the_per_role_key(openai_compatible_server, monkeypatch):
    """openjiuwen's experiment agents call the shared Model directly; they get the role's key."""
    from tyche import cache

    base, seen = openai_compatible_server
    llm, _ = _client(base, monkeypatch, cache="openai")
    await llm.openjiuwen_model.invoke([{"role": "user", "content": "agent turn"}])
    assert seen["body"]["prompt_cache_key"] == cache.routing_key(llm.route, "writer")
