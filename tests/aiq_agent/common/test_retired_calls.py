"""A retired argument on Piloti's chat binding is an error that names its replacement (ADR-0133 slice 6)."""

from __future__ import annotations

from unittest.mock import patch

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import ValidationError

from aiq_agent.common.retired_calls import RETIRED_CALL_TAG
from aiq_agent.common.retired_calls import retired_hints
from aiq_agent.common.tool_errors import render_tool_error


class _Chat(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str


def _rejection(**args) -> ValidationError:
    try:
        _Chat(**args)
    except ValidationError as error:
        return error
    raise AssertionError("not rejected")


def test_a_retired_argument_is_named_with_its_replacement_and_tags_the_turn():
    with patch("aiq_agent.observability.langfuse_trace_attributes.add_trace_tag") as tag:
        text = render_tool_error(_rejection(query="T30", match="exact"))
    assert "match" in text and '`grep(pattern=…, mode="exact"|"regex", output_mode="content")`' in text
    tag.assert_called_once_with(RETIRED_CALL_TAG)


def test_an_unknown_argument_without_a_replacement_is_only_named():
    with patch("aiq_agent.observability.langfuse_trace_attributes.add_trace_tag") as tag:
        text = render_tool_error(_rejection(query="T30", colour="blue"))
    assert "colour" in text and "Instead" not in text
    tag.assert_not_called()


def test_each_replacement_once():
    with patch("aiq_agent.observability.langfuse_trace_attributes.add_trace_tag"):
        assert retired_hints(["view", "depth", "x"]) == ["a folder's tree is `ls(path=…, depth=2)`"]
        assert retired_hints([]) == []
