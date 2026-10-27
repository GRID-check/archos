"""The text parsers for tool results, by tool name: which grammar a replayed tool result is read back in.

A live turn reads a tool's ``GroundingHit`` records (``extraction``); a turn replayed from its text has
only this. The built-in registrations are at the bottom of this file, in the order they are tried.
"""

from collections.abc import Callable

from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.entries import is_look_tool
from aiq_agent.citations.grounding_text import parse_knowledge_layer
from aiq_agent.citations.grounding_text import parse_look

SourceParser = Callable[[str, str], list[SourceEntry]]


_PARSER_REGISTRY: list[tuple[Callable[[str], bool], SourceParser]] = []


def register_source_parser(
    match_fn: Callable[[str], bool],
    parser_fn: SourceParser,
) -> None:
    """Register a parser for a tool name pattern.

    Args:
        match_fn: Predicate on lowercase tool name.
        parser_fn: (content, tool_name) -> list[SourceEntry]
    """
    _PARSER_REGISTRY.append((match_fn, parser_fn))


def parser_for(tool_name: str) -> SourceParser | None:
    """The first registered parser whose predicate matches ``tool_name`` (lowercased), or ``None``."""
    name_lower = tool_name.lower()
    for match_fn, parser_fn in _PARSER_REGISTRY:
        if match_fn(name_lower):
            return parser_fn
    return None


# --- The built-in parsers, in the order they are tried ------------------------

# Register knowledge layer as the only special-case parser.
# All other tools (Tavily, paper search, etc.) use the generic URL fallback.
register_source_parser(lambda name: "knowledge" in name, parse_knowledge_layer)


# ``ris_lookup`` emits the SAME grounding grammar (``ris_adapter.lookup``), so
# it gets the same parser rather than a second one: a RIS passage carries a
# Citation key, a Punkt (``§63Abs1``) and ``Dokumentart: gesetz``, and every one
# of those dies in the generic URL extractor — which is what the three older RIS
# tools still fall through to, correctly, because their output is references and
# a 40 000-character blob, not passages. One grammar, one parser, two producers.
register_source_parser(lambda name: "ris_lookup" in name, parse_knowledge_layer)


# ``read_passage`` is the third producer of that grammar: it renders through the
# knowledge layer's own ``_format_results``, and its name does not contain
# "knowledge", so it used to fall all the way through to the non-URL fallback and
# register ONE source whose citation key was the string "read_passage". A turn
# that opened a passage and cited it therefore had that citation dropped as
# ``citation_key_not_in_registry``, while the config comment beside the tool said
# the opposite. Registering it here is also what keeps the two readers level: the
# structured path reads its block by hash and would otherwise recover passages
# the text path cannot (ADR-0061).
register_source_parser(lambda name: "read_passage" in name, parse_knowledge_layer)


# The cross-project lookup (ADR-0094) renders its search hits in the same
# grammar, with a ``Projekt:`` line. A replayed turn reads them back here; its
# find and brief answers carry no ``Citation:`` line and so state no source.
register_source_parser(lambda name: "project_lookup" in name, parse_knowledge_layer)


# ``list_files`` is an INDEX, never evidence: a row proves a file exists, not
# what it says. It sits in the knowledge data source, so its output is captured
# like a search result, and with no parser it fell to the non-URL fallback and
# registered one citable source keyed "list_files" — a citation that resolves to
# a directory listing. Nothing it returns may ground a claim. ``endswith`` covers
# a group-qualified name (``knowledge__list_files``); registered after the
# knowledge parser, which a name containing "knowledge" reaches first and which
# also finds no ``Citation:`` line in a listing.
register_source_parser(lambda name: name.endswith("list_files"), lambda content, tool_name: [])


# ``look`` answers in the same grammar when it read a project or office document
# (``tools/look/place.py``): the reading is the passage, the region its box.
register_source_parser(is_look_tool, parse_look)


# The filesystem tools (ADR-0133). ``read_file`` and ``grep`` answer in the same grammar on the estate, so
# a replayed turn reads their passages back here; a DRAFT read through ``read_file`` carries no
# ``Citation:`` line, and the parser's answer (none) is final, so a draft never becomes a source. ``ls``
# and ``glob`` are an index, like ``list_files``: never evidence. Exact basenames, or a group-qualified
# one (``x__read_file``), never a substring: ``read_file`` must not catch some other ``*read_file*``.
_FILESYSTEM_PASSAGE_TOOLS = ("read_file", "grep")


_FILESYSTEM_INDEX_TOOLS = ("ls", "glob")


def _is_filesystem_tool(names: tuple[str, ...]) -> Callable[[str], bool]:
    return lambda name: any(name == base or name.endswith(f"__{base}") for base in names)


register_source_parser(_is_filesystem_tool(_FILESYSTEM_PASSAGE_TOOLS), parse_knowledge_layer)


register_source_parser(_is_filesystem_tool(_FILESYSTEM_INDEX_TOOLS), lambda content, tool_name: [])
