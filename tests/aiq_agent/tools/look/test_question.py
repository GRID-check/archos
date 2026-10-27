"""``look`` with a ``question``: a second reader's readings, and the text-only fallback (ADR-0128, V2).

The renderer, the budget and the canvas POST are the real ones; the model call
is a ``httpx.MockTransport`` behind ``limited_async_http_client``, so the
request body, the data policy, the span and the parsing are what a turn would
produce.
"""

from __future__ import annotations

import io
import json

import httpx
import knowledge_layer.llamaindex.adapter as llm_adapter
import knowledge_layer.view_image as view
import pypdfium2 as pdfium
import pytest
from aiq_agent_testing.canvas import DOCUMENT
from aiq_agent_testing.canvas import answering
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from aiq_agent.common import image_view_budget
from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.observability import direct_trace
from aiq_agent.tools.look import reading
from aiq_agent.tools.look.register import DESCRIPTION
from aiq_agent.tools.look.register import run_look

REPLY = {
    "readings": [
        {"text": "Raum 1.04: 4,25 m", "kind": "dimension", "confidence": "high"},
        {"text": "3 Türen", "kind": "count", "confidence": "medium"},
        {"text": "", "kind": "label", "confidence": "high"},
    ],
    "summary": "Ein Raum mit Maßkette.",
}


def _pdf() -> bytes:
    doc = pdfium.PdfDocument.new()
    doc.new_page(595, 842)
    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


@pytest.fixture
def sees(monkeypatch):
    """What ``turn_sees`` answers; a test sets ``sees['value']``."""
    state = {"value": True}

    async def turn_sees():
        return state["value"]

    monkeypatch.setattr(view, "turn_sees", turn_sees)
    return state


@pytest.fixture
def model(monkeypatch):
    """The vision model's endpoint: every request it receives is appended to ``requests``."""
    requests: list[dict] = []
    state: dict = {"reply": REPLY, "status": 200}

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        if state["status"] != 200:
            return httpx.Response(state["status"], json={"error": "no"})
        content = state["reply"] if isinstance(state["reply"], str) else json.dumps(state["reply"])
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 40, "completion_tokens": 20, "total_tokens": 60},
            },
        )

    real = reading.limited_async_http_client
    monkeypatch.setattr(
        reading, "limited_async_http_client", lambda **kw: real(inner=httpx.MockTransport(handler), **kw)
    )
    cred = ResolvedCredential(api_key="sk-vlm", base_url="https://vlm.test/v1", model="vision-1", source="test")
    monkeypatch.setattr(reading, "_vision_settings", lambda _org: cred)
    state["requests"] = requests
    return state


@pytest.fixture(autouse=True)
def stored(monkeypatch, calls):
    monkeypatch.setenv("AIQ_VIEW_IMAGES_ENABLED", "true")
    monkeypatch.setattr(llm_adapter, "_get_vlm_api_key", lambda: "sk-test")
    monkeypatch.setattr(view, "_find_pdf", lambda _name: None)

    async def locate(collection, file_name, organization_id=None, image_index=None):
        return ("key", None) if collection == "proj_1" else None

    monkeypatch.setattr(view, "_resolve_storage_location", locate)
    monkeypatch.setattr(view, "_fetch_seaweed_bytes", lambda *_: _pdf())
    answering(monkeypatch, calls, {"ok": True})
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)


@pytest.fixture
def exporter():
    direct_trace.reset_tracer_provider()
    memory = InMemorySpanExporter()
    direct_trace.install_tracer_provider(None, env={}, exporter=memory)
    yield memory
    direct_trace.reset_tracer_provider()


REGION = [0.1, 0.1, 0.3, 0.2]


