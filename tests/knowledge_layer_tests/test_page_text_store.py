"""A version's page text, stored beside its file (ADR-0134): the contract the agent's file reader reads."""

from __future__ import annotations

import json

from knowledge_layer.llamaindex import page_text_store as store
from knowledge_layer.llamaindex.page_text_store import PageText


def _render(pages, **overrides):
    args = {
        "page_count": 3,
        "failed_pages": [],
        "document_id": "doc-1",
        "version": 2,
        "content_hash": "abc",
        "reader_version": "2026.10.1",
        "furniture_stripped": False,
        "created_at": "2026-10-27T10:00:00+00:00",
    }
    return store.render(pages, **{**args, **overrides})


def test_every_page_has_its_marker_and_the_index_locates_its_body():
    body, index = _render([PageText(1, "Baubeschreibung"), PageText(3, "Grundriss EG", "vlm_reading", "m/vlm")])
    text = body.decode("utf-8")

    assert text == "<!-- page 1 -->\nBaubeschreibung\n<!-- page 2 -->\n<!-- page 3 -->\nGrundriss EG\n"
    for entry in index["pages"]:
        assert body[entry["offset"] : entry["offset"] + entry["length"]].decode().strip() in (
            "Baubeschreibung",
            "",
            "Grundriss EG",
        )
    assert [p["page"] for p in index["pages"]] == [1, 2, 3]
    assert index["pages"][1]["length"] == 0
    assert index["pages"][2]["source"] == "vlm_reading" and index["pages"][2]["model"] == "m/vlm"
    assert index["file"] == {
        "document_id": "doc-1",
        "version": 2,
        "content_hash": "abc",
        "reader_version": "2026.10.1",
        "page_count": 3,
        "failed_pages": [],
        "furniture_stripped": False,
        "created_at": "2026-10-27T10:00:00+00:00",
    }
    assert index["schema_version"] == 1


def test_a_failed_page_keeps_its_entry_with_no_body():
    _, index = _render([PageText(2, "lost")], failed_pages=[2])
    assert index["pages"][1]["length"] == 0 and index["file"]["failed_pages"] == [2]


def test_offsets_are_bytes_not_characters():
    body, index = _render([PageText(1, "Gebäude ß"), PageText(2, "zwei")], page_count=2)
    second = index["pages"][1]
    assert body[second["offset"] : second["offset"] + second["length"]] == "zwei\n".encode()


def test_the_pipelines_pages_carry_what_read_them():
    pages = store.pdf_pages(
        [{"page_number": 1, "text": "Text"}, {"page_number": 2, "text": "Scan"}, {"page_number": 3, "text": "EP-05"}],
        transcribed={2: "Scan"},
        ocr_model="m/ocr",
        drawings=[{"page_number": 3, "caption": "Grundriss EG, 1:100"}],
        vision_model="m/vlm",
        tables=[{"page_number": 1, "table_text": "| Raum | Fläche |"}],
    )
    assert [(p.page, p.source, p.model) for p in pages] == [
        (1, "text_layer", None),
        (2, "ocr", "m/ocr"),
        (3, "vlm_reading", "m/vlm"),
    ]
    assert pages[0].text == "Text\n\n| Raum | Fläche |"
    assert pages[2].text == "EP-05\n\nGrundriss EG, 1:100"


def test_running_headers_are_stripped_and_recorded():
    bodies = ["Erdgeschoss Wohnen", "Obergeschoss Schlafen", "Dachgeschoss Technik", "Keller Lager"]
    pages = [
        PageText(n, f"Atelier Lindner ZT\nEinreichung Hubergasse\n{body}\nweitere Angaben\nSeite {n} von 4")
        for n, body in enumerate(bodies, start=1)
    ]
    stripped, furniture = store.strip_furniture(pages)
    assert furniture is True
    assert all("Atelier Lindner" not in page.text for page in stripped)
    assert [page.text.splitlines()[0] for page in stripped] == bodies


def test_pages_then_index_land_through_the_bffs_slots_and_the_index_names_the_row():
    calls: list[tuple[str, bytes]] = []

    def presign(document_id, collection, part, organization_id):
        return store.Slot(upload_url=f"https://s3.test/{part}", document_id=document_id, version=4, content_hash="h")

    ok = store.store_page_text(
        [PageText(1, "Text")],
        page_count=1,
        failed_pages=[],
        document_id="doc-1",
        collection="proj_1",
        presign=presign,
        upload=lambda url, body, content_type: calls.append((url, body)),
    )

    assert ok is True
    assert [url for url, _ in calls] == ["https://s3.test/pages.md", "https://s3.test/index.json"]
    index = json.loads(calls[1][1])
    assert (index["file"]["document_id"], index["file"]["version"], index["file"]["content_hash"]) == ("doc-1", 4, "h")


def test_no_slot_or_a_failed_upload_stores_nothing_and_never_raises():
    assert (
        store.store_page_text(
            [PageText(1, "x")], page_count=1, failed_pages=[], document_id="d", collection="c", presign=lambda *a: None
        )
        is False
    )

    def explode(url, body, content_type):
        raise RuntimeError("PUT failed")

    slot = store.Slot("https://s3.test/x", "d", 1, None)
    assert (
        store.store_page_text(
            [PageText(1, "x")],
            page_count=1,
            failed_pages=[],
            document_id="d",
            collection="c",
            presign=lambda *a: slot,
            upload=explode,
        )
        is False
    )
