"""The answer suite's harness abilities: a turn that carries a drawn box, and a fixture BFF that files proposals.

Offline. The north-star rows ``ns-drawn-box`` (needs ``given_box``, ``canvas``) and ``ns-propose-move``
(needs ``proposals``) run only if the harness really does these things, so they are driven here end to
end up to the model: the turn's own parse and prompt section for the box, the agent's own proposals
client against the fixture BFF for the proposal.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import fixture_bff  # noqa: E402
import north_star_eval  # noqa: E402
import suite  # noqa: E402
import turn_input  # noqa: E402
from jsonschema import Draft202012Validator  # noqa: E402

from aiq_agent.agents.piloti.prompt import focus_region_block  # noqa: E402
from aiq_agent.common.bff_http import SignedEnvelope  # noqa: E402
from aiq_agent.common.wire_v2 import FocusRegion  # noqa: E402
from aiq_agent.tools import proposals_client  # noqa: E402
from aiq_agent.tools.canvas import client as canvas_client  # noqa: E402
from aiq_agent.tools.canvas.marks import propose_payload  # noqa: E402
from aiq_agent.turn import payload  # noqa: E402

ROW = {row["id"]: row for row in north_star_eval.load_questions()}["ns-drawn-box"]
TOKEN = "eval-token"
OFFICE = {"organizationId": "org-x", "userId": "user-x"}
SCHEMA = json.loads((REPO_ROOT / "apps/workspace/tests/fixtures/proposals.schema.json").read_text(encoding="utf-8"))


class TestTheDrawnBoxOnTheTurn:
    def test_a_plain_question_becomes_the_user_message_the_socket_sends(self):
        message = turn_input.user_message("Was ist das hier?", turn_input.message_fields(ROW))
        assert message.focus_file_name == "EP-01_Grundrisse_Index-B.pdf"
        assert message.focus_region == FocusRegion(page=1, x=0.30, y=0.60, w=0.10, h=0.16)

    def test_the_turns_own_parse_reads_the_box_and_the_surface_is_the_canvas(self):
        extract = turn_input.wrapped(payload.extract_turn_inputs, turn_input.message_fields(ROW))
        inputs = extract("Was ist das hier? War das in Index A schon so?")
        assert inputs.query_text == "Was ist das hier? War das in Index A schon so?"
        assert inputs.focus_file_name == "EP-01_Grundrisse_Index-B.pdf"
        assert inputs.focus_region.page == 1
        assert inputs.surface == "review_canvas"

    def test_a_turn_that_is_already_a_message_is_left_alone(self):
        sent = turn_input.user_message("q", turn_input.message_fields(ROW))
        seen = []
        turn_input.wrapped(seen.append, {})(sent)
        assert seen == [sent]

    def test_the_prompt_tells_the_model_to_look_at_exactly_that_box(self):
        inputs = turn_input.wrapped(payload.extract_turn_inputs, turn_input.message_fields(ROW))("q")
        state = SimpleNamespace(focus_region=inputs.focus_region, focus_file_name=inputs.focus_file_name)
        block = focus_region_block(state, ["look"])
        assert "## Focus region" in block
        assert "EP-01_Grundrisse_Index-B.pdf" in block
        assert "region=[0.300, 0.600, 0.100, 0.160]" in block

    def test_the_suite_hands_the_run_the_box_and_a_row_without_one_gets_nothing(self):
        env = turn_input.env_for(ROW)
        assert json.loads(env[turn_input.ENV])["focus_region"]["page"] == 1
        assert turn_input.env_for({"id": "pv-x", "box": "found"}) == {}

    def test_install_patches_the_turn_parse_only_when_the_suite_asked(self, monkeypatch):
        monkeypatch.setattr(payload, "extract_turn_inputs", payload.extract_turn_inputs)
        original = payload.extract_turn_inputs
        assert turn_input.install({}) is False
        assert payload.extract_turn_inputs is original
        assert turn_input.install(turn_input.env_for(ROW)) is True
        assert payload.extract_turn_inputs("q").focus_region is not None

    def test_a_fresh_run_process_binds_the_wrapped_parse_through_sitecustomize(self):
        """What ``nat run`` gets: the workflow module imports the parse by name, after sitecustomize patched it."""
        import os
        import subprocess

        code = (
            "import aiq_agent.agents.piloti.conversation_register as c;"
            "i = c.extract_turn_inputs('hi'); print(i.surface, i.focus_file_name)"
        )
        env = {
            **os.environ,
            **turn_input.env_for(ROW),
            "PYTHONPATH": os.pathsep.join([str(REPO_ROOT / "scripts" / "turn_census"), str(REPO_ROOT / "src")]),
        }
        done = subprocess.run(
            [sys.executable, "-P", "-c", code], env=env, capture_output=True, text=True, timeout=170, check=False
        )
        assert done.stdout.strip() == "review_canvas EP-01_Grundrisse_Index-B.pdf", done.stderr[-500:]

    def test_a_given_box_row_without_a_gold_is_refused(self):
        with pytest.raises(ValueError, match="gold"):
            turn_input.message_fields({"id": "ns-x", "box": "given", "region": [0, 0, 0.1, 0.1], "gold": []})

    def test_the_suites_visual_run_carries_the_box(self):
        source = (REPO_ROOT / "scripts/turn_census/suite.py").read_text(encoding="utf-8")
        assert "**turn_input.env_for(question)" in source


@pytest.fixture
def bff(tmp_path):
    server = fixture_bff.FixtureBFF(TOKEN, tmp_path / "requests.jsonl").start()
    yield server
    server.stop()


def _envelope(bff, conversation: str) -> SignedEnvelope:
    header, signature = suite.precedent_envelope(OFFICE, conversation, TOKEN, {"id": "project-x"})
    return SignedEnvelope(header=header, signature=signature)


def _file(bff, conversation: str, monkeypatch, **fields) -> dict:
    """What the agent's own proposals client gets from the fixture BFF."""
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", bff.url)
    monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
    payload_ = {
        "operation": "move",
        "operations": [{"document": "Schreiben_MA37_Baubeginn.pdf", "target_folder": "Behörde"}],
    }
    body = proposals_client.proposal_request("file_operation", payload_)
    body.update(fields)
    return proposals_client.post_proposal(body, _envelope(bff, conversation))


