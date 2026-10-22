"""No image bytes in a trace: the helper, the span processor, and where it sits in the pipeline."""

from __future__ import annotations

import json

from aiq_agent.common.image_redaction import redact_inline_images
from aiq_agent.observability.langfuse_trace_attributes import InlineImageRedactionProcessor

PIXELS = "QUJD" * 5000
DATA_URL = f"data:image/jpeg;base64,{PIXELS}"


def _view_image_result() -> list[dict]:
    """What ``view_image`` hands the chat model: a text block and an image block."""
    return [
        {"type": "text", "text": "Region of page 3"},
        {"type": "image_url", "image_url": {"url": DATA_URL}},
    ]


class TestRedactInlineImages:
    def test_a_data_url_becomes_its_size_and_hash(self):
        result = redact_inline_images(f"before {DATA_URL} after")

        assert result.startswith("before [image, ")
        assert f"{len(DATA_URL)} chars, sha256:" in result
        assert result.endswith("] after")
        assert "QUJD" not in result

    def test_the_same_image_gets_the_same_hash_and_another_a_different_one(self):
        other = "data:image/png;base64,AAAA"

        assert redact_inline_images(DATA_URL) == redact_inline_images(DATA_URL)
        assert redact_inline_images(DATA_URL) != redact_inline_images(other)

    def test_message_lists_are_walked_and_keep_their_shape(self):
        messages = [{"role": "tool", "content": _view_image_result()}]

        result = redact_inline_images(messages)

        assert result[0]["content"][0] == {"type": "text", "text": "Region of page 3"}
        assert result[0]["content"][1]["image_url"]["url"].startswith("[image, ")
        assert messages[0]["content"][1]["image_url"]["url"] == DATA_URL, "the input is not mutated"

    def test_a_json_string_with_escaped_slashes_is_covered(self):
        escaped = json.dumps(DATA_URL).replace("/", "\\/")

        assert "QUJD" not in redact_inline_images(escaped)

    def test_text_without_an_image_comes_back_unchanged(self):
        assert redact_inline_images("data:text/plain;base64,AAAA") == "data:text/plain;base64,AAAA"
        assert redact_inline_images(7) == 7


class TestInlineImageRedactionProcessor:
    async def test_a_tool_span_and_a_generation_leave_without_pixels(self):
        from nat.data_models.span import Span

        tool = Span(
            name="view_knowledge_image",
            attributes={
                "nat.event_type": "TOOL_END",
                "output.value": str(_view_image_result()),
                "nat.metadata": json.dumps({"result": _view_image_result()}),
            },
        )
        generation = Span(
            name="a-model",
            attributes={
                "nat.event_type": "LLM_END",
                "input.value": json.dumps([{"role": "tool", "content": _view_image_result()}]),
                "output.value": "Das Mass ist 2,40 m.",
            },
        )

        for span in (tool, generation):
            await InlineImageRedactionProcessor().process(span)
            serialized = json.dumps(span.attributes)
            assert "data:image" not in serialized
            assert "QUJD" not in serialized
        assert "[image, " in tool.attributes["output.value"]
        assert generation.attributes["output.value"] == "Das Mass ist 2,40 m."

    async def test_a_span_without_an_image_is_untouched(self):
        from nat.data_models.span import Span

        span = Span(name="x", attributes={"input.value": "hello", "llm.token_count.total": 3})

        await InlineImageRedactionProcessor().process(span)

        assert span.attributes == {"input.value": "hello", "llm.token_count.total": 3}


class TestPipelineWiring:
    async def test_it_runs_ahead_of_every_other_processor(self):
        from aiq_agent.observability.otel_header_redaction_exporter import otelcollector_redaction_telemetry_exporter
        from tests.aiq_agent.observability.test_langfuse_trace_attributes import _make_config

        async with otelcollector_redaction_telemetry_exporter(_make_config(), None) as exporter:
            positions = exporter._processor_names

            assert positions["grid_inline_image_redaction"] == min(positions.values())


class TestWhatThePatternMustAlsoCover:
    """The carriers a first pattern missed (review of d902392a0): each must leave no pixel behind."""

    def test_a_payload_wrapped_into_lines(self):
        wrapped = "data:image/png;base64," + "\n".join(["QUJD" * 19] * 5)
        escaped = json.dumps(wrapped)  # the line breaks as `\n` inside a JSON string

        for text in (f"x {wrapped} y", escaped):
            assert "QUJD" not in redact_inline_images(text)

    def test_slashes_escaped_by_two_rounds_of_json(self):
        twice = json.dumps(json.dumps(DATA_URL).replace("/", "\\/")).replace("/", "\\/")

        assert "\\\\\\/" in twice
        assert "QUJD" not in redact_inline_images(twice)

    def test_a_data_url_that_is_not_base64(self):
        svg = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%2F%3E"
        result = redact_inline_images(f'<img src="{svg}"> after')

        assert "%3Cpath" not in result and result.endswith('"> after')

    def test_media_type_parameters_before_the_payload(self):
        assert "QUJD" not in redact_inline_images(f"data:image/png;charset=utf-8;base64,{PIXELS}")

    def test_text_after_the_image_is_kept(self):
        assert redact_inline_images(f'"{DATA_URL}", "next": "Das Mass ist 2,40 m."').endswith(
            '", "next": "Das Mass ist 2,40 m."'
        )


class TestSequenceAttributes:
    async def test_a_list_valued_attribute_leaves_without_pixels(self):
        from nat.data_models.span import Span

        span = Span(name="tool", attributes={"gen_ai.prompt.images": [DATA_URL, "kept"]})

        await InlineImageRedactionProcessor().process(span)

        values = span.attributes["gen_ai.prompt.images"]
        assert "QUJD" not in json.dumps(values) and values[1] == "kept"


class TestDirectTracer:
    def test_a_direct_generation_prompt_carries_no_pixels(self):
        from aiq_agent.observability.direct_trace import INPUT_ATTRIBUTE
        from aiq_agent.observability.direct_trace import generation_start_attributes

        messages = [{"role": "user", "content": _view_image_result()}]
        attributes = generation_start_attributes("conversation-title", model="m", messages=messages)

        assert "QUJD" not in attributes[INPUT_ATTRIBUTE]
        assert "[image, " in attributes[INPUT_ATTRIBUTE]
