"""The title block (Plankopf) as evidence for Fassungen: the record, the comparison, and the judge's use of it.

Two documents with the same ``document_number`` are Fassungen of one document
whatever their file names share, and the Index (else the date) printed on the
sheet says which is newer, whatever the names say. The model is asked only when
the title blocks leave it open. Nothing asserts a model's prose.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.knowledge.document_revisions import TITLE_BLOCK_CONFIDENCE
from aiq_agent.knowledge.document_revisions import RevisionDocument
from aiq_agent.knowledge.document_revisions import build_judge_prompt
from aiq_agent.knowledge.document_revisions import judge_revision
from aiq_agent.knowledge.document_revisions import parse_revision_verdict
from aiq_agent.knowledge.document_revisions import rank_candidates
from aiq_agent.knowledge.document_revisions import settle_by_title_block
from aiq_agent.knowledge.title_block import compare_revisions
from aiq_agent.knowledge.title_block import document_key
from aiq_agent.knowledge.title_block import identifies_document
from aiq_agent.knowledge.title_block import newest_first
from aiq_agent.knowledge.title_block import normalise_date
from aiq_agent.knowledge.title_block import normalise_revision
from aiq_agent.knowledge.title_block import normalise_revision_facts
from aiq_agent.knowledge.title_block import same_document
from aiq_agent.knowledge.title_block import title_block_label


def _doc(name: str, *, facts: dict | None = None, **kwargs) -> RevisionDocument:
    return RevisionDocument(
        file_name=name, summary=kwargs.pop("summary", f"Beschreibung von {name}."), revision_facts=facts, **kwargs
    )


def _facts(number="A-101", revision=None, day=None, **extra) -> dict:
    facts = {"document_number": number, "revision": revision, "revision_date": day, **extra}
    return {key: value for key, value in facts.items() if value}


class TestTheRecord:
    @pytest.mark.parametrize(
        ("printed", "iso"),
        [
            ("2026-08-14", "2026-08-14"),
            ("14.08.2026", "2026-08-14"),
            ("14.8.26", "2026-08-14"),
            ("Stand: 14/08/2026", "2026-08-14"),
            ("1.2.2027", "2027-02-01"),
        ],
    )
    def test_a_printed_date_is_read_to_iso(self, printed, iso):
        assert normalise_date(printed) == iso

    @pytest.mark.parametrize("printed", ["08/2026", "31.02.2026", "2026-13-01", "gestern", "", None, 20260814, True])
    def test_a_date_that_is_not_a_calendar_day_is_none_never_repaired(self, printed):
        assert normalise_date(printed) is None

    @pytest.mark.parametrize(
        ("printed", "index"),
        [("C", "C"), ("Index C", "C"), ("idx: b", "b"), ("Rev. 07", "07"), ("07", "07"), ("A1", "A1"), (" D ", "D")],
    )
    def test_the_index_is_kept_as_printed_without_the_word_that_introduced_it(self, printed, index):
        assert normalise_revision(printed) == index

    @pytest.mark.parametrize("printed", ["", "-", "–", "n/a", "unbekannt", "null", None, ["C"], {"a": 1}, False])
    def test_nothing_printed_is_none(self, printed):
        assert normalise_revision(printed) is None

    def test_a_record_keeps_the_known_keys_that_hold_a_value(self):
        facts = normalise_revision_facts(
            {
                "document_number": "  A-101 ",
                "revision": "Index C",
                "revision_date": "14.08.2026",
                "scale": "1:100",
                "title": "Grundriss  EG",
                "invented": "x",
                "page": 3,
            }
        )
        assert facts == {
            "document_number": "A-101",
            "revision": "C",
            "revision_date": "2026-08-14",
            "scale": "1:100",
            "title": "Grundriss EG",
            "page": 3,
        }

    @pytest.mark.parametrize("raw", [None, "A-101", [], {}, {"document_number": None, "revision": "-"}, {"page": 2}])
    def test_a_record_with_nothing_printed_is_none(self, raw):
        assert normalise_revision_facts(raw) is None

    @pytest.mark.parametrize("page", [0, -1, "2", True, 1.5])
    def test_a_page_that_is_not_a_page_number_is_dropped(self, page):
        assert "page" not in normalise_revision_facts({"revision": "B", "page": page})

    def test_a_value_is_capped(self):
        assert len(normalise_revision_facts({"title": "x" * 500})["title"]) == 200

    def test_a_title_alone_does_not_say_which_document_or_state(self):
        assert identifies_document({"title": "Grundriss", "scale": "1:100"}) is False
        assert identifies_document({"revision": "B"}) is True
        assert identifies_document({"document_number": "A-101"}) is True
        assert identifies_document({"revision_date": "2026-08-14"}) is True
        assert identifies_document(None) is False

    def test_the_label_names_number_index_and_stand(self):
        assert title_block_label(_facts(revision="C", day="2026-08-14")) == "Nr. A-101, Index C, Stand 14.08.2026"
        assert title_block_label({"title": "Grundriss"}) == ""
        assert title_block_label(None) == ""


class TestTheSameDocument:
    @pytest.mark.parametrize("other", ["a 101", "A101", "A-101", "a.101"])
    def test_spellings_of_one_number_are_one_document(self, other):
        assert same_document({"document_number": "A-101"}, {"document_number": other})

    def test_another_number_is_another_document(self):
        assert not same_document({"document_number": "A-101"}, {"document_number": "A-102"})

    @pytest.mark.parametrize("number", ["1", "12", "EG", "--", "", None, 101])
    def test_a_number_too_short_or_without_a_digit_joins_nothing(self, number):
        assert document_key(number) is None
        assert not same_document({"document_number": number}, {"document_number": number})

    def test_a_missing_record_joins_nothing(self):
        assert not same_document(None, {"document_number": "A-101"})
        assert not same_document({"revision": "B"}, {"revision": "B"})


class TestWhichIsLater:
    @pytest.mark.parametrize(
        ("first", "second", "expected"),
        [
            ({"revision": "C"}, {"revision": "B"}, 1),
            ({"revision": "B"}, {"revision": "C"}, -1),
            ({"revision": "C"}, {"revision": "C"}, 0),
            ({"revision": "10"}, {"revision": "9"}, 1),
            ({"revision": "Z"}, {"revision": "A"}, 1),
            # The Index decides before the date does.
            ({"revision": "C", "revision_date": "2026-01-01"}, {"revision": "B", "revision_date": "2026-06-01"}, 1),
            # Same Index: the date decides.
            ({"revision": "B", "revision_date": "2026-09-01"}, {"revision": "B", "revision_date": "2026-06-01"}, 1),
            # No Index at all: the date decides.
            ({"revision_date": "2026-06-01"}, {"revision_date": "2026-09-01"}, -1),
            ({"revision_date": "2026-06-01"}, {"revision_date": "2026-06-01"}, 0),
        ],
    )
    def test_the_higher_index_then_the_later_date(self, first, second, expected):
        assert compare_revisions(first, second) == expected

    @pytest.mark.parametrize(
        ("first", "second"),
        [
            ({"revision": "C"}, {}),
            ({"revision": "C"}, {"revision": "2"}),
            ({"revision": "C"}, {"revision_date": "2026-06-01"}),
            ({"revision": "B1"}, {"revision": "B2"}),
            (None, None),
        ],
    )
    def test_unknown_is_none_never_a_guess(self, first, second):
        assert compare_revisions(first, second) is None

    def test_newest_first_is_the_index_when_every_item_has_one_of_a_kind(self):
        items = [
            ("a", {"revision": "B", "revision_date": "2026-09-01"}),
            ("b", {"revision": "C", "revision_date": "2026-01-01"}),
            ("c", {"revision": "A"}),
        ]
        assert [name for name, _ in newest_first(items, lambda i: i[1], lambda i: i[0])] == ["b", "a", "c"]

    def test_newest_first_is_the_date_when_an_index_is_missing_and_the_upload_settles_a_tie(self):
        items = [
            ("a", {"revision_date": "2026-09-01"}),
            ("b", {"revision": "C", "revision_date": "2026-01-01"}),
            ("c", {"revision_date": "2026-09-01"}),
        ]
        order = [name for name, _ in newest_first(items, lambda i: i[1], lambda i: i[0])]
        assert order == ["c", "a", "b"]


class TestCandidatesRankByTheNumber:
    def test_a_candidate_with_the_same_number_leads_though_its_name_shares_nothing(self):
        new = _doc("Entwurf_neu.pdf", facts=_facts(revision="C"), series_key="entwurf neu")
        by_name = _doc("Entwurf_alt.pdf", series_key="entwurf neu", doc_class="grundriss")
        by_number = _doc("Zeichnung 7.pdf", facts=_facts(revision="B"), series_key="zeichnung 7")
        other = _doc("Schnitt.pdf", facts=_facts("S-200", "A"))

        ranked = rank_candidates(new, [other, by_name, by_number])

        assert [c.file_name for c in ranked][0] == "Zeichnung 7.pdf"
        assert [c.file_name for c in ranked][1] == "Entwurf_alt.pdf"

    def test_without_title_blocks_the_order_is_what_it_was(self):
        new = _doc("A_Index_C.pdf", series_key="a", doc_class="x")
        series = _doc("A_Index_B.pdf", series_key="a")
        klass = _doc("b.pdf", doc_class="x")
        assert [c.file_name for c in rank_candidates(new, [klass, series])] == ["A_Index_B.pdf", "b.pdf"]


class TestTheTitleBlocksDecide:
    def test_the_new_document_with_the_higher_index_is_a_newer_fassung_of_the_one_with_the_same_number(self):
        new = _doc("Neu_Entwurf.pdf", facts=_facts(revision="C", day="2026-08-14"))
        older = _doc("Zeichnung 7.pdf", facts=_facts(revision="B", day="2026-06-01"))

        settled, verdict = settle_by_title_block(new, [older, _doc("andere.pdf", facts=_facts("S-200", "A"))])

        assert settled is True
        assert verdict is not None
        assert (verdict.of, verdict.basis, verdict.confidence) == (
            "Zeichnung 7.pdf",
            "title_block",
            TITLE_BLOCK_CONFIDENCE,
        )
        assert "A-101" in verdict.reason and "Index C statt B" in verdict.reason

    def test_with_several_older_states_the_newest_of_them_is_the_one_replaced(self):
        new = _doc("neu.pdf", facts=_facts(revision="D"))
        candidates = [
            _doc("x.pdf", facts=_facts(revision="A")),
            _doc("y.pdf", facts=_facts(revision="C")),
            _doc("z.pdf", facts=_facts(revision="B")),
        ]
        assert settle_by_title_block(new, candidates)[1].of == "y.pdf"

    def test_the_date_decides_when_there_is_no_index(self):
        new = _doc("neu.pdf", facts=_facts(day="2026-09-01"))
        older = _doc("alt.pdf", facts=_facts(day="2026-06-01"))
        settled, verdict = settle_by_title_block(new, [older])
        assert settled and verdict.of == "alt.pdf"
        assert "Stand 01.09.2026 statt 01.06.2026" in verdict.reason

    def test_the_title_block_beats_the_file_names(self):
        # The names say the new file is Index B and the candidate Index C; the sheets say the opposite.
        new = _doc("Grundriss_Index_B.pdf", facts=_facts(revision="C"), revision="Index B", series_key="grundriss")
        older = _doc("Grundriss_Index_C.pdf", facts=_facts(revision="B"), revision="Index C", series_key="grundriss")
        assert settle_by_title_block(new, [older])[1].of == "Grundriss_Index_C.pdf"

    def test_a_candidate_that_is_the_later_state_suggests_nothing(self):
        new = _doc("neu.pdf", facts=_facts(revision="B"))
        later = _doc("spaeter.pdf", facts=_facts(revision="C"))
        assert settle_by_title_block(new, [later]) == (True, None)

    def test_the_same_state_twice_is_a_copy_and_suggests_nothing(self):
        new = _doc("kopie.pdf", facts=_facts(revision="B"))
        assert settle_by_title_block(new, [_doc("original.pdf", facts=_facts(revision="B"))]) == (True, None)

    def test_an_index_on_one_side_only_leaves_it_open(self):
        new = _doc("neu.pdf", facts=_facts(revision="B"))
        assert settle_by_title_block(new, [_doc("alt.pdf", facts=_facts())]) == (False, None)

    def test_no_candidate_with_the_number_leaves_it_to_the_model(self):
        new = _doc("neu.pdf", facts=_facts(revision="B"))
        assert settle_by_title_block(new, [_doc("anders.pdf", facts=_facts("B-300", "A"))]) == (False, None)
        assert settle_by_title_block(_doc("ohne.pdf"), [_doc("alt.pdf", facts=_facts(revision="A"))]) == (False, None)


class TestTheJudge:
    @staticmethod
    def _llm(content: str) -> MagicMock:
        llm = MagicMock()
        llm.invoke.return_value = AIMessage(content=content)
        return llm

    def test_when_the_title_blocks_decide_no_model_is_called(self):
        llm = self._llm("{}")
        new = _doc("Neu_Entwurf.pdf", facts=_facts(revision="C"))
        verdict = judge_revision(new, [_doc("Zeichnung 7.pdf", facts=_facts(revision="B"))], llm)

        assert verdict is not None and verdict.basis == "title_block"
        llm.invoke.assert_not_called()

    def test_they_decide_without_any_model_at_all(self):
        new = _doc("Neu.pdf", facts=_facts(revision="C"))
        verdict = judge_revision(new, [_doc("Alt.pdf", facts=_facts(revision="B"))], None)
        assert verdict is not None and verdict.of == "Alt.pdf"

    def test_a_later_candidate_is_not_asked_about_either(self):
        llm = self._llm(json.dumps({"of": "spaeter.pdf", "confidence": 0.99, "reason": "x"}))
        new = _doc("neu.pdf", facts=_facts(revision="B"))
        assert judge_revision(new, [_doc("spaeter.pdf", facts=_facts(revision="C"))], llm) is None
        llm.invoke.assert_not_called()

    def test_when_they_leave_it_open_the_model_reads_the_facts_and_a_same_number_answer_is_title_block(self):
        llm = self._llm(json.dumps({"of": "alt.pdf", "confidence": 0.9, "reason": "Gleiche Zeichnung."}))
        new = _doc("neu.pdf", facts=_facts(revision="B"))
        verdict = judge_revision(new, [_doc("alt.pdf", facts=_facts()), _doc("x.pdf")], llm)

        assert verdict is not None and verdict.basis == "title_block" and verdict.of == "alt.pdf"
        prompt = llm.invoke.call_args.args[0]
        assert '"title_block": {"document_number": "A-101", "revision": "B"}' in prompt
        assert "outweighs `revision_from_name`" in prompt

    def test_the_title_block_never_carries_scale_or_title_into_the_prompt(self):
        new = _doc("neu.pdf", facts=_facts(revision="B", scale="1:50", title="Grundriss EG", page=2))
        new_line = build_judge_prompt(new, [_doc("alt.pdf")]).split("New document:\n")[1].split("\n")[0]
        assert json.loads(new_line)["title_block"] == {"document_number": "A-101", "revision": "B"}

    def test_a_verdict_names_its_basis_by_what_the_two_share(self):
        new = _doc("A_Index_C.pdf", facts=_facts(revision="C"), series_key="a")
        same_number = _doc("zzz.pdf", facts=_facts(revision="B"))
        same_name = _doc("A_Index_B.pdf", series_key="a")
        neither = _doc("q.pdf")
        reply = lambda name: json.dumps({"of": name, "confidence": 0.9, "reason": "Ja."})  # noqa: E731
        candidates = [same_number, same_name, neither]
        assert parse_revision_verdict(reply("zzz.pdf"), new, candidates).basis == "title_block"
        assert parse_revision_verdict(reply("A_Index_B.pdf"), new, candidates).basis == "name"
        assert parse_revision_verdict(reply("q.pdf"), new, candidates).basis == "content"