class TestTheFixtureFilesProposals:
    def test_the_agents_client_gets_an_id_and_the_answer_fits_the_bffs_contract(self, bff, monkeypatch):
        answer = _file(bff, "conv-1", monkeypatch)
        Draft202012Validator(
            {**SCHEMA, "$ref": "#/$defs/InternalProposalResponse"}
            if "$defs" in SCHEMA
            else {**SCHEMA, "$ref": "#/definitions/InternalProposalResponse"}
        ).validate(answer)
        assert answer["status"] == "proposed"
        assert proposals_client._proposal_id(answer) == answer["id"]

    def test_the_proposal_is_recorded_for_its_conversation_with_what_it_proposes(self, bff, monkeypatch):
        _file(bff, "conv-1", monkeypatch)
        _file(bff, "conv-2", monkeypatch)
        filed = fixture_bff.proposals_filed(bff.log_path, "conv-1")
        assert len(filed) == 1
        assert filed[0]["kind"] == "file_operation"
        assert filed[0]["payload"]["operations"][0]["target_folder"] == "Behörde"
        assert fixture_bff.proposals_filed(bff.log_path, "conv-3") == []

    def test_the_same_card_of_the_same_answer_is_one_proposal(self, bff, monkeypatch):
        first = _file(bff, "conv-1", monkeypatch, answerMessageId="m1", originCardIndex=0)
        again = _file(bff, "conv-1", monkeypatch, answerMessageId="m1", originCardIndex=0)
        other = _file(bff, "conv-1", monkeypatch, answerMessageId="m1", originCardIndex=1)
        assert first["id"] == again["id"] != other["id"]

    @pytest.mark.parametrize("change", [{"op": "apply"}, {"kind": "telepathy"}, {"payload": "move it"}])
    def test_a_request_the_route_would_refuse_is_refused(self, bff, monkeypatch, change):
        with pytest.raises(proposals_client.ProposalRequestError) as refused:
            _file(bff, "conv-1", monkeypatch, **change)
        assert refused.value.status == 422
        assert fixture_bff.proposals_filed(bff.log_path, "conv-1") == []

    def test_a_request_without_the_service_token_is_dropped_like_any_other_route(self, bff):
        request = urllib.request.Request(f"{bff.url}{fixture_bff.PROPOSALS_PATH}", data=b"{}", method="POST")
        with pytest.raises((urllib.error.URLError, OSError)):
            urllib.request.urlopen(request, timeout=5)  # noqa: S310 - the fixture's own loopback address

    def test_a_direct_write_route_is_what_writes_attempted_reports(self, bff, monkeypatch):
        _file(bff, "conv-1", monkeypatch)
        assert fixture_bff.writes_attempted(bff.log_path, "conv-1") == []
        bff._log({"path": "/api/internal/document-versions", "served": False, "conversation": "conv-1"})
        assert fixture_bff.writes_attempted(bff.log_path, "conv-1") == ["/api/internal/document-versions"]
        assert fixture_bff.writes_attempted(bff.log_path, "conv-2") == []


