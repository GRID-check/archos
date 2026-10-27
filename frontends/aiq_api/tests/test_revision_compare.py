"""The Fassung comparison route: two page images in one vision call, boxes and words out.

``POST /v1/collections/{collection}/revision-compare``. The model is a fake: what is pinned is
the contract (what is sent, what is parsed and dropped, what is cached, what is traced and
what is refused), not the quality of any model's eyes. The pure parsing is exercised
directly, the route through its real handler.
"""

import json
import uuid
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient
from knowledge_layer.page_image import PageImage
from knowledge_layer.page_image import PageImageUnavailable
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from aiq_agent.common import cache
from aiq_agent.knowledge import revision_compare as compare
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.observability import direct_trace
from aiq_api.routes import revision_compare as route
from aiq_api.routes.revision_compare import add_revision_compare_routes

COLLECTION = "proj_a"
OLDER = "Grundriss_EG_Index_B.pdf"
NEWER = "Grundriss_EG_Index_C.pdf"
URL = f"/v1/collections/{COLLECTION}/revision-compare"
BODY = {"older": OLDER, "newer": NEWER, "page": 1}


def _model_reply(changes=None, summary=None) -> dict:
    content = json.dumps(
        {
            "changes": [{"label": "Wand verschoben", "x": 0.2, "y": 0.3, "w": 0.1, "h": 0.25}]
            if changes is None
            else changes,
            "summary": ["Die Wand im Norden ist um 0,5 m nach Osten gerückt."] if summary is None else summary,
        }
    )
    return {
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 8000, "completion_tokens": 120, "total_tokens": 8120, "cost": 0.0014},
        "model": "openai/test-vlm",
    }


def _gateway(data: dict | None = None, error: Exception | None = None):
    """The vision endpoint as ``httpx.AsyncClient`` sees it; returns the class double and its ``post``."""
    response = MagicMock(spec=httpx.Response)
    response.status_code = 200
    response.raise_for_status = MagicMock()
    response.json.return_value = _model_reply() if data is None else data
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(side_effect=error) if error else AsyncMock(return_value=response)
    return MagicMock(return_value=client), client.post


