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
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen["auth"] = self.headers.get("Authorization")
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
    assert meter.summary()["by_stage"]["plan"] == {
        "calls": 1,
        "input_tokens": 12,
        "cached_input_tokens": 8,
        "output_tokens": 5,
        "uncached_input_tokens": 4,
        "cache_hit_rate": 0.667,
    }
    # The schema instruction is part of the (cacheable) system prompt, not the user text.
    system, user = (m["content"] for m in seen["body"]["messages"])
    assert "JSON schema" in system and user == "usr"
