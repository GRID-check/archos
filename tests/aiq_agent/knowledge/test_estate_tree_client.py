"""The estate tree route's client: the bodies and answers are the contract's, and the envelope is echoed.

The contract is ``frontends/ui/tests/fixtures/estate-tree.schema.json``, exported
from ``lib/estate-tree/types.ts``. There is no Pydantic twin.
"""

from __future__ import annotations

import io
import json
import urllib.error
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

from aiq_agent.common import bff_http
from aiq_agent.common.bff_http import SignedEnvelope
from aiq_agent.knowledge import estate_tree_client as client

ROOT = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((ROOT / "frontends/ui/tests/fixtures/estate-tree.schema.json").read_text(encoding="utf-8"))
ENVELOPE = SignedEnvelope(header="eyJvcmciOiJvcmdfMSJ9", signature="c2ln")


def _validator(name):
    return Draft202012Validator({**SCHEMA["$defs"][name], "$defs": SCHEMA["$defs"]}, format_checker=FormatChecker())


ANSWER = {
    "shelf": "project",
    "collection": "proj_1",
    "folders": [
        {
            "id": "00000000-0000-4000-8000-000000000001",
            "parent_id": None,
            "name": "Leer",
            "path": "Leer",
            "description": "Noch nichts darin",
            "card": None,
        },
        {
            "id": "00000000-0000-4000-8000-000000000002",
            "parent_id": None,
            "name": "Einreichung",
            "path": "Einreichung",
            "description": None,
            "card": {"status": "fresh", "generated_at": "2026-10-20T08:00:00.000Z"},
        },
    ],
    "folders_truncated": False,
    "documents": [
        {
            "id": "00000000-0000-4000-8000-000000000003",
            "filename": "EP-01_Grundrisse_Index-B.pdf",
            "display_name": None,
            "folder_id": "00000000-0000-4000-8000-000000000002",
            "folder_path": "Einreichung",
            "collection": "proj_1",
            "content_type": "application/pdf",
            "file_size": 1024,
            "status": "completed",
            "authored_by": "user",
            "document_type": "floor_plan",
            "page_count": 4,
            "superseded": False,
            "plan_number": "EP-01",
            "plan_index": "B",
            "plan_date": "2026-09-30",
            "published_version": 2,
            "version_count": 2,
            "created_at": "2026-10-01T00:00:00.000Z",
            "updated_at": "2026-10-02T00:00:00.000Z",
        }
    ],
    "next_cursor": "WyJFUC0wMSIsIjAwIl0",
}


class _Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestTheWireContract:
    @pytest.mark.parametrize(
        "body",
        [
            client.tree_request("project"),
            client.tree_request("office_shelf", folder_path="Vorlagen", cursor="abc", limit=50),
            client.tree_request("session", limit=10_000),
        ],
        ids=["shelf-alone", "folder-page", "limit-clamped"],
    )
    def test_every_request_body_validates(self, body):
        assert [error.message for error in _validator("EstateTreeRequest").iter_errors(body)] == []

    def test_the_sample_answer_is_the_contract_s(self):
        assert [error.message for error in _validator("EstateTreeResponse").iter_errors(ANSWER)] == []

    def test_parses_folders_empty_ones_included_and_documents(self):
        tree = client.parse_tree(ANSWER)

        assert [folder.path for folder in tree.folders] == ["Leer", "Einreichung"]
        assert tree.folders[0].card is None and tree.folders[0].description == "Noch nichts darin"
        assert tree.folders[1].card == client.FolderCardMark(status="fresh", generated_at="2026-10-20T08:00:00.000Z")
        document = tree.documents[0]
        assert (document.document_type, document.page_count, document.published_version) == ("floor_plan", 4, 2)
        assert tree.next_cursor == ANSWER["next_cursor"]

    def test_an_answer_outside_the_contract_is_an_error(self):
        with pytest.raises(client.EstateTreeError):
            client.parse_tree({"shelf": "project", "folders": []})


class TestTransport:
    async def test_echoes_the_envelope_and_the_token(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_API_TOKEN", "t")
        seen = {}

        def opened(request, timeout):
            seen.update(
                url=request.full_url,
                method=request.method,
                token=request.headers["X-grid-internal-token"],
                header=request.headers["X-grid-request-context"],
                signature=request.headers["X-grid-request-context-sig"],
                body=json.loads(request.data),
            )
            return _Reply(json.dumps(ANSWER).encode())

        monkeypatch.setattr(bff_http._opener, "open", opened)

        tree = await client.read_estate_tree("project", ENVELOPE, folder_path="Einreichung", limit=2)

        assert seen["url"].endswith("/api/internal/estate-tree") and seen["method"] == "POST"
        assert (seen["token"], seen["header"], seen["signature"]) == ("t", ENVELOPE.header, ENVELOPE.signature)
        assert seen["body"] == {"shelf": "project", "folder_path": "Einreichung", "limit": 2}
        assert tree.shelf == "project"

    async def test_a_404_is_not_found_with_the_bff_s_sentence(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_API_TOKEN", "t")

        def refused(request, timeout):
            body = io.BytesIO(json.dumps({"error": "No folder with that path.", "code": "NOT_FOUND"}).encode())
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, body)

        monkeypatch.setattr(bff_http._opener, "open", refused)

        with pytest.raises(client.EstateTreeError) as caught:
            await client.read_estate_tree("project", ENVELOPE, folder_path="Personal")

        assert caught.value.not_found and str(caught.value) == "No folder with that path."
        assert caught.value.code == "NOT_FOUND"

    async def test_refuses_to_send_without_the_token(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)

        with pytest.raises(client.EstateTreeError, match="INTERNAL_API_TOKEN"):
            await client.read_estate_tree("session", ENVELOPE)

    async def test_an_unreachable_bff_is_an_error_not_an_empty_tree(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_API_TOKEN", "t")

        def down(request, timeout):
            raise urllib.error.URLError("connection refused")

        monkeypatch.setattr(bff_http._opener, "open", down)

        with pytest.raises(client.EstateTreeError, match="could not be reached") as caught:
            await client.read_estate_tree("office_shelf", ENVELOPE)
        assert not caught.value.not_found
