"""The names, limits and extension sets the estate tools share: the tool names the agent sees, the read caps, and
which files are images or models.
"""

from __future__ import annotations

import re

#: The tool names, spelled once: the hits' lane stamp and the Herleitung read them.
READ_FILE_TOOL = "read_file"

LS_TOOL = "ls"

GLOB_TOOL = "glob"

GREP_TOOL = "grep"

#: Characters one read returns (about 6k tokens), today's ``read_passage_ranges._MAX_READ_CHARS``. A read stops at
#: a page boundary past it and names the next call.
MAX_READ_CHARS = 24_000

#: Pages one ``pages=`` may ask for, today's ``read_passage_ranges._MAX_RANGE_PAGES``.
MAX_READ_PAGES = 30

#: Lines a text file read returns by default, the stock ``read_file``'s default.
DEFAULT_LINE_LIMIT = 100

#: How many paths a miss suggests, and how alike a name must be to be suggested.
MAX_SUGGESTIONS = 3

SUGGESTION_CUTOFF = 0.6

#: Image files: served as their caption, page-less (agent-filesystem.md §2).
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif")

#: An IFC model is a measurement source, not a passage: it gets no citable block.
MODEL_EXTENSIONS = (".ifc",)

_PAGES_ITEM = re.compile(r"^\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*$")
