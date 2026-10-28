"""The detector's call on short office questions: confident non-German writes the line, everything else does not.

The cases are the measurement behind ``MIN_CONFIDENCE`` and ``MIN_WORDS``
(2026-10-28). A failure here after a py3langid upgrade means the thresholds are
measured again, not that the case is dropped.
"""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from agent.common.question_language import DEFAULT_LANGUAGE
from agent.common.question_language import UNDECIDED
from agent.common.question_language import answer_language_line
from agent.common.question_language import detect
from agent.common.question_language import question_language
from agent.common.question_language import trace_metadata

CONFIDENTLY_OTHER = [
    ("What is this project about?", "en"),
    ("Which fire rating applies to the stairs?", "en"),
    ("Can you summarise the Einreichplan?", "en"),
    ("What does OIB-RL 2 say about Fluchtwege?", "en"),
    ("Is there a garage?", "en"),
    ("Show me the plans", "en"),
    ("Qu'est-ce que ce projet?", "fr"),
    ("Czym jest ten projekt?", "pl"),
    ("这个项目是关于什么的？", "zh"),
]

GERMAN = [
    "Worum geht es in diesem Projekt?",
    "Welche Brandschutzanforderungen gelten für das Stiegenhaus?",
    "Was ist die Gebäudeklasse?",
    "Fasse mir das Projekt zusammen",
    "Wie hoch darf ich bauen",
    "Und die Stiegen?",
    "Welche Dokumente fehlen?",
    "Kannst du das prüfen?",
    "Ist das ok so?",
    "Danke dir!",
    "Bitte als Tabelle",
]

AMBIGUOUS = [
    "?",
    "ok",
    "Hi",
    "danke",
    "Summarize",
    "GK5",
    "Matthias Bigl",
    "Lacknergasse 98",
    "ok danke",
    "",
    "GK 5 OIB RL 2",
    "Holzbau Wien",
    "Is the Stiege ok?",
    "go ahead",
    "ja bitte",
]


@pytest.mark.parametrize(("text", "code"), CONFIDENTLY_OTHER)
def test_a_plainly_foreign_question_is_called_and_instructs(text, code):
    language = detect(text)
    assert language.code == code
    assert language.instructs


@pytest.mark.parametrize("text", GERMAN)
def test_a_german_question_never_instructs(text):
    assert not detect(text).instructs


@pytest.mark.parametrize("text", AMBIGUOUS)
def test_a_short_or_mixed_message_stays_on_the_default(text):
    assert not detect(text).instructs


def test_one_word_is_never_called():
    assert detect("Summarize") == UNDECIDED


def test_the_newest_human_message_decides_not_an_earlier_one_or_the_answer():
    messages = [
        HumanMessage(content="Worum geht es in diesem Projekt?"),
        AIMessage(content="Das Projekt ist ein Zubau in Holzbauweise."),
        HumanMessage(content="Which fire rating applies to the stairs?"),
    ]
    assert question_language(messages).code == "en"
    assert question_language(messages[:2]).code == DEFAULT_LANGUAGE


def test_a_multimodal_message_is_read_by_its_text():
    message = HumanMessage(content=[{"type": "text", "text": "What is shown on this drawing?"}])
    assert question_language([message]).instructs


def test_the_line_names_the_language_and_only_then_exists():
    assert answer_language_line(detect("Wie hoch darf ich bauen")) is None
    assert answer_language_line(UNDECIDED) is None
    line = answer_language_line(detect("What is this project about?"))
    assert line is not None and line.startswith("Answer in English")


def test_the_trace_names_the_call_and_whether_it_instructed():
    assert trace_metadata(detect("What is this project about?")) == {
        "question_language": "en",
        "question_language_confidence": 1.0,
        "answer_language_instructed": True,
    }
    assert trace_metadata(UNDECIDED) == {
        "question_language": "undetermined",
        "question_language_confidence": 0.0,
        "answer_language_instructed": False,
    }
