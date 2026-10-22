"""Every description the model reads from a bound tool is English (AGENTS.md, "Industry standard first").

Tool names, descriptions and parameter descriptions are read by the model on
every call, and by outside agents over MCP. German is for people (i18n) and for
domain data, so German appears here only inside a quoted span (a user phrasing
given as an example, a citation, a card label) or as a glossary word.

The tools are built from the shipped config exactly as the workflow builds them,
in a clean interpreter (NAT's registry is process-global; see
``test_backend_tools_schema``). A tool that fails to build is a failure here, so
a new tool cannot slip past the scan by being unbuildable.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

#: Function words that are German and not English. Two distinct ones outside a
#: quoted span make a sentence German; domain nouns (Fassung, Büroablage) are
#: not function words and need no entry.
GERMAN_FUNCTION_WORDS = frozenset(
    "der die das und oder nicht ist sind wird werden ein eine einen einem einer kein keine für mit von zum zur dem "
    "den des wenn wurde kann nur bitte nach bei aus über noch auch dieser diese dieses konnte ohne sich als im wie "
    "hat haben dass aber alle welche".split()
)

#: Glossary phrases that contain a function word and are domain data.
ALLOWED_PHRASES = ("Antrag auf",)

_QUOTED = re.compile(r"„[^“]*“|“[^”]*”|\"[^\"]*\"|`[^`]*`|(?<!\w)'[^']*'(?!\w)")

_BUILD_ALL = r"""
import asyncio, json, os
from pathlib import Path
os.environ.setdefault("OPENROUTER_API_KEY", "schema-generation-only")
from nat.builder.workflow_builder import WorkflowBuilder
from nat.data_models.config import Config
from nat.runtime.loader import PluginTypes, discover_and_register_plugins
from nat.utils.io.yaml_tools import yaml_load

discover_and_register_plugins(PluginTypes.ALL)
raw = yaml_load(Path("configs/config_oib_openrouter.yml"))


async def main():
    out = {}
    cfg = Config(
        llms=raw.get("llms", {}),
        embedders=raw.get("embedders", {}),
        functions=raw["functions"],
        function_groups=raw.get("function_groups", {}),
    )
    async with WorkflowBuilder() as builder:
        for name, c in cfg.llms.items():
            await builder.add_llm(name, c)
        for name, c in cfg.embedders.items():
            await builder.add_embedder(name, c)
        for name, c in cfg.function_groups.items():
            group = await builder.add_function_group(name, c)
            for key, fn in (await group.get_all_functions()).items():
                out[key] = [fn.description, fn.input_schema.model_json_schema()]
        for name, c in cfg.functions.items():
            fn = await builder.add_function(name, c)
            out[name] = [fn.description, fn.input_schema.model_json_schema()]
    print("@@" + json.dumps(out))


asyncio.run(main())
"""


def german_words(text: str) -> set[str]:
    """The German function words in ``text`` outside quoted spans and allowed phrases."""
    for phrase in ALLOWED_PHRASES:
        text = text.replace(phrase, "")
    bare = _QUOTED.sub(" ", text)
    return {m.group(0).lower() for m in re.finditer(r"\w+", bare) if m.group(0).lower() in GERMAN_FUNCTION_WORDS}


def is_german(text: str) -> bool:
    return len(german_words(text)) >= 2


def _described(schema: object, path: str):
    if isinstance(schema, dict):
        if isinstance(schema.get("description"), str):
            yield path, schema["description"]
        for key, value in schema.items():
            yield from _described(value, f"{path}.{key}")
    elif isinstance(schema, list):
        for value in schema:
            yield from _described(value, path)


def _all_model_facing_texts(src: Path = ROOT / "src") -> list[tuple[str, str]]:
    env = {**os.environ, "PYTHONPATH": f"{src}{os.pathsep}{ROOT}"}
    done = subprocess.run(
        [sys.executable, "-c", _BUILD_ALL], cwd=ROOT, env=env, capture_output=True, text=True, check=False
    )
    assert done.returncode == 0, done.stderr[-3000:]
    line = next(row for row in done.stdout.splitlines() if row.startswith("@@"))
    tools = json.loads(line[2:])
    texts: list[tuple[str, str]] = []
    for name, (description, schema) in tools.items():
        texts.append((name, description or ""))
        texts.extend(_described(schema, name))
    return texts


@pytest.fixture(scope="module")
def texts() -> list[tuple[str, str]]:
    return _all_model_facing_texts()


def test_the_detector_tells_german_from_english() -> None:
    assert is_german("Die Datei wurde nicht gefunden und der Fehler ist offen.")
    assert not is_german("Moves a file. Example: „wo ist der Plan“ or 'was ist in der Büroablage' (Fassung).")
    assert not is_german("The Dokumentart is set by a person; Bescheid, Plankopf and Einreichung stay German.")


def test_every_bound_tool_is_scanned(texts: list[tuple[str, str]]) -> None:
    names = {path.split(".")[0] for path, _ in texts}
    assert {"knowledge_search", "propose_file_change", "canvas__mark", "workspace__call", "ifc_measure"} <= names


def test_tool_and_parameter_descriptions_are_english(texts: list[tuple[str, str]]) -> None:
    german = [(path, sorted(german_words(text))) for path, text in texts if is_german(text)]
    assert german == [], f"German in what the model reads (translate it; quoted examples may stay): {german}"
