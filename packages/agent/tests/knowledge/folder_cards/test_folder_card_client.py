"""The folder cards route's client: the bodies are the contract's, and a 404 is an answer, not a crash.

The contract is ``apps/workspace/tests/fixtures/folder-cards.schema.json``, exported
from ``lib/folder-cards/types.ts``. There is no Pydantic twin.
"""

from __future__ import annotations

import io
import json
import urllib.error

import pytest
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

from aiq_agent.common import bff_http
from aiq_agent.knowledge.folder_cards import client
from aiq_agent.knowledge.folder_cards.build import KeyFact


def _validator(schema, name):
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]}, format_checker=FormatChecker())


def _body(**overrides):
    body = client.put_request(
        organization_id="org_1",
        collection="proj_abc",
        folder_path="Gutachten/Brandschutz",
        abstract="Brandschutzgutachten zum Wohnhaus.",
        key_facts=[
            KeyFact("Das Gutachten liegt vor.", ("BS.pdf",), "4-6").wire(),
            KeyFact("Ohne Seite.", ("A.pdf",)).wire(),
        ],
        input_hash="a" * 64,
        abstract_hash="b" * 64,
        model="test/summary-model",
        prompt_version="folder-card-v1",
        status="fresh",
    )
    return {**body, **overrides}


class TestTheWireContract:
    @pytest.mark.parametrize(
        "body",
        [_body(), _body(abstract=None, abstract_hash=None, key_facts=[], status="stale"), _body(status="failed")],
        ids=["fresh", "stale-without-abstract", "failed"],
    )
    def test_every_put_body_validates(self, folder_cards_schema, body):
        errors = [error.message for error in _validator(folder_cards_schema, "PutFolderCardRequest").iter_errors(body)]

        assert errors == []

    def test_a_fact_without_pages_leaves_the_key_out(self):
        assert KeyFact("Ohne Seite.", ("A.pdf",)).wire() == {"statement": "Ohne Seite.", "documents": ["A.pdf"]}


class _Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TestTransport:
    def test_get_keys_cards_by_path(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_API_TOKEN", "t")
        seen = {}

        def opened(request, timeout):
            seen.update(url=request.full_url, token=request.headers["X-internal-token"], method=request.method)
            return _Reply(json.dumps({"cards": [{"folder_path": "A/B", "abstract": "x"}]}).encode())

        monkeypatch.setattr(bff_http._opener, "open", opened)

        assert client.get_cards("org_1", "proj") == {"A/B": {"folder_path": "A/B", "abstract": "x"}}
        assert seen["method"] == "GET" and seen["token"] == "t"
        assert "organization_id=org_1" in seen["url"] and "collection=proj" in seen["url"]

    def test_read_collection_lists_every_owned_folder_even_undescribed(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_API_TOKEN", "t")
        reply = {
            "cards": [],
            "folders": [
                {"folder_path": "A/", "folder_description": None},
                {"folder_path": "B", "folder_description": "Pläne"},
            ],
        }
        monkeypatch.setattr(bff_http._opener, "open", lambda request, timeout: _Reply(json.dumps(reply).encode()))

        cards, descriptions, owned = client.read_collection("org_1", "proj")

        assert (cards, descriptions, owned) == ({}, {"B": "Pläne"}, {"A", "B"})

    def test_a_reply_without_folders_owns_nothing_known(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_API_TOKEN", "t")
        monkeypatch.setattr(bff_http._opener, "open", lambda request, timeout: _Reply(b'{"cards": []}'))

        assert client.read_collection("org_1", "proj")[2] is None

    def test_a_404_on_put_is_no_folder(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_API_TOKEN", "t")

        def refused(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 404, "not found", {}, io.BytesIO(b"{}"))

        monkeypatch.setattr(bff_http._opener, "open", refused)

        assert client.put_card(_body()) is False
        assert client.delete_card("org_1", "proj", "A") is False

    def test_no_token_is_an_error_not_a_silent_success(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_API_TOKEN", raising=False)

        with pytest.raises(client.FolderCardsError):
            client.get_cards("org_1", "proj")
