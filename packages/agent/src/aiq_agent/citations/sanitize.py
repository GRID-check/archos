"""``sanitize_report``: the final report's display normalisation and URL hygiene."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from dataclasses import field
from urllib.parse import urlparse

from aiq_agent.citations.entries import normalize_url
from aiq_agent.citations.extraction import URL_TRIM_CHARS
from aiq_agent.citations.markdown_code import map_outside_code
from aiq_agent.citations.references import CITATION_LINE_RE
from aiq_agent.citations.references import REFERENCE_SECTION_RE
from aiq_agent.citations.report_layout import normalize_citation_syntax
from aiq_agent.citations.report_layout import normalize_source_section_layout
from aiq_agent.citations.report_layout import renumber_citations

logger = logging.getLogger(__name__)


# Known URL shortener domains
_SHORTENER_DOMAINS = frozenset(
    {
        "bit.ly",
        "tinyurl.com",
        "t.co",
        "goo.gl",
        "ow.ly",
        "is.gd",
        "buff.ly",
        "short.io",
        "rb.gy",
        "cutt.ly",
        "lnkd.in",
        "soo.gd",
        "s.coop",
        "cli.gs",
        "budurl.com",
        "yourls.org",
    }
)


# Patterns indicating a truncated/garbled URL
_TRUNCATED_URL_RE = re.compile(r"\.\.\.$|…$")  # ends in ... or ellipsis


# Suspicious URL patterns
_IP_ADDRESS_RE = re.compile(r"^https?://\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}")


_SUSPICIOUS_SCHEMES_RE = re.compile(r"^(?:javascript|data|vbscript|file):", re.IGNORECASE)


# See _GENERIC_URL_RE for the rationale on why ``,`` is matched and stripped
# via URL_TRIM_CHARS rather than excluded in the character class.
_BARE_URL_RE = re.compile(r"https?://[^\s<>\"'\]]+")


# Body URL patterns (used by sanitize_report)
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(\s*\w+://[^\s)]+\)")


_BODY_URL_RE = re.compile(r"\w+://[^\s<>\"'\]]+")


# Whatever gets removed from mid-sentence (a stripped URL, an empty pair of
# parentheses, or an inline [N] that verification dropped) leaves the space that
# preceded it stranded in front of the punctuation that followed, so
# "eine jaehrliche Begehung [3]." reaches the reader as "Begehung .". Spaces and
# tabs only, never a newline, so punctuation is never pulled up onto the
# previous line, and never a line's leading indentation. A colon glued to a
# letter or another colon is not punctuation: it opens a Markdown directive
# (`:energy-class[B]`, `:current`, an indented `:::details`), and pulling the space
# out of „Klasse :energy-class[B]" welds the marker onto the word before it.
_SPACE_BEFORE_PUNCTUATION_RE = re.compile(r"(?<=\S)[ \t]+(?=[.,;!?]|:(?![^\W\d_]|:))")


@dataclass
class ReportSanitizationResult:
    """Result of running sanitize_report()."""

    sanitized_report: str
    body_urls_removed: int
    body_urls_replaced: int
    shortened_urls_removed: list[str]
    truncated_urls_removed: list[str]
    unsafe_urls_removed: list[str]
    # old ``[N]`` → new ``[N]`` for the gap-closing renumber this pass applied.
    # ``verify_citations`` hands callers a ``[N]``→source binding computed BEFORE
    # this renumbering, so a caller that puts those numbers on the wire has to
    # remap them or the chips end up labelled with numbers the prose no longer
    # uses. Empty when no source section was present or nothing moved.
    renumber_map: dict[int, int] = field(default_factory=dict)
    # Original (pre-renumber) ``[N]`` numbers whose source lines this pass
    # deleted (shortened / truncated / unsafe URLs). Callers that put
    # ``verify_citations`` numbers on the wire MUST drop these entries
    # fail-closed: without them a chip stays trusted/clickable at a URL the
    # prose no longer cites. Empty when nothing was deleted.
    removed_citation_numbers: set[int] = field(default_factory=set)


def sanitize_report(report_text: str) -> ReportSanitizationResult:
    """Deterministic report hygiene and final display normalization.

    Checks:
    1. Normalize the source-section heading and one-source-per-line layout.
    2. Strip body URLs — collapse markdown links to display text, replace
       bare URLs that match a reference with ``[N]``, remove the rest.
    3. Remove shortened/obfuscated URLs from Sources — all URLs must
       be fully expanded (no bit.ly, t.co, etc.).
    4. Remove truncated/garbled URLs — URLs ending in '...' or with no
       path (domain-only like 'https://arxiv.org') are incomplete.
    5. Block unsafe URLs — no IP-address URLs, no non-http schemes.
    6. Renumber citations after verification/sanitization and trim any
       trailing source-section meta-commentary.

    Args:
        report_text: Report text (ideally after verify_citations()).

    Returns:
        ReportSanitizationResult with cleaned report and audit trail.
    """
    report_text = normalize_citation_syntax(report_text)

    # Split into body and source section
    ref_match = REFERENCE_SECTION_RE.search(report_text)
    if ref_match:
        body = report_text[: ref_match.start()]
        ref_section = normalize_source_section_layout(report_text[ref_match.start() :])
    else:
        body = report_text
        ref_section = ""

    # --- Check 1: Strip body URLs ---
    body_urls = _BodyUrls(ref_section)
    cleaned_body = body_urls.clean(body)

    # --- Checks 3 & 4: Validate URLs in source section ---
    # Deaths this pass caused: pre-renumber [N] numbers whose source lines are
    # deleted below. Returned so wire callers can drop the matching chips
    # fail-closed instead of remapping a dead number onto a survivor.
    vetted = _vet_source_urls(ref_section)
    ref_section = vetted.ref_section
    # Strip orphaned inline [N] from body
    for num in vetted.removed_numbers:
        cleaned_body = re.sub(rf"\[{num}\]", "", cleaned_body)

    # Renumber citations to close any gaps (from verify_citations and/or sanitize removals)
    renumber_map: dict[int, int] = {}
    if ref_section:
        cleaned_body, ref_section, renumber_map = renumber_citations(cleaned_body, ref_section)

    sanitized_report = _strip_tool_call_fragments(cleaned_body + ref_section)
    if ref_section:
        sanitized_report = _trim_after_last_citation(sanitized_report)

    return ReportSanitizationResult(
        sanitized_report=sanitized_report,
        body_urls_removed=body_urls.removed,
        body_urls_replaced=body_urls.replaced,
        shortened_urls_removed=vetted.shortened,
        truncated_urls_removed=vetted.truncated,
        unsafe_urls_removed=vetted.unsafe,
        renumber_map=renumber_map,
        removed_citation_numbers=vetted.removed_numbers,
    )


class _BodyUrls:
    """URL hygiene for the report body: a URL a reference lists becomes its ``[N]``, any other is removed."""

    def __init__(self, ref_section: str) -> None:
        self.removed = 0
        self.replaced = 0
        # URL → citation number from the references, so matching body URLs
        # are replaced with [N] instead of being deleted entirely.
        self._url_to_citation: dict[str, int] = {}
        for m in CITATION_LINE_RE.finditer(ref_section):
            url_m = _BARE_URL_RE.search(m.group(2))
            if url_m:
                self._url_to_citation[normalize_url(url_m.group(0).rstrip(URL_TRIM_CHARS))] = int(m.group(1))

    def clean(self, body: str) -> str:
        """The body with its links collapsed to their text and its bare URLs replaced or removed.

        Prose only — every rule here is about how a SENTENCE should read, and none
        of them is true of code: the space collapse alone rewrites a diagram's
        indentation. Two passes, because the rules protect different spans:
          1. Link collapse skips only FENCES. A link's display text may itself
             carry inline code (`[den ``pulumi`` Befehl](url)`), and segmenting at
             the inline span would split the link so it never collapses — the URL
             half then rots in the reader-visible report.
          2. URL/space hygiene skips fences AND inline code, computed on the
             link-collapsed text.
        Both passes treat an unterminated fence as prose: this runs on the
        COMPLETE report (unlike the streaming reader), and run-to-EOF would
        exempt everything after one broken fence from URL hygiene.
        """
        cleaned = map_outside_code(
            body,
            lambda segment: _MD_LINK_RE.sub(r"\1", segment),
            include_inline=False,
            unterminated_fence_is_code=False,
        )
        cleaned = map_outside_code(cleaned, self._clean_prose, unterminated_fence_is_code=False)
        if self.replaced:
            logger.debug("[ReportSanitize] Replaced %d body URL(s) with citation numbers", self.replaced)
        if self.removed:
            logger.debug("[ReportSanitize] Removed %d unmatched URL(s) from report body", self.removed)
        return cleaned

    def _replace_url(self, match: re.Match) -> str:
        normalized = normalize_url(match.group(0).rstrip(URL_TRIM_CHARS))
        if normalized in self._url_to_citation:
            self.replaced += 1
            return f"[{self._url_to_citation[normalized]}]"
        self.removed += 1
        return ""

    def _clean_prose(self, segment: str) -> str:
        # Replace matching bare URLs with [N], strip the rest
        segment = _BODY_URL_RE.sub(self._replace_url, segment)
        # Clean up leftover empty parentheses and extra spaces
        segment = re.sub(r"\(\s*\)", "", segment)
        # Runs inside a line only: leading indentation nests a list item or a
        # directive block (`   :::details`) under the one above it.
        segment = re.sub(r"(?<=\S)  +", " ", segment)
        return _SPACE_BEFORE_PUNCTUATION_RE.sub("", segment)


@dataclass
class _VettedSources:
    """The source section without the lines whose URL is shortened, truncated or unsafe, and what went."""

    ref_section: str
    removed_numbers: set[int] = field(default_factory=set)
    shortened: list[str] = field(default_factory=list)
    truncated: list[str] = field(default_factory=list)
    unsafe: list[str] = field(default_factory=list)


def _url_problem(line: str, url_match: re.Match) -> tuple[str, str] | None:
    """Why the URL on a source line may not stay (``shortened``, ``truncated``, ``unsafe``) and the URL, or None."""
    url = url_match.group(0).rstrip(URL_TRIM_CHARS)
    # Check for non-http schemes embedded in text
    if _SUSPICIOUS_SCHEMES_RE.search(line):
        return "unsafe", url
    parsed = urlparse(url)
    # Check 2: shortened URLs. Strip www. and port for comparison
    bare_domain = parsed.netloc.lower().split(":")[0]
    if bare_domain.startswith("www."):
        bare_domain = bare_domain[4:]
    if bare_domain in _SHORTENER_DOMAINS:
        return "shortened", url
    # Check 3: truncated/garbled URLs — only catch obvious truncation markers
    raw_url = url_match.group(0)
    if _TRUNCATED_URL_RE.search(raw_url) or "…" in raw_url:
        return "truncated", raw_url
    # Check 4: IP address URLs and non-http schemes
    if _IP_ADDRESS_RE.match(url) or parsed.scheme not in ("http", "https"):
        return "unsafe", url
    return None


def _vet_source_urls(ref_section: str) -> _VettedSources:
    """Drop the source lines whose URL fails a check, recording each and the ``[N]`` numbers that went.

    The removed numbers are the deaths the wire must drop fail-closed (a chip at
    a removed URL must never stay trusted/clickable).
    """
    vetted = _VettedSources(ref_section=ref_section)
    if not ref_section:
        return vetted
    ref_lines = ref_section.split("\n")
    kept: list[str] = []
    for line in ref_lines:
        url_match = _BARE_URL_RE.search(line)
        problem = _url_problem(line, url_match) if url_match else None
        if problem is None:
            kept.append(line)
            continue
        kind, url = problem
        getattr(vetted, kind).append(url)
        if line_m := CITATION_LINE_RE.match(line):
            vetted.removed_numbers.add(int(line_m.group(1)))
    if len(kept) != len(ref_lines):
        vetted.ref_section = "\n".join(kept)
    for kind, what in (("shortened", "shortened"), ("truncated", "truncated/incomplete"), ("unsafe", "unsafe")):
        if urls := getattr(vetted, kind):
            logger.debug("[ReportSanitize] Removed %d %s URL(s) from references: %s", len(urls), what, urls)
    return vetted


def _strip_tool_call_fragments(report: str) -> str:
    """The report cut at the first leaked tool-call XML fragment: LLMs sometimes output raw tool-call syntax as text."""
    return re.sub(
        r"</?(parameter|function|tool_call|tool_use|invoke|antml:[\w]+)[\s>].*",
        "",
        report,
        flags=re.DOTALL,
    )


def _trim_after_last_citation(report: str) -> str:
    """Everything after the last ``[N]`` source line cut.

    The LLM often appends meta-commentary after the references (e.g.,
    "All citations refer to...", "This report meets..."). Rather than
    pattern-matching specific phrases, just cut after the last [N] line.
    """
    last_citation_end = None
    for m in CITATION_LINE_RE.finditer(report):
        last_citation_end = m.end()
    if last_citation_end is None:
        return report
    return report[:last_citation_end].rstrip() + "\n"
