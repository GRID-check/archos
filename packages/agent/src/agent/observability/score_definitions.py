"""Every score name Piloti writes, with its type and range (ADR-0089): the one list.

Split out of ``langfuse_scores.py``, which builds and posts the scores, so the
list can grow without that module growing. ``scripts/langfuse_provision.py``
makes a score config of each, ``docs/observability/langfuse.md`` documents
them, and ``packages/agent/tests/observability/test_langfuse_scores.py`` holds
the three together. Import them from either module.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DataType = Literal["NUMERIC", "CATEGORICAL", "BOOLEAN"]


@dataclass(frozen=True)
class ScoreDefinition:
    """One score name Grid writes, and the Langfuse score config that describes it."""

    name: str
    data_type: DataType
    description: str
    #: Who writes it: the agent at runtime, the BFF from a vote, a reviewer in
    #: an annotation queue, or a Langfuse LLM-as-a-judge evaluator.
    writer: Literal["agent", "bff", "annotation", "judge"] = "agent"
    categories: tuple[str, ...] = ()
    min_value: float | None = None
    max_value: float | None = None


#: Every score Grid writes. Adding a score means adding it here first.
SCORE_DEFINITIONS: tuple[ScoreDefinition, ...] = (
    ScoreDefinition(
        "user-feedback",
        "NUMERIC",
        "The asker's vote: 1 helpful, 0 not. Its mean is the helpful rate.",
        writer="bff",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "user-feedback-reason",
        "CATEGORICAL",
        "Why a down-voted answer was not helpful, as the asker chose it.",
        writer="bff",
        categories=("inaccurate", "wrong_source", "too_slow", "other"),
    ),
    ScoreDefinition(
        "piloti-decision",
        "CATEGORICAL",
        "A person's decision on something Piloti produced in this turn: a proposal or a proposed mark taken "
        "over (accepted) or dismissed, an applied change undone. Metadata names the subject and its id.",
        writer="bff",
        categories=("accepted", "dismissed", "undone"),
    ),
    ScoreDefinition(
        "diagram-filed",
        "CATEGORICAL",
        "A drawing Piloti made in this turn, filed into the project: as drawn, or edited by a person in the "
        "sketch editor first (ADR-0141). Metadata names the filed SVG's document id. The share edited is how "
        "often the drawing was a starting point rather than the result.",
        writer="bff",
        categories=("as_drawn", "edited"),
    ),
    ScoreDefinition(
        "sketch-revised",
        "NUMERIC",
        "A filed sketch saved again as a new Fassung (ADR-0148): the Fassung number reached, upserted once per "
        "sketch on the trace of the turn that drew it.",
        writer="bff",
        min_value=2,
    ),
    ScoreDefinition(
        "sketch-save",
        "CATEGORICAL",
        "One attempt to save a filed sketch as a new Fassung (ADR-0148), on the trace of the turn that drew it: "
        "saved; drafted (saved into the open Freigabe draft, nothing published); pdf_stale (saved, the PDF beside "
        "it not drawn again); conflict (409, a newer Fassung: the editor merges and tries again); review_open "
        "(409, a version is in review, nothing saved); refused (400, the comment names the rule). Metadata "
        "version_number, bumped, tombstoned, pdf, carried and lost on a save.",
        writer="bff",
        categories=("saved", "drafted", "pdf_stale", "conflict", "review_open", "refused"),
    ),
    ScoreDefinition(
        "sketch-pins-kept",
        "NUMERIC",
        "The share of a Skizze's pinned marks still on an element after they were carried onto a Fassung made "
        "current (a save, a Freigabe, an upload; ADR-0148), on the trace of the turn that drew it. 1 is every "
        "pin still on its elements; lower is pins whose elements are gone („Element gelöscht“). Metadata moved, "
        "lost and path (save or publish). Written only when a pin moved.",
        writer="bff",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "revision-notice",
        "NUMERIC",
        "How many marks Piloti proposed when it compared a new Fassung on its own (ADR-0130); 0 is compared, "
        "nothing visible. On the trace of the first page's vision call; with piloti-decision on those marks, "
        "the precision of noticing.",
        writer="bff",
        min_value=0,
    ),
    ScoreDefinition(
        "document-check",
        "NUMERIC",
        "How many marks Piloti proposed when it checked a new document against the project's other documents "
        "on its own (ADR-0130); 0 is checked, everything agrees. On the trace of the headless turn that ran "
        "the check; with piloti-decision on those marks, the precision of the check.",
        writer="bff",
        min_value=0,
    ),
    ScoreDefinition(
        "geometry-cold-ms",
        "NUMERIC",
        "Milliseconds the geometry service took for a call no cache answered (a model download, parse and "
        "element index build, ADR-0149), on the BFF's bim-geometry trace. What the first question about a "
        "model costs; the sizing signal for the geometry service's pods.",
        writer="bff",
        min_value=0,
    ),
    ScoreDefinition(
        "citation-health",
        "BOOLEAN",
        "True when citation verification found nothing to remove, patch or flag on this turn.",
    ),
    ScoreDefinition(
        "answer-grounded",
        "BOOLEAN",
        "False when sources were retrieved but no citation the answer made survived verification.",
    ),
    ScoreDefinition(
        "citations-removed",
        "NUMERIC",
        "How many citations verification dropped because they did not hold.",
        min_value=0,
    ),
    ScoreDefinition(
        "quotes-unverified",
        "NUMERIC",
        "Quoted spans no retrieved passage holds, after any patch.",
        min_value=0,
    ),
    ScoreDefinition(
        "retrieval-precision",
        "NUMERIC",
        "Share of the distinct sources retrieval returned that the answer cited.",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "citation-fallback",
        "BOOLEAN",
        "Retired with the single-source fallback (ADR-0125); no longer written. Kept so older traces chart.",
    ),
    ScoreDefinition(
        "sources-empty",
        "BOOLEAN",
        "True when a lookup ran and retrieved nothing, so the turn could not answer from sources.",
    ),
    ScoreDefinition(
        "answer-confidence",
        "CATEGORICAL",
        "The confidence the reader saw on the answer.",
        categories=("low", "medium", "high"),
    ),
    ScoreDefinition(
        "confidence-capped",
        "CATEGORICAL",
        "Which guard lowered the surfaced confidence, or none.",
        categories=(
            "none",
            "ungrounded",
            "quote_unverified",
            "normative_claim_uncited",
            "measurement_only",
            "citation_fallback",
        ),
    ),
    ScoreDefinition(
        "quotes-verbatim-rate",
        "NUMERIC",
        "Share of the checked quote lines whose wording a passage holds verbatim.",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "quotes-patched",
        "NUMERIC",
        "Misremembered quotes the repair pass corrected in place (ADR-0067).",
        min_value=0,
    ),
    ScoreDefinition(
        "dialect-repairs",
        "NUMERIC",
        "Answer-dialect blocks the pipeline had to repair before the reader saw them.",
        min_value=0,
    ),
    ScoreDefinition(
        "sketch-drawn",
        "CATEGORICAL",
        "One per excalidraw fence in an answer (ADR-0146): drawn, or refused by the fence check and shown as "
        "its source. The comment names the refusal; metadata counts the elements and the labels that read "
        "like a measurement, which a sketch must not claim.",
        categories=("drawn", "refused"),
    ),
    ScoreDefinition(
        "steer-count",
        "NUMERIC",
        "How many notes the asker typed into this turn while it ran; written only on a steered turn.",
        min_value=0,
    ),
    ScoreDefinition(
        "file-tools-used",
        "CATEGORICAL",
        "Which of the office-file moves a turn used (ADR-0127), as the files eval's arms define them: search "
        "(knowledge_search ranked by meaning, round 0 included), navigate (ls, glob, grep and read_file on the "
        "office's documents, their aliases list_files and read_passage, and knowledge_search in a literal mode, "
        "exact or regex), both, or none. A file call on the drafts is neither. Written on every turn that called "
        "a tool.",
        categories=("none", "search", "navigate", "both"),
    ),
    ScoreDefinition(
        "folder-card-fresh",
        "NUMERIC",
        "Share of the folders one folder-card pass claimed whose written card is fresh afterwards (ADR-0127): "
        "built, or unchanged because nothing it reads changed. Below 1 is a pass that hit the monthly budget "
        "or a failed build. Written on the pass's first folder-card generation.",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "card-validity",
        "CATEGORICAL",
        "Each envelope card that missed its schema: repaired, or dropped. Also `stripped`: a computing "
        "card (calculation, formula) that arrived with a field stating what the card computes (a result, "
        "a formula's limits), which validation removed; the comment counts the fields.",
        categories=("repaired", "dropped", "stripped"),
    ),
    ScoreDefinition(
        "formula-input-provenance",
        "NUMERIC",
        "Per formula card the answer carries (ADR-0143): the share of its inputs with a value that say where "
        "the value is written (a `source`, or a norm `reference`). Below 1 is a default the reader cannot "
        "trace before changing it. Metadata names the formula and counts inputs, sourced and unknown.",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "work-report-matches",
        "BOOLEAN",
        "On a work turn (kind work, ADR-0123): true when the report lists as many proposals as the turn put "
        "in front of the person as proposal cards. A reported proposal no write filed is dropped before this "
        "is counted (work-proposals-unfiled), so false is mostly a turn that filed a proposal it did not report.",
    ),
    ScoreDefinition(
        "work-proposals-unfiled",
        "NUMERIC",
        "On a work turn (kind work, ADR-0123): the report's proposed lines whose ref named no proposal this "
        "turn filed, dropped before the person saw them. Above zero is a turn that claimed a proposal it did not make.",
        min_value=0,
    ),
    ScoreDefinition(
        "confidence-judged-level",
        "CATEGORICAL",
        "The level the answer check gave the answer (ADR-0139): one model call grading the final answer "
        "against everything the turn registered, before the quote gate. Not written when the check was "
        "unavailable or the answer graded nothing.",
        categories=("low", "medium", "high"),
    ),
    ScoreDefinition(
        "confidence-judge-unavailable",
        "BOOLEAN",
        "On a turn whose answer was to be graded: true when the answer check could not run (no model, a "
        "timeout, an error, an unreadable reply) and the turn surfaced no level.",
    ),
    ScoreDefinition(
        "claims-by-class",
        "CATEGORICAL",
        "Retired with the per-sentence provenance classes (ADR-0139); no longer written. Kept so older traces chart.",
        categories=tuple(  # noqa: SIM905 - one line for a retired list
            "quoted cited cited_dropped record action measured observed reasoning model_knowledge".split()
        ),
    ),
    ScoreDefinition(
        "claims-normative-uncited",
        "NUMERIC",
        "Retired with the normative-claim detector (ADR-0139); no longer written. Kept so older traces chart.",
        min_value=0,
    ),
    ScoreDefinition(
        "look-count",
        "NUMERIC",
        "Looks Piloti made in the turn (ADR-0128): renders of a page, a region of it or an embedded image, "
        "whether or not the answer relies on them. Zero is a measurement.",
        min_value=0,
    ),
    ScoreDefinition(
        "looked-before-measurement",
        "BOOLEAN",
        "On a turn whose answer states a value read off a drawing (ADR-0128): true when Piloti had made a "
        "region look (not only an overview) at that drawing before it answered. Not written on a turn that "
        "states no such value.",
    ),
    ScoreDefinition(
        "citations-dropped-labelled",
        "NUMERIC",
        "Places the answer cited something that did not resolve, labelled in the text instead of removed.",
        min_value=0,
    ),
    ScoreDefinition(
        "thread-answered-in-place",
        "BOOLEAN",
        "On a turn asked to answer in an Anmerkung's thread: true when the model replied there itself, false "
        "when the socket had to post the answer for it. Not written when the turn may not post there.",
    ),
)

#: Scores a person or a judge writes inside Langfuse. Grid never writes these;
#: they are defined here so the provisioning script, the docs and the queue
#: agree on one name each.
REVIEW_AND_JUDGE_DEFINITIONS: tuple[ScoreDefinition, ...] = (
    ScoreDefinition(
        "review-correctness",
        "CATEGORICAL",
        "A domain reviewer's verdict on the answer's substance.",
        writer="annotation",
        categories=("correct", "partly_correct", "incorrect"),
    ),
    ScoreDefinition(
        "review-sources",
        "CATEGORICAL",
        "A domain reviewer's verdict on the sources the answer relied on.",
        writer="annotation",
        categories=("right_sources", "missing_sources", "wrong_sources"),
    ),
    ScoreDefinition(
        "judge-answers-question",
        "NUMERIC",
        "LLM judge: how directly the answer addresses what was asked, 0 to 1.",
        writer="judge",
        min_value=0,
        max_value=1,
    ),
    ScoreDefinition(
        "judge-uncited-claims",
        "BOOLEAN",
        "LLM judge: true when the answer states a normative requirement without a [N] citation.",
        writer="judge",
    ),
    ScoreDefinition(
        "judge-clarity",
        "CATEGORICAL",
        "LLM judge: whether a planner could act on the answer as written.",
        writer="judge",
        categories=("clear", "partly_clear", "unclear"),
    ),
)

SCORE_DEFINITIONS = SCORE_DEFINITIONS + REVIEW_AND_JUDGE_DEFINITIONS
