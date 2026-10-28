"""Where an answer's Markdown code is: fenced blocks and inline code, which no citation or quote check may touch."""

import re
from collections.abc import Callable
from collections.abc import Sequence

# Regions of the answer that are CODE, and therefore carry no quotations to
# verify. A mermaid node label is written `A["Anwendungsbereich"]`, which the
# ASCII branch of `QUOTED_SPAN_RE` reads as a quoted claim — so a sourced
# answer carrying a diagram had every one of its labels flagged, and
# `annotate_unverified_quotes` inserted its marker after the closing quote,
# i.e. INSIDE the bracket:
#
#     A["OIB-Richtlinie 2<br/>Brandschutz" [nicht wörtlich in der Quelle belegt]]
#
# That is not a mis-annotation, it is a syntax error: the diagram stops parsing,
# the frontend falls back to printing the source, and the reader gets a code
# listing where the answer promised a drawing. The same pass then reported the
# labels as unverified quotes, which caps the turn's confidence to "low" — so
# one diagram degraded the chip on an otherwise well-sourced answer.
_FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")


# Inline code, matched only outside fences. `\1` requires the same run length,
# and the lookarounds keep a ``longer`` run from closing a shorter one.
_INLINE_CODE_RE = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)", re.DOTALL)


def code_spans(
    text: str,
    *,
    include_inline: bool = True,
    unterminated_fence_is_code: bool = True,
) -> list[tuple[int, int]]:
    """Half-open ``(start, end)`` offsets of every code region in ``text``.

    Fenced blocks first (``` or ~~~, three or more, closed by at least as many
    of the same character), then inline spans in what is left.

    The defaults are the READER's contract (``verify_quoted_spans``): an
    UNTERMINATED fence runs to the end of the text, because a streaming answer
    meets this function mid-fence routinely and a half-written diagram is still
    code. A REWRITER over a complete document passes
    ``unterminated_fence_is_code=False``: there, run-to-EOF would silently
    exempt the whole rest of the report from URL hygiene on one broken fence.
    ``include_inline=False`` likewise serves a rewriter whose rule (markdown
    link collapse) must be allowed to span an inline code run inside a link's
    display text.
    """
    spans: list[tuple[int, int]] = []
    offset = 0
    fence: str | None = None
    fence_start = 0
    for line in text.splitlines(keepends=True):
        match = _FENCE_RE.match(line)
        marker = match.group(1) if match else None
        if fence is None:
            if marker is not None:
                fence, fence_start = marker, offset
        elif marker is not None and marker[0] == fence[0] and len(marker) >= len(fence):
            spans.append((fence_start, offset + len(line)))
            fence = None
        offset += len(line)
    if fence is not None and unterminated_fence_is_code:
        spans.append((fence_start, len(text)))

    if include_inline:
        for match in _INLINE_CODE_RE.finditer(text):
            if not any(start <= match.start() < end for start, end in spans):
                spans.append((match.start(), match.end()))
    return spans


def map_outside_code(
    text: str,
    transform: Callable[[str], str],
    *,
    include_inline: bool = True,
    unterminated_fence_is_code: bool = True,
) -> str:
    """Apply ``transform`` to everything in ``text`` except code.

    The companion to the skip in ``verify_quoted_spans``, for the passes that
    REWRITE rather than read. `sanitize_report` strips URLs and collapses runs
    of spaces across the whole answer body, and a mermaid fence is answer body:
    a `click` directive's URL became `[1]`, and two-space indentation became
    one. The diagram is the source, so editing it is editing the drawing.

    Segments rather than offsets, because a rewrite changes lengths: the spans
    are read once from the ORIGINAL text, the code between them is passed
    through untouched, and only the prose around it is transformed.

    Safe on the URL question, which is the one worth asking before declining to
    sanitize something. A URL inside a fence cannot become a link: mermaid runs
    at ``securityLevel: 'strict'`` (``features/diagrams/render-diagram.ts``),
    which refuses click bindings and DOMPurifies labels, and a fence that is not
    a diagram renders as a code listing, which is text.
    """
    spans = sorted(
        code_spans(
            text,
            include_inline=include_inline,
            unterminated_fence_is_code=unterminated_fence_is_code,
        )
    )
    if not spans:
        return transform(text)
    out: list[str] = []
    cursor = 0
    for start, end in spans:
        if start > cursor:
            out.append(transform(text[cursor:start]))
        out.append(text[max(cursor, start) : end])
        cursor = max(cursor, end)
    if cursor < len(text):
        out.append(transform(text[cursor:]))
    return "".join(out)


def inside(offset: int, spans: Sequence[tuple[int, int]]) -> bool:
    """Whether ``offset`` falls inside any of ``spans``."""
    return any(start <= offset < end for start, end in spans)
