"""How much of a PDF was read, and why the rest was not: a number on the document instead of a log line."""

from __future__ import annotations

from knowledge_layer.coverage import reading_coverage


def _coverage(**overrides):
    args = {
        "page_count": 40,
        "text_pages": [{"page": n, "text": f"Seite {n}"} for n in range(1, 36)] + [{"page": 36, "text": " "}],
        "drawing_pages": set(range(21, 46)),
        "rendered": 20,
        "read": 19,
        "transcribed": 3,
        "transcription_failed": 1,
        "transcription_over_cap": 0,
        "not_transcribed": 0,
        "vision_configured": True,
    }
    return reading_coverage(**{**args, **overrides})


def test_every_page_left_unread_is_counted_under_its_reason():
    record = _coverage()
    assert record["reasons"] == {"render_cap": 5, "vision_failed": 1, "transcription_failed": 1}
    assert record["not_read"] == 7
    assert record["drawings"] == 25 and record["drawings_read"] == 19


def test_transcribed_pages_are_not_also_counted_as_text_layer_pages():
    record = _coverage()
    assert record["transcribed"] == 3
    assert record["text"] == 35 - 3


def test_a_fully_read_document_has_no_reasons():
    record = _coverage(drawing_pages={1, 2}, rendered=2, read=2, transcription_failed=0)
    assert record["not_read"] == 0 and record["reasons"] == {}


def test_without_a_vision_model_the_drawings_and_scans_are_unread_for_that_reason():
    record = _coverage(
        drawing_pages={1, 2, 3},
        rendered=0,
        read=0,
        transcribed=0,
        transcription_failed=0,
        not_transcribed=2,
        vision_configured=False,
    )
    assert record["reasons"] == {"no_vision": 5}


def test_an_unmeasured_pdf_counts_what_was_rendered():
    record = _coverage(drawing_pages=None, rendered=4, read=4, transcription_failed=0)
    assert record["drawings"] == 4 and record["not_read"] == 0


def test_a_document_without_pages_has_no_record():
    assert _coverage(page_count=0) is None


def test_not_read_never_exceeds_the_pages():
    record = _coverage(page_count=3, drawing_pages=set(range(1, 30)), rendered=0, read=0)
    assert record["not_read"] == 3
