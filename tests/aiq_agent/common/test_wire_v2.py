"""The chat wire v2 contract, read from this side (``docs/design/chat-wire-v2.md``).

The fixtures under ``contracts/wire/v2/`` are recorded turns, one event per line.
``apps/workspace/ui/adapters/api/wire-v2.spec.ts`` reads the same files with the
generated zod schemas, so a field the two sides disagree on fails one of the two
suites. What this side adds: the frame the server would write for a fixture is
the fixture itself (defaults omitted, discriminators kept), the ordering rules
of a turn hold, and the committed JSON Schema is the one the models generate.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from aiq_agent.common.wire_v2 import CLIENT_MESSAGE
from aiq_agent.common.wire_v2 import HELLO
from aiq_agent.common.wire_v2 import WIRE_EVENT
from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import EmptyValue
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import WireEvent as WIRE_EVENT_TYPE
from aiq_agent.common.wire_v2 import card_key
from aiq_agent.common.wire_v2 import stamp
from aiq_agent.common.wire_v2 import to_frame

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "contracts" / "wire" / "v2"
SCHEMA = ROOT / "contracts" / "wire" / "v2.schema.json"
TURNS = sorted(FIXTURES.glob("turn-*.jsonl"))
TERMINAL = {"RUN_FINISHED", "RUN_ERROR"}


def _lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _events(path: Path) -> list[tuple[str, dict[str, Any]]]:
    return [(f"{path.name}:{n}", raw) for n, raw in enumerate(_lines(path), 1)]


ALL_EVENTS = [item for path in [*TURNS, FIXTURES / "rejected.jsonl"] for item in _events(path)]


def test_there_is_a_fixture_for_every_event_the_contract_names() -> None:
    names = {raw["name"] if raw["type"] == "CUSTOM" else raw["type"] for _, raw in ALL_EVENTS}
    kinds = {raw["step"]["kind"] for _, raw in ALL_EVENTS if "step" in raw}
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]["WireEvent"]
    mapping = schema["discriminator"]["mapping"]
    expected = {name for name in mapping if name != "CUSTOM"} | set(mapping["CUSTOM"]["discriminator"]["mapping"])
    assert names == expected
    assert kinds == {"status", "retrieval", "sources", "tool", "skill", "clarification"}


@pytest.mark.parametrize(("where", "raw"), ALL_EVENTS, ids=[where for where, _ in ALL_EVENTS])
def test_every_recorded_event_is_the_frame_the_server_writes(where: str, raw: dict[str, Any]) -> None:
    event = WIRE_EVENT.validate_python(raw)
    assert to_frame(event) == raw, where


@pytest.mark.parametrize("path", TURNS, ids=[path.name for path in TURNS])
def test_a_turn_is_one_ordered_sequence(path: Path) -> None:
    events = _lines(path)
    assert events[0]["type"] == "RUN_STARTED"
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert len({event["turn_id"] for event in events}) == 1
    assert all(a["ts"] <= b["ts"] for a, b in zip(events, events[1:], strict=False))
    terminal = [n for n, event in enumerate(events) if event["type"] in TERMINAL]
    assert len(terminal) == 1
    after = events[terminal[0] + 1 :]
    # Only the post-answer stages outlive the turn; a heartbeat never does.
    assert all(event["type"] == "CUSTOM" and event["name"] == "stage" for event in after)


@pytest.mark.parametrize("path", TURNS, ids=[path.name for path in TURNS])
def test_a_subagent_s_work_lies_between_its_start_and_its_end(path: Path) -> None:
    """AG-UI 1.0: a step names an open invocation, a nested one an open parent, and each closes once."""
    open_runs: set[str] = set()
    closed: set[str] = set()
    for event in _lines(path):
        run = event.get("subagent_run_id")
        if event["type"] == "SUBAGENT_STARTED":
            parent = event.get("parent_subagent_run_id")
            assert run not in open_runs | closed, f"{run} started twice"
            assert parent is None or parent in open_runs, f"{run}'s parent {parent} is not running"
            open_runs.add(run)
        elif event["type"] in {"SUBAGENT_FINISHED", "SUBAGENT_ERROR"}:
            assert run in open_runs, f"{run} ended without running"
            open_runs.discard(run)
            closed.add(run)
        elif run is not None:
            assert run in open_runs, f"a step names {run}, which is not running"
    assert not open_runs, f"never ended: {open_runs}"


def test_a_rejection_is_out_of_band() -> None:
    for event in _lines(FIXTURES / "rejected.jsonl"):
        assert event["seq"] == 0
        assert event["name"] == "rejected"


@pytest.mark.parametrize("raw", _lines(FIXTURES / "client.jsonl"))
def test_every_client_message_parses(raw: dict[str, Any]) -> None:
    message = CLIENT_MESSAGE.validate_python(raw)
    assert message.model_dump(mode="json", exclude_defaults=True) == raw


@pytest.mark.parametrize("raw", _lines(FIXTURES / "invalid-events.jsonl") + _lines(FIXTURES / "newer-events.jsonl"))
def test_what_is_not_a_v2_event_is_refused(raw: dict[str, Any]) -> None:
    # newer-events.jsonl is drift a newer server might send: an unknown key, an
    # unknown event type, step kind or CUSTOM name. The client reads it
    # (wire-v2.spec.ts); this server never writes it, because its models
    # forbid what they do not name.
    with pytest.raises(ValidationError):
        WIRE_EVENT.validate_python(raw)


@pytest.mark.parametrize("raw", _lines(FIXTURES / "invalid-client.jsonl"))
def test_what_is_not_a_v2_client_message_is_refused(raw: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        CLIENT_MESSAGE.validate_python(raw)


def test_stamp_puts_a_body_under_the_turns_envelope() -> None:
    body = StepFinishedBody(step=StatusStep(id="status:synthesis", slot="synthesis", key="status.synthesis"))
    frame = to_frame(stamp(body, conversation_id="c", turn_id="t", seq=7, ts=1))
    assert frame == {
        "v": 2,
        "type": "STEP_FINISHED",
        "conversation_id": "c",
        "turn_id": "t",
        "seq": 7,
        "ts": 1,
        "step": {"kind": "status", "id": "status:synthesis", "slot": "synthesis", "key": "status.synthesis"},
    }
    delta = to_frame(
        stamp(TextMessageContentBody(message_id="m", delta="x"), conversation_id="c", turn_id="t", seq=8, ts=2)
    )
    assert delta["delta"] == "x"
    retracted = to_frame(stamp(AnswerRetractedBody(value=EmptyValue()), conversation_id="c", turn_id="t", seq=9, ts=3))
    assert retracted["name"] == "answer_retracted"
    assert retracted["value"] == {}


def test_a_card_key_is_its_content() -> None:
    card = {"type": "verdict_header", "subject": "Maximale Fluchtweglänge", "verdict": "40 m"}
    assert card_key(card) == card_key(dict(reversed(list(card.items()))))
    assert card_key(card) != card_key({**card, "verdict": "35 m"})


def test_the_committed_schema_is_the_one_the_models_generate() -> None:
    from scripts.generate_wire_schema import render

    assert SCHEMA.read_text(encoding="utf-8") == render(), (
        "contracts/wire/v2.schema.json is stale: run `uv run python scripts/generate_wire_schema.py`, "
        "then `npm run generate:wire` in apps/workspace, and commit both."
    )


@pytest.mark.parametrize("raw", _lines(FIXTURES / "hello.jsonl"))
def test_the_hello_is_the_frame_the_server_writes_and_no_turn_event(raw: dict[str, Any]) -> None:
    assert to_frame(HELLO.validate_python(raw)) == raw
    # A reader that folds turns must never mistake it for one: it names no turn.
    with pytest.raises(ValidationError):
        WIRE_EVENT.validate_python(raw)


@pytest.mark.parametrize(
    "raw",
    [
        {"v": 3, "type": "CUSTOM", "name": "hello", "ts": 1, "value": {"build": "abc"}},
        {"v": 2, "type": "CUSTOM", "name": "hello", "ts": 1, "value": {}},
        {"v": 2, "type": "CUSTOM", "name": "hello", "ts": 1, "value": {"build": "abc"}, "turn_id": "t"},
    ],
)
def test_a_hello_in_another_dialect_is_refused(raw: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        HELLO.validate_python(raw)


def test_a_turn_still_ends_only_on_the_terminals_old_tabs_know() -> None:
    """Pin the event types, so a new one is a decision, not an accident.

    A tab running an older bundle skips any event type it does not know (the
    client folds it as a no-op so ``seq`` stays continuous; chat-wire-v2.md,
    "Compatibility: additive changes are safe"). That makes a new type safe
    unless it ENDS a turn: old tabs would skip it and wait on the watchdog. A
    turn must keep ending with ``RUN_FINISHED`` or ``RUN_ERROR``. Adding a type
    here means checking it is not a terminal before extending the set.
    """
    import typing

    def models(annotated: Any) -> list[Any]:
        # `CustomEvent` is itself an Annotated union, discriminated by `name`.
        union = typing.get_args(annotated)[0]
        return [
            m
            for member in typing.get_args(union)
            for m in (models(member) if typing.get_origin(member) is typing.Annotated else [member])
        ]

    types = {model.model_fields["type"].default for model in models(WIRE_EVENT_TYPE)}
    assert types == {
        "RUN_STARTED",
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "STATE_SNAPSHOT",
        "STEP_STARTED",
        "STEP_FINISHED",
        # AG-UI 1.0's subagent lifecycle: none of the three ends a turn, and a
        # SUBAGENT_ERROR is deliberately not RUN_ERROR (the turn goes on).
        "SUBAGENT_STARTED",
        "SUBAGENT_FINISHED",
        "SUBAGENT_ERROR",
        "RUN_FINISHED",
        "RUN_ERROR",
        "CUSTOM",
    }
    assert TERMINAL <= types


class TestFocusRegion:
    """The box on the review canvas: the JSON Schema cannot say x + w <= 1, so the model does."""

    def _message(self, **region) -> dict:
        box = {"page": 1, "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2, **region}
        return {
            "v": 2,
            "type": "user_message",
            "conversation_id": "c",
            "message_id": "m",
            "text": "x",
            "focus_region": box,
        }

    @pytest.mark.parametrize("overflow", [{"x": 0.9, "w": 0.2}, {"y": 0.85, "h": 0.2}])
    def test_a_box_past_the_page_edge_is_refused(self, overflow) -> None:
        with pytest.raises(ValidationError, match="reaches past the page"):
            CLIENT_MESSAGE.validate_python(self._message(**overflow))

    def test_a_box_flush_with_the_edge_survives_float_rounding(self) -> None:
        message = CLIENT_MESSAGE.validate_python(self._message(x=0.3, w=0.7000000000000001))
        assert message.focus_region.w == pytest.approx(0.7)

    def test_both_fields_are_named_in_the_hello(self) -> None:
        from aiq_agent.common.wire_v2 import ACCEPTED_CLIENT_FIELDS

        assert {"user_message.focus_region", "user_message.reply_in_thread"} <= set(ACCEPTED_CLIENT_FIELDS)


class TestViewerAction:
    """A viewer action (ADR-0144): the allow-list and what each action needs, which the JSON Schema cannot say."""

    def _value(self, name: str, **args) -> dict:
        return {
            "tool_call_id": "va_1",
            "tool_call_name": name,
            "args": {"document_id": "d", "document_name": "x.pdf", **args},
        }

    def test_the_allow_list_is_the_five_actions(self) -> None:
        from aiq_agent.common.wire_v2 import VIEWER_ACTION_REQUIRES
        from aiq_agent.common.wire_v2 import ViewerActionName

        assert (
            set(typing_args(ViewerActionName))
            == set(VIEWER_ACTION_REQUIRES)
            == {
                "open_document",
                "highlight_passage",
                "highlight_region",
                "compare_revisions",
                "focus_ifc_element",
            }
        )

    @pytest.mark.parametrize(
        ("name", "args", "missing"),
        [
            ("highlight_passage", {"passage": "Fluchtweg"}, "page"),
            ("highlight_region", {"page": 2}, "region"),
            ("compare_revisions", {}, "against_document_id"),
            ("focus_ifc_element", {}, "element"),
        ],
    )
    def test_an_action_without_its_place_is_refused(self, name: str, args: dict, missing: str) -> None:
        from aiq_agent.common.wire_v2 import ViewerActionValue

        with pytest.raises(ValidationError, match=missing):
            ViewerActionValue.model_validate(self._value(name, **args))

    @pytest.mark.parametrize("region", [[0.8, 0.1, 0.3, 0.2], [0.1, 0.1, 0, 0.2], [-0.1, 0, 0.2, 0.2]])
    def test_a_region_off_the_page_is_refused(self, region: list[float]) -> None:
        from aiq_agent.common.wire_v2 import ViewerActionValue

        with pytest.raises(ValidationError, match="not a box on the page"):
            ViewerActionValue.model_validate(self._value("highlight_region", page=1, region=region))

    def test_an_element_is_an_ifc_global_id(self) -> None:
        from aiq_agent.common.wire_v2 import ViewerActionValue

        with pytest.raises(ValidationError):
            ViewerActionValue.model_validate(self._value("focus_ifc_element", element="wall-12"))


def typing_args(annotation: Any) -> tuple[Any, ...]:
    import typing

    return typing.get_args(annotation)