class TestAQuestion:
    async def test_the_readings_come_back_with_the_image_and_say_they_are_a_reading(self, sees, model) -> None:
        result = await run_look(page=1, region=REGION, question="How long is room 1.04?")

        assert isinstance(result, list) and [block["type"] for block in result] == ["text", "image_url"]
        text = result[0]["text"]
        assert text.startswith("Region [x=0.100")
        assert "Gelesen: Raum 1.04: 4,25 m (dimension, high)" in text
        assert "Gelesen: 3 Türen (count, medium)" in text
        assert text.count("Gelesen:") == 2  # the reading without text is dropped
        assert "a reading of the drawing, not a measurement" in text
        assert "Say so if you see otherwise" in text

    async def test_the_crop_and_the_question_are_what_the_vision_model_receives(self, sees, model) -> None:
        await run_look(page=1, region=REGION, question="How long is room 1.04?")

        [request] = model["requests"]
        assert request["model"] == "vision-1"
        parts = request["messages"][0]["content"]
        assert {"type": "text", "text": "Question: How long is room 1.04?"} in parts
        image = next(part for part in parts if part["type"] == "image_url")
        assert image["image_url"]["url"].startswith("data:image/jpeg;base64,")

    async def test_a_question_costs_no_second_look(self, sees, model) -> None:
        token = image_view_budget.begin_image_view_budget()
        try:
            await run_look(page=1, region=REGION, question="What is this?")
            budget = image_view_budget.get_image_view_budget()
            assert budget is not None
            assert (budget.used, budget.regions_viewed) == (1, 1)
        finally:
            image_view_budget.end_image_view_budget(token)

    async def test_the_reading_is_booked_to_the_turns_usage_ledger(self, sees, model) -> None:
        """The callback path never sees this call, so the reading books itself: budgets and invoices count it."""
        from aiq_agent.common.cost_tracking import GridCostTracker
        from aiq_agent.common.cost_tracking import grid_cost_tracker_var

        tracker = GridCostTracker(organization_id="org_1")
        recorded: list = []
        tracker.record = recorded.append  # type: ignore[method-assign]
        token = grid_cost_tracker_var.set(tracker)
        try:
            await run_look(page=1, region=REGION, question="What is this?")
        finally:
            grid_cost_tracker_var.reset(token)

        [event] = recorded
        assert (event.role, event.model, event.prompt_tokens, event.completion_tokens) == (
            "look_reading",
            "vision-1",
            40,
            20,
        )
        assert event.cost_source == "missing"  # the reply carried no cost: counted, never invented

    async def test_without_a_question_nothing_is_asked_and_the_result_is_what_it_was(self, sees, model) -> None:
        result = await run_look(page=1, region=REGION)

        assert model["requests"] == []
        assert isinstance(result, list) and "Gelesen" not in result[0]["text"]
        assert [block["type"] for block in result] == ["text", "image_url"]

    async def test_a_refused_look_asks_nothing(self, sees, model) -> None:
        result = await run_look(page=1, region=[2, 2, 1, 1], question="What is this?")

        assert isinstance(result, str) and "Invalid region" in result
        assert model["requests"] == []

    async def test_a_reader_that_fails_leaves_the_look_intact(self, sees, model) -> None:
        model["status"] = 500

        result = await run_look(page=1, region=REGION, question="What is this?")

        assert isinstance(result, list) and result[1]["type"] == "image_url"
        assert "No reading was made" in result[0]["text"] and "Look at the image yourself" in result[0]["text"]

    async def test_a_reply_that_is_no_json_is_a_failure_sentence_not_an_exception(self, sees, model) -> None:
        model["reply"] = "I cannot help with that."

        result = await run_look(page=1, region=REGION, question="What is this?")

        assert isinstance(result, list) and "did not answer in the requested form" in result[0]["text"]

    def test_the_description_tells_the_model_when_to_ask(self) -> None:
        assert "`question`" in DESCRIPTION and "never a measurement" in DESCRIPTION


class TestATextOnlyModel:
    async def test_it_gets_the_readings_alone_and_never_an_image(self, sees, model) -> None:
        sees["value"] = False

        result = await run_look(page=1, region=REGION, question="How long is room 1.04?")

        assert isinstance(result, list) and [block["type"] for block in result] == ["text"]
        assert "Gelesen: Raum 1.04: 4,25 m" in result[0]["text"]
        assert "You cannot see the image" in result[0]["text"]

    async def test_without_a_question_the_default_question_is_put(self, sees, model) -> None:
        sees["value"] = False

        result = await run_look(page=1, region=REGION)

        [request] = model["requests"]
        assert reading.DEFAULT_QUESTION in json.dumps(request["messages"])
        assert isinstance(result, list) and len(result) == 1

    async def test_when_the_reader_fails_it_is_told_to_say_it_could_not_read(self, sees, model) -> None:
        sees["value"] = False
        model["status"] = 500

        result = await run_look(page=1, region=REGION)

        assert isinstance(result, list) and len(result) == 1
        assert "do not guess" in result[0]["text"]

    async def test_a_model_whose_vision_is_unknown_is_shown_the_image(self, sees, model) -> None:
        sees["value"] = None

        result = await run_look(page=1, region=REGION, question="What is this?")

        assert isinstance(result, list) and result[1]["type"] == "image_url"


class TestTheGeneration:
    async def test_the_reading_is_a_look_reading_generation_without_the_pixels(self, sees, model, exporter) -> None:
        await run_look(page=1, region=REGION, question="How long is room 1.04?")

        direct_trace._provider.force_flush()
        (span,) = [s for s in exporter.get_finished_spans() if s.name == "look-reading"]
        assert span.attributes["langfuse.observation.type"] == "generation"
        assert span.attributes["gen_ai.usage.input_tokens"] == 40
        recorded = span.attributes["langfuse.observation.input"]
        assert "How long is room 1.04?" in recorded
        assert "base64" not in recorded and "[image," in recorded

    async def test_a_failed_reading_is_an_error_generation(self, sees, model, exporter) -> None:
        model["status"] = 500

        await run_look(page=1, region=REGION, question="What is this?")

        direct_trace._provider.force_flush()
        (span,) = [s for s in exporter.get_finished_spans() if s.name == "look-reading"]
        assert span.attributes["langfuse.observation.level"] == "ERROR"


class TestParsing:
    def test_a_reading_is_capped_and_its_labels_are_closed_vocabularies(self) -> None:
        data = {
            "readings": [{"text": "x" * 900, "kind": "mystery", "confidence": "certain"}]
            + [{"text": f"r{i}", "kind": "label", "confidence": "high"} for i in range(20)],
            "summary": "s" * 900,
        }

        parsed = reading.parse_reading(data)

        assert len(parsed.lines) == reading.MAX_READINGS
        assert len(parsed.lines[0].text) == reading.MAX_READING_CHARS
        assert (parsed.lines[0].kind, parsed.lines[0].confidence) == ("other", "low")
        assert len(parsed.summary) == reading.MAX_SUMMARY_CHARS

    async def test_no_vision_key_is_a_sentence(self, monkeypatch) -> None:
        cred = ResolvedCredential(api_key="", base_url="https://vlm.test/v1", model="vision-1", source="none")
        monkeypatch.setattr(reading, "_vision_settings", lambda _org: cred)

        result = await reading.read_region(b"jpeg", "What?")

        assert result.failure == "no vision model is configured"