class TestTheFixtureRecordsProposedMarks:
    """The canvas ``mark`` tool's own request, against the fixture BFF: a proposal is recorded, not written."""

    MARK = {
        "page": 2,
        "shape": "point",
        "x": 0.2,
        "y": 0.3,
        "kind": "hint",
        "body": "11 Wohnungen, Index B hat 10",
        "basis": "EP-01 S. 2",
    }

    def _post(self, bff, conversation: str, monkeypatch, payload: dict) -> dict:
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", bff.url)
        monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
        return canvas_client.post_canvas(payload, _envelope(bff, conversation))

    def test_a_proposal_is_numbered_back_and_read_from_the_log_for_its_conversation(self, bff, monkeypatch):
        payload = propose_payload([self.MARK])
        answer = self._post(bff, "conv-1", monkeypatch, payload)
        assert [item["number"] for item in answer["proposed"]] == [1]
        assert answer["proposed"][0]["body"] == self.MARK["body"]
        self._post(bff, "conv-2", monkeypatch, propose_payload([{**self.MARK, "body": "other"}]))
        marks = fixture_bff.marks_proposed(bff.log_path, "conv-1")
        assert [m["body"] for m in marks] == [self.MARK["body"]]
        assert fixture_bff.marks_proposed(bff.log_path, "conv-3") == []

    def test_a_proposal_is_not_a_direct_write(self, bff, monkeypatch):
        self._post(bff, "conv-1", monkeypatch, propose_payload([self.MARK]))
        assert fixture_bff.writes_attempted(bff.log_path, "conv-1") == []
        bff._log(
            {"path": fixture_bff.ANNOTATIONS_PATH, "body": {"op": "create"}, "served": False, "conversation": "conv-1"}
        )
        assert fixture_bff.writes_attempted(bff.log_path, "conv-1") == [fixture_bff.ANNOTATIONS_PATH]

    def test_a_list_finds_no_marks_and_an_op_the_set_does_not_serve_is_dropped(self, bff, monkeypatch):
        assert self._post(bff, "conv-1", monkeypatch, {"op": "list"}) == {"annotations": []}
        with pytest.raises(canvas_client.CanvasRequestError):
            self._post(bff, "conv-1", monkeypatch, {"op": "room"})
        assert fixture_bff.marks_proposed(bff.log_path, "conv-1") == []

    def test_the_files_run_carries_the_upload_trigger_and_reads_the_marks(self):
        source = (REPO_ROOT / "scripts/turn_census/suite.py").read_text(encoding="utf-8")
        assert source.count("**turn_input.env_for(question)") == 2
        assert "marks_proposed(requests, record.stem)" in source