@pytest.fixture(autouse=True)
def _environment(monkeypatch):
    monkeypatch.setenv("GRID_VLM_API_KEY", "test-key")  # pragma: allowlist secret
    monkeypatch.setenv("GRID_VLM_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("GRID_VLM_MODEL", "openai/test-vlm")
    cache.reset_local_store()
    yield
    cache.reset_local_store()


@pytest.fixture
def pages(monkeypatch):
    """Page loader double: distinct bytes per file and page, unless a test makes a page unavailable."""
    unavailable: set[str] = set()
    asked: list[tuple[str, str, int, str | None]] = []
    salt = uuid.uuid4().hex

    async def load(collection, file_name, page, organization_id):
        asked.append((collection, file_name, page, organization_id))
        if file_name in unavailable:
            raise PageImageUnavailable("not_stored")
        return PageImage(jpeg=f"{salt}|{file_name}|{page}".encode(), width=100, height=50)

    monkeypatch.setattr(route, "_load_page", load)
    return MagicMock(unavailable=unavailable, asked=asked)


@pytest.fixture
def ingested(monkeypatch):
    names = {OLDER, NEWER}

    async def available(collection):
        assert collection == COLLECTION
        return [AvailableDocument(file_name=name, summary="") for name in sorted(names)]

    monkeypatch.setattr(route, "get_available_documents_async", available)
    return names


def _client():
    app = FastAPI()
    router = APIRouter()
    add_revision_compare_routes(router)
    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _post(body=None, gateway=None, headers=None):
    fake, post = gateway or _gateway()
    async with _client() as client:
        with patch("httpx.AsyncClient", fake):
            response = await client.post(URL, json=BODY if body is None else body, headers=headers)
    return response, post


class TestTheRoute:
    async def test_it_sends_both_pages_in_one_call_and_returns_boxes_and_words(self, pages, ingested):
        response, post = await _post(headers={"x-grid-organization-id": "org-1"})

        assert response.status_code == 200
        body = response.json()
        # The trace id is whatever tracer the process has (another test may have
        # installed one); the test that installs its own pins the value.
        assert set(body) >= {"trace_id"}
        body.pop("trace_id")
        assert body == {
            "regions": [{"page": 1, "x": 0.2, "y": 0.3, "w": 0.1, "h": 0.25, "label": "Wand verschoben"}],
            "summary": ["Die Wand im Norden ist um 0,5 m nach Osten gerückt."],
            "model": "openai/test-vlm",
            "cached": False,
        }
        post.assert_awaited_once()
        sent = post.await_args.kwargs["json"]
        parts = sent["messages"][0]["content"]
        images = [part["image_url"]["url"] for part in parts if part["type"] == "image_url"]
        assert len(images) == 2 and all(url.startswith("data:image/jpeg;base64,") for url in images)
        assert images[0] != images[1]
        assert sent["model"] == "openai/test-vlm"
        assert post.await_args.args[0] == "https://openrouter.ai/api/v1/chat/completions"
        assert post.await_args.kwargs["headers"]["Authorization"] == "Bearer test-key"

    async def test_it_loads_the_same_page_of_both_files_for_the_callers_organization(self, pages, ingested):
        await _post({**BODY, "page": 3}, headers={"x-grid-organization-id": "org-1"})

        assert set(pages.asked) == {(COLLECTION, OLDER, 3, "org-1"), (COLLECTION, NEWER, 3, "org-1")}

    async def test_a_nothing_changed_answer_says_so_in_words(self, pages, ingested):
        response, _ = await _post(gateway=_gateway(_model_reply(changes=[], summary=[])))

        assert response.status_code == 200
        assert response.json()["regions"] == []
        assert response.json()["summary"] == [compare.NO_CHANGE_TEXT]

    async def test_a_second_click_costs_no_model_call(self, pages, ingested):
        gateway = _gateway()
        first, post = await _post(gateway=gateway)
        second, _ = await _post(gateway=gateway)

        assert first.json()["cached"] is False
        assert second.json()["cached"] is True
        assert {**second.json(), "cached": False} == first.json()
        assert post.await_count == 1

    async def test_other_pixels_are_another_comparison(self, pages, ingested):
        gateway = _gateway()
        _, post = await _post(gateway=gateway)
        await _post({**BODY, "page": 2}, gateway=gateway)

        assert post.await_count == 2

    async def test_a_new_prompt_is_not_answered_from_the_old_ones_cache(self, pages, ingested, monkeypatch):
        gateway = _gateway()
        _, post = await _post(gateway=gateway)
        monkeypatch.setattr(compare, "PROMPT_VERSION", compare.PROMPT_VERSION + 1)
        await _post(gateway=gateway)

        assert post.await_count == 2

    async def test_a_reply_that_is_not_json_is_a_502_and_is_not_cached(self, pages, ingested):
        bad = _model_reply()
        bad["choices"][0]["message"]["content"] = "Ich sehe keine Unterschiede, tut mir leid."
        gateway = _gateway(bad)
        failed, post = await _post(gateway=gateway)
        retry, _ = await _post(gateway=gateway)

        assert failed.status_code == 502
        assert retry.status_code == 502
        assert post.await_count == 2

    async def test_a_provider_failure_is_a_502(self, pages, ingested):
        response, _ = await _post(gateway=_gateway(error=httpx.ConnectError("refused")))

        assert response.status_code == 502

    async def test_the_models_malformed_boxes_never_reach_the_response(self, pages, ingested):
        changes = [
            {"label": "gut", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "außerhalb", "x": 40, "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2},
        ]
        response, _ = await _post(gateway=_gateway(_model_reply(changes=changes)))

        assert [region["label"] for region in response.json()["regions"]] == ["gut"]


class TestRefusals:
    async def test_a_document_that_is_not_ingested_is_a_409_before_anything_is_rendered(self, pages, ingested):
        ingested.discard(OLDER)
        response, post = await _post()

        assert response.status_code == 409
        assert pages.asked == []
        post.assert_not_awaited()

    async def test_a_missing_image_is_a_404_and_no_model_is_called(self, pages, ingested):
        pages.unavailable.add(NEWER)
        response, post = await _post()

        assert response.status_code == 404
        assert "newer" in response.json()["detail"]
        post.assert_not_awaited()

    async def test_a_file_is_not_compared_with_itself(self, pages, ingested):
        response, _ = await _post({**BODY, "newer": OLDER})

        assert response.status_code == 400

    @pytest.mark.parametrize(
        "body",
        [
            {**BODY, "page": 0},
            {**BODY, "page": "x"},
            {"older": OLDER},
            {**BODY, "older": ""},
            {**BODY, "collection": "proj_b"},
        ],
    )
    async def test_the_request_is_validated_and_takes_no_extra_field(self, pages, ingested, body):
        response, post = await _post(body)

        assert response.status_code == 422
        post.assert_not_awaited()

    async def test_page_defaults_to_one(self, pages, ingested):
        response, _ = await _post({"older": OLDER, "newer": NEWER})

        assert response.status_code == 200
        assert {asked[2] for asked in pages.asked} == {1}

    async def test_without_a_vision_key_it_is_a_503(self, pages, ingested, monkeypatch):
        for name in ("GRID_VLM_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_KEY"):
            monkeypatch.delenv(name, raising=False)
        response, post = await _post()

        assert response.status_code == 503
        post.assert_not_awaited()


class TestTracing:
    @pytest.fixture
    def exporter(self):
        direct_trace.reset_tracer_provider()
        memory = InMemorySpanExporter()
        direct_trace.install_tracer_provider(None, env={}, exporter=memory)
        yield memory
        direct_trace.reset_tracer_provider()

    async def test_the_call_is_a_revision_visual_compare_generation_without_the_pixels(self, pages, ingested, exporter):
        await _post()

        direct_trace._provider.force_flush()
        (span,) = exporter.get_finished_spans()
        assert span.attributes["langfuse.trace.name"] == route.TRACE_NAME == "revision-visual-compare"
        assert span.attributes["langfuse.trace.metadata.purpose"] == "person"
        assert span.attributes["langfuse.observation.type"] == "generation"
        assert span.attributes["gen_ai.usage.input_tokens"] == 8000
        traced_input = span.attributes["langfuse.observation.input"]
        assert "base64" not in traced_input and "Ältere Fassung" in traced_input

    async def test_a_notice_is_traced_as_one_and_hands_its_trace_on(self, pages, ingested, exporter):
        response, _ = await _post({**BODY, "purpose": "notice"})

        direct_trace._provider.force_flush()
        (span,) = exporter.get_finished_spans()
        assert span.attributes["langfuse.trace.metadata.purpose"] == "notice"
        assert response.json()["trace_id"] == format(span.get_span_context().trace_id, "032x")

    async def test_the_vision_call_is_booked_to_the_named_organization_and_person(self, pages, ingested, monkeypatch):
        """A notice's spend reaches the ledger the budget gate reads; a cache hit books nothing (ADR-0130)."""
        from aiq_agent.common import cost_tracking

        posted: list[dict] = []
        monkeypatch.setattr(cost_tracking, "_post_usage_events", posted.append)
        headers = {"x-grid-organization-id": "org-1", "x-grid-user-id": "user-9"}
        gateway = _gateway()

        await _post({**BODY, "purpose": "notice"}, gateway=gateway, headers=headers)
        await _post({**BODY, "purpose": "notice"}, gateway=gateway, headers=headers)

        [batch] = posted
        assert (batch["organizationId"], batch["userId"]) == ("org-1", "user-9")
        [event] = batch["events"]
        assert event["role"] == "revision_compare"
        assert (event["promptTokens"], event["completionTokens"], event["costUsd"]) == (8000, 120, 0.0014)
        assert event["costSource"] == "usage_field"

    async def test_a_notice_queues_behind_people_waiting(self, pages, ingested, monkeypatch):
        classes: list[str] = []
        real = route.limited_async_http_client

        def spy(*args, **kwargs):
            classes.append(kwargs["cls"])
            return real(*args, **kwargs)

        monkeypatch.setattr(route, "limited_async_http_client", spy)
        await _post({**BODY, "purpose": "notice"})
        await _post({**BODY, "page": 2})

        assert classes == ["bulk", "interactive"]

    async def test_a_cache_hit_makes_no_generation(self, pages, ingested, exporter):
        gateway = _gateway()
        await _post(gateway=gateway)
        await _post(gateway=gateway)

        direct_trace._provider.force_flush()
        assert len(exporter.get_finished_spans()) == 1


class TestChangedPages:
    """``revision-pages``: the newer Fassung's changed pages, from the index, without a model call."""

    @pytest.fixture
    def stored(self, monkeypatch):
        chunks = {
            OLDER: [("Grundriss EG\nWand 2,50 m", {"page_label": "1"}), ("Schnitt\nREI 90", {"page_label": "2"})],
            NEWER: [("Grundriss EG\nWand 2,50 m", {"page_label": "1"}), ("Schnitt\nREI 60", {"page_label": "2"})],
        }
        monkeypatch.setattr(
            "aiq_agent.knowledge.collection_pages.read_chunks", lambda collection, name: chunks.get(name)
        )
        return chunks

    async def _pages(self, body=None, gateway=None):
        fake, post = gateway or _gateway()
        async with _client() as client:
            with patch("httpx.AsyncClient", fake):
                response = await client.post(
                    f"/v1/collections/{COLLECTION}/revision-pages", json=body or {"older": OLDER, "newer": NEWER}
                )
        return response, post

    async def test_only_the_changed_page_and_no_model(self, ingested, stored):
        response, post = await self._pages()

        assert response.status_code == 200
        assert response.json() == {"pages": [2], "newer_page_count": 2, "comparable": True}
        post.assert_not_awaited()

    async def test_a_scan_with_nothing_read_is_not_comparable(self, ingested, stored):
        stored[OLDER], stored[NEWER] = None, None

        response, _ = await self._pages()

        assert response.json() == {"pages": [], "newer_page_count": 0, "comparable": False}

    async def test_a_file_not_ingested_is_a_409(self, ingested, stored):
        ingested.discard(NEWER)

        response, _ = await self._pages()

        assert response.status_code == 409

    async def test_an_index_outage_is_a_503_never_nothing_changed(self, ingested, monkeypatch):
        def down(collection, name):
            raise ConnectionError("qdrant down")

        monkeypatch.setattr("aiq_agent.knowledge.collection_pages.read_chunks", down)

        response, _ = await self._pages()

        assert response.status_code == 503


class TestParsing:
    def reply(self, **fields):
        return compare.parse_compare(fields, page=2)

    def test_a_box_keeps_its_page_and_is_rounded(self):
        result = self.reply(changes=[{"label": "Tür neu", "x": 0.123456, "y": 0.5, "w": 0.1, "h": 0.1}])

        assert result.regions == (compare.CompareRegion(2, 0.1235, 0.5, 0.1, 0.1, "Tür neu"),)

    def test_a_box_over_the_edge_is_trimmed_to_it(self):
        (region,) = self.reply(changes=[{"label": "a", "x": 0.9, "y": 0.9, "w": 0.3, "h": 0.3}]).regions

        assert (region.x, region.y, region.w, region.h) == (0.9, 0.9, 0.1, 0.1)

    def test_rounding_overshoot_is_clamped(self):
        (region,) = self.reply(changes=[{"label": "a", "x": -0.01, "y": 0.0, "w": 1.01, "h": 0.5}]).regions

        assert (region.x, region.w) == (0.0, 1.0)

    @pytest.mark.parametrize(
        "item",
        [
            {"label": "a", "x": 40, "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "a", "x": 0.1, "y": 0.1, "w": 35, "h": 0.2},
            {"label": "a", "x": -0.5, "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "a", "x": "0.1", "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "a", "x": True, "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "a", "x": float("nan"), "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "a", "x": 0.1, "y": 0.1, "w": 0.0, "h": 0.2},
            {"label": "a", "x": 0.1, "y": 0.1, "w": 0.2},
            {"label": "a", "x": 1.0, "y": 0.1, "w": 0.2, "h": 0.2},
            {"label": "   ", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2},
            {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2},
            "a string",
            None,
            42,
        ],
    )
    def test_a_malformed_box_is_dropped_not_repaired(self, item):
        assert self.reply(changes=[item, {"label": "ok", "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}]).regions == (
            compare.CompareRegion(2, 0.1, 0.1, 0.2, 0.2, "ok"),
        )

    def test_a_box_may_come_as_a_list(self):
        (region,) = self.reply(changes=[{"label": "a", "box": [0.1, 0.2, 0.3, 0.4]}]).regions

        assert (region.x, region.y, region.w, region.h) == (0.1, 0.2, 0.3, 0.4)

    def test_at_most_twelve_boxes_are_kept_in_the_models_order(self):
        changes = [{"label": f"c{i}", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1} for i in range(30)]

        regions = self.reply(changes=changes).regions

        assert [region.label for region in regions] == [f"c{i}" for i in range(compare.MAX_REGIONS)]

    def test_a_label_is_one_bounded_line(self):
        (region,) = self.reply(changes=[{"label": "a\n" + "b" * 500, "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}]).regions

        assert "\n" not in region.label and len(region.label) <= compare.MAX_LABEL_CHARS

    @pytest.mark.parametrize("reply", [{}, {"changes": [], "summary": []}, {"changes": "x", "summary": 3}])
    def test_nothing_found_is_said_in_words(self, reply):
        result = compare.parse_compare(reply, page=1)

        assert result == compare.CompareResult((), (compare.NO_CHANGE_TEXT,))

    def test_a_denial_next_to_a_box_is_not_believed_over_the_box(self):
        result = self.reply(
            changes=[{"label": "Wand verschoben", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}],
            summary=["Keine sichtbare Änderung"],
        )

        assert result.summary == ("Wand verschoben",)

    def test_sentences_without_a_valid_box_stay_in_the_summary(self):
        result = self.reply(changes=[{"label": "x", "x": 9, "y": 9, "w": 9, "h": 9}], summary=["Index B auf C."])

        assert result.regions == () and result.summary == ("Index B auf C.",)

    def test_the_summary_is_bounded(self):
        result = self.reply(summary=[f"Satz {i}" for i in range(50)] + [None, "", 3])

        assert len(result.summary) == compare.MAX_SUMMARY_LINES

    def test_a_cached_result_round_trips_and_a_stale_shape_is_a_miss(self):
        result = self.reply(changes=[{"label": "a", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}], summary=["s"])

        assert compare.CompareResult.from_dict(json.loads(json.dumps(result.as_dict()))) == result
        assert compare.CompareResult.from_dict({"regions": [{"nope": 1}], "summary": []}) is None
        assert compare.CompareResult.from_dict("x") is None


class TestWhatIsSent:
    def test_the_prompt_asks_for_the_newer_page_in_page_coordinates_and_forbids_inventing(self):
        prompt = compare.COMPARE_PROMPT

        assert "NEWER page" in prompt and "between 0 and 1" in prompt
        assert "Invent nothing" in prompt
        assert compare.NO_CHANGE_TEXT in prompt
        assert str(compare.MAX_REGIONS) in prompt

    def test_the_older_page_goes_first(self):
        parts = compare.build_messages("data:older", "data:newer")[0]["content"]

        assert [part["image_url"]["url"] for part in parts if part["type"] == "image_url"] == [
            "data:older",
            "data:newer",
        ]

    def test_a_trace_never_holds_pixels(self):
        traced = compare.traceable(compare.build_messages("data:image/jpeg;base64," + "A" * 5000, "data:x"))

        assert "AAAA" not in json.dumps(traced)

    def test_the_cache_key_names_model_collection_page_and_both_pictures(self):
        base = compare.cache_key("m", "c", 1, b"old", b"new")

        assert base != compare.cache_key("m2", "c", 1, b"old", b"new")
        assert base != compare.cache_key("m", "c2", 1, b"old", b"new")
        assert base != compare.cache_key("m", "c", 2, b"old", b"new")
        assert base != compare.cache_key("m", "c", 1, b"old2", b"new")
        assert base != compare.cache_key("m", "c", 1, b"old", b"new2")
        assert base != compare.cache_key("m", "c", 1, b"new", b"old")
