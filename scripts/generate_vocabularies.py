"""Generate the TypeScript copy of the vocabularies the agent and the UI share.

A closed set of strings that crosses the language boundary (a task kind the
agent may delegate, a source kind a citation chip is drawn for, a shelf) has
its one source in Python: a ``Literal``, a registry's keys or an enum's values.
This script renders each to an ``as const``
tuple in ``apps/workspace/shared/vocabularies.generated.ts``, so the UI
imports the set instead of mirroring it, and a regex parity test has nothing
left to compare. One stage, unlike the cards and the wire: a tuple of strings
needs no JSON Schema in between.

Run with::

    uv run python scripts/generate_vocabularies.py

The ``vocabularies`` pre-commit hook runs it, and
``tests/test_vocabularies_generated.py`` fails a committed file that differs.
"""

import argparse
import json
from collections.abc import Sequence
from pathlib import Path
from typing import get_args

from agent.cards.workspace_cards import TaskKind
from agent.common.source_kinds import SOURCE_KINDS
from agent.common.source_kinds import Shelf

OUT_PATH = Path(__file__).resolve().parent.parent / "apps" / "workspace" / "shared" / "vocabularies.generated.ts"

#: Each exported tuple: its TypeScript name, its values in the source's order, and the line that says what it is.
VOCABULARIES: tuple[tuple[str, tuple[str, ...], str], ...] = (
    (
        "DELEGATABLE_TASK_KINDS",
        get_args(TaskKind),
        "The kinds a person may delegate: `TaskKind` in `packages/agent/src/agent/cards/workspace_cards.py`.",
    ),
    (
        "SOURCE_KINDS",
        tuple(SOURCE_KINDS),
        "The coarse source kinds: the keys of `SOURCE_KINDS` in `packages/agent/src/agent/common/source_kinds.py`.",
    ),
    (
        "SHELVES",
        tuple(shelf.value for shelf in Shelf),
        "The shelves a retrieved chunk can come from: `Shelf` in `packages/agent/src/agent/common/source_kinds.py`.",
    ),
)


def render() -> str:
    """The module's contents: deterministic, LF, in declaration order."""
    blocks = [
        "// AUTO-GENERATED from the Python sources named below — do not edit; "
        "run `uv run python scripts/generate_vocabularies.py`"
    ]
    for name, members, doc in VOCABULARIES:
        values = ", ".join(json.dumps(value) for value in members)
        blocks.append(f"/** {doc} */\nexport const {name} = [{values}] as const")
    return "\n\n".join(blocks) + "\n"


def main(argv: Sequence[str] | None = None) -> None:
    """Write the module. Takes no arguments; anything else is refused."""
    parser = argparse.ArgumentParser(
        description=f"Regenerate {OUT_PATH.relative_to(OUT_PATH.parents[4])} from the Python sources."
    )
    parser.parse_args(argv)
    OUT_PATH.write_text(render(), encoding="utf-8", newline="\n")
    print(f"Wrote the shared vocabularies to {OUT_PATH}")


if __name__ == "__main__":
    main()
