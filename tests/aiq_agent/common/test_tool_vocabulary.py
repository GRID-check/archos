"""A shared hint names the tool the caller has (ADR-0133 slice 6).

The knowledge layer's results are read by Piloti's chat (``read_file``, ``ls``, ``grep``) and by
deep research and intake (``read_passage``, ``list_files``, ``knowledge_search(match="exact")``).
Sending either to a tool it does not have costs a round and teaches nothing.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.tool_vocabulary import FILESYSTEM
from aiq_agent.common.tool_vocabulary import LEGACY
from aiq_agent.common.tool_vocabulary import current_vocabulary
from aiq_agent.common.tool_vocabulary import use_vocabulary
from aiq_agent.common.tool_vocabulary import vocabulary_for

PILOTI = ("knowledge_search", "list_files", "ls", "glob", "grep", "read_file", "look")
DEEP = ("knowledge_search", "read_passage", "list_files", "look")


def test_the_binding_decides_and_unset_is_legacy():
    assert vocabulary_for(PILOTI) is FILESYSTEM
    assert vocabulary_for(DEEP) is LEGACY
    assert vocabulary_for(("read_file", "ls")) is LEGACY  # the drafts' verbs alone read no estate
    assert current_vocabulary() is LEGACY
    with use_vocabulary(FILESYSTEM):
        assert current_vocabulary() is FILESYSTEM
    assert current_vocabulary() is LEGACY


def test_each_spelling_is_ticked_for_the_door():
    assert FILESYSTEM.read(clause="…") == "`read_file(file_path=…, clause=…)`"
    assert LEGACY.read(clause="…") == "`read_passage(document=…, clause=…)`"
    assert FILESYSTEM.literal_name == "`grep`" and LEGACY.literal_name == '`knowledge_search(match="exact")`'
    assert FILESYSTEM.list_folder(path='"/project/A/"', tree=True) == '`ls(path="/project/A/", depth=2)`'
    assert LEGACY.list_folder(folder='"A"', tree=True) == '`list_files(folder="A", view="tree")`'


@pytest.mark.parametrize(
    ("render", "piloti", "deep"),
    [
        ("outline", "`read_file(", "`read_passage("),
        ("groups", "`grep`", 'match="exact"'),
        ("noise", "`grep`", 'match="exact"'),
        ("family_failed", "`read_file`", "`read_passage`"),
        ("hidden_revisions", "`read_file`", "file_name="),
    ],
)
def test_the_shared_hints_follow_the_binding(render, piloti, deep):
    import importlib

    rp = importlib.import_module("sources.knowledge_layer.src.read_passage")
    from sources.knowledge_layer.src import register
    from sources.knowledge_layer.src.chunk_noise import noise_notice
    from sources.knowledge_layer.src.document_groups import DocumentGroup
    from sources.knowledge_layer.src.document_groups import render_document_groups

    def text() -> str:
        if render == "outline":
            return rp._outline_instruction()
        if render == "groups":
            best = type("Chunk", (), {"file_name": "a.pdf"})()
            return render_document_groups([DocumentGroup(best=best, passages=2, pages=(1,))], 5)
        if render == "noise":
            return noise_notice(2)
        if render == "family_failed":
            return register._family_overview_failed_notice("2")
        return register._hidden_revisions_notice({"c": {"alt.pdf": "neu.pdf"}})

    with use_vocabulary(FILESYSTEM):
        assert piloti in text()
        assert deep not in text()
    assert deep in text()
    assert piloti not in text()
