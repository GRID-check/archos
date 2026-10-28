"""The language of the person's newest message, and the one line that says to answer in it.

WHY A LINE AND NOT A RULE
-------------------------
The static prompt says to write in the language of the person's newest
message, not of the turn context or the files (#1336). Measured on dev after
that rule shipped (2026-10-28, conversation ``s_db26a123…``): „What is this
project about?" in a German project was still answered entirely in German. The
turn context reaches the model as a human-role message right before the
question and is mostly German (profile values, project memory, the shelf and
folder names of the inventory, the office's instructions), so the nearest
human-role text the model reads is German whatever the rule says. A sentence in
the system prompt, 30 KB away, loses to that.

So the language is decided here, in code, and stated where the model reads it
last: one line after the turn context, right before the question
(:func:`answer_language_line`, appended by the prompt's ``with_answer_language``).

WHEN THERE IS NO LINE
---------------------
German is the product's default and the static prompt already shapes German
answers, so a German question gets no line. Neither does a message too short or
too mixed to call: „?", „ok", a name, „GK5". Those score low here and fall back
to the default. Only a confident non-German call writes the line, so the line
can only move an answer away from German when the person plainly wrote in
another language.

The detector is py3langid (a maintained fork of langid.py: naive Bayes over
byte n-grams, pure Python on numpy, its model in the wheel). It is restricted to
:data:`LANGUAGE_NAMES`, the languages an office in this market plausibly writes
in: the restriction is what calibrates the probabilities on short questions,
where an unrestricted model spreads them over 97 languages. Loaded once, at
boot (:func:`warm`), because the model takes a second to read.
"""

from __future__ import annotations

import functools
import re
from collections.abc import Sequence
from typing import NamedTuple

from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage

from aiq_agent.common.message_utils import content_to_text

#: The product's default answer language; a question in it gets no line.
DEFAULT_LANGUAGE = "de"

#: The languages the detector chooses between, by ISO 639-1 code, with the
#: English name the line uses. Every code is one py3langid's model knows.
LANGUAGE_NAMES: dict[str, str] = {
    "ar": "Arabic",
    "bg": "Bulgarian",
    "cs": "Czech",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fi": "Finnish",
    "fr": "French",
    "hr": "Croatian",
    "hu": "Hungarian",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "nl": "Dutch",
    "no": "Norwegian",
    "pl": "Polish",
    "pt": "Portuguese",
    "ro": "Romanian",
    "ru": "Russian",
    "sk": "Slovak",
    "sl": "Slovenian",
    "sr": "Serbian",
    "sv": "Swedish",
    "tr": "Turkish",
    "uk": "Ukrainian",
    "zh": "Chinese",
}

#: The probability below which a call is no call. Measured on 50 short office
#: questions (2026-10-28, the cases in ``tests/aiq_agent/common/test_question_language.py``):
#: an English question of three words or more scored 0.90 to 1.0, a German one was
#: never called another language above 0.5, and „ok danke", a name or „GK 5 OIB RL 2"
#: stayed under 0.5.
MIN_CONFIDENCE = 0.9

#: Fewer words than this is never called: one word („Summarize", „danke",
#: „Lacknergasse") says too little to move an answer off the default.
MIN_WORDS = 2

#: The detector reads this much of the message: enough to call any question,
#: and a pasted document cannot make the call cost more.
MAX_CHARS = 1000

_WORD = re.compile(r"[^\W\d_]{2,}")
#: Scripts written without spaces between words, where a sentence is one run.
_UNSPACED = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]{4,}")


class QuestionLanguage(NamedTuple):
    """The detector's call on one message: the code, its probability, and whether it moves the answer."""

    code: str
    confidence: float

    @property
    def instructs(self) -> bool:
        """Whether this call writes the line: confidently a language other than the default."""
        return self.code != DEFAULT_LANGUAGE and self.confidence >= MIN_CONFIDENCE


#: No call: the default, at no confidence.
UNDECIDED = QuestionLanguage(code=DEFAULT_LANGUAGE, confidence=0.0)


@functools.cache
def _identifier():  # noqa: ANN202 — py3langid ships no type information
    from py3langid.langid import MODEL_FILE
    from py3langid.langid import LanguageIdentifier

    identifier = LanguageIdentifier.from_model_file(MODEL_FILE, norm_probs=True)
    identifier.set_languages(list(LANGUAGE_NAMES))
    return identifier


def warm() -> None:
    """Read the model now, at boot, so no turn pays the second it takes."""
    _identifier()


def detect(text: str) -> QuestionLanguage:
    """The language of ``text``, or :data:`UNDECIDED` for a message too short to call. Never raises."""
    sample = text[:MAX_CHARS]
    if len(_WORD.findall(sample)) < MIN_WORDS and not _UNSPACED.search(sample):
        return UNDECIDED
    try:
        code, confidence = _identifier().classify(sample)
    except Exception:  # noqa: BLE001 — a failed call is the default language, never a failed turn
        return UNDECIDED
    return QuestionLanguage(code=str(code), confidence=round(float(confidence), 3))


def newest_question(messages: Sequence[BaseMessage]) -> str:
    """The text of the person's newest message: the last human message, or empty."""
    for message in reversed(messages):
        if isinstance(message, HumanMessage):
            return content_to_text(message.content)
    return ""


def question_language(messages: Sequence[BaseMessage]) -> QuestionLanguage:
    """The language of the person's newest message in ``messages``."""
    return detect(newest_question(messages))


def answer_language_line(language: QuestionLanguage) -> str | None:
    """The one line the turn context ends with, or None when the answer stays in the default.

    English, like everything the agent reads, and naming why: the context above
    it and the files are in another language, and that is no reason to switch.
    """
    if not language.instructs:
        return None
    name = LANGUAGE_NAMES.get(language.code, language.code)
    return (
        f"Answer in {name}: the person's newest message is in {name}. "
        "The context above and the files may be German; quote them as written, and write everything else, "
        f"headings and the references label included, in {name}."
    )


def trace_metadata(language: QuestionLanguage) -> dict[str, object]:
    """The trace metadata this call is recorded as (``docs/observability/langfuse.md``)."""
    return {
        "question_language": language.code if language.confidence > 0 else "undetermined",
        "question_language_confidence": language.confidence,
        "answer_language_instructed": language.instructs,
    }
