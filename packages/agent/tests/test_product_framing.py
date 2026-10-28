"""What Piloti is, held where people and agents first read it.

Piloti is the workspace for architects; building law is one of its capabilities
(VISION.md). For a long time the README called it an "AI Compliance Assistant",
the deep-research prompts introduced the agent as "Grid OIB — an assistant for
... Austrian building regulations", and agents writing new docs and copy
repeated that frame because it was the first thing they read. The product owner
also forbade calling a file a plan (CONTEXT.md, "Fassung"): a name with an
index says a file has Fassungen, not that it is a drawing.

This is the ratchet for both, on the surfaces that shape everything else: the
first-impression docs and every agent prompt. The UI copy has its own
(frontends/ui/src/i18n/forbidden-file-words.spec.ts), and so does the public
site (apps/site/scripts/lint-claims.mjs).
"""

from __future__ import annotations

import re
import tomllib

import pytest
from agent_testing.product_framing import FILE_AS_PLAN
from agent_testing.product_framing import FIRST_IMPRESSION
from agent_testing.product_framing import OLD_FRAME
from agent_testing.product_framing import PROMPTS
from agent_testing.product_framing import ROOT


def _lines(relative: str) -> list[tuple[int, str]]:
    text = (ROOT / relative).read_text(encoding="utf-8")
    return list(enumerate(text.splitlines(), start=1))


@pytest.mark.parametrize("relative", FIRST_IMPRESSION + PROMPTS)
def test_no_surface_frames_piloti_as_a_compliance_question_answerer(relative: str) -> None:
    hits = [f"{relative}:{number}: {line.strip()}" for number, line in _lines(relative) if OLD_FRAME.search(line)]
    assert hits == [], "Piloti is the workspace for architects (VISION.md):\n" + "\n".join(hits)


@pytest.mark.parametrize("relative", PROMPTS)
def test_no_prompt_calls_a_file_a_plan(relative: str) -> None:
    hits = [f"{relative}:{number}: {line.strip()}" for number, line in _lines(relative) if FILE_AS_PLAN.search(line)]
    assert hits == [], "Never call a file a plan (CONTEXT.md, „Fassung“):\n" + "\n".join(hits)


@pytest.mark.parametrize("name", ["orchestrator.j2", "planner.j2", "researcher.j2", "writer.j2"])
def test_every_deep_research_prompt_introduces_the_agent_by_the_product_name(name: str) -> None:
    """The first line names the agent through ``{{ product_name }}`` (``common/brand.py``), never spelled."""
    first_line = (ROOT / "packages/agent/src/aiq_agent/agents/deep_researcher/prompts" / name).read_text(
        encoding="utf-8"
    )
    assert "{{ product_name }}" in first_line.splitlines()[0]


def test_pilotis_role_is_the_office_colleague_who_works_in_the_workspace_before_it_knows_the_law() -> None:
    """The chat prompt's role leads with the work (ADR-0123): the workspace and its proposals first, the law later."""
    static = (ROOT / "packages/agent/src/aiq_agent/agents/piloti/prompts/piloti_static.md").read_text(encoding="utf-8")
    role = static.split("<role>", 1)[1].split("</role>", 1)[0]
    assert "colleague in this planning office" in role
    assert role.index("workspace") < role.index("building law")
    assert "proposing" in role


def test_the_scan_sees_the_prompts() -> None:
    """A glob that silently matched nothing would pass every test above."""
    assert "packages/agent/src/aiq_agent/agents/piloti/prompts/piloti_static.md" in PROMPTS
    assert len(PROMPTS) >= 8


#: The same rule in English, for what an agent reads: a file is "the same plan",
#: "an older plan". A research plan or a floor plan stays allowed; what is caught
#: is a determiner that points at one file as a plan.
FILE_AS_PLAN_EN = re.compile(
    r"\b(?:same|this|that|each|every|which|older|newer|other|another|its|their|whose)\s+plans?\b", re.IGNORECASE
)


def _tool_descriptions() -> list[tuple[str, int, str]]:
    """Every string a tool or its arguments is described with: ``*DESCRIPTION*`` constants and ``description=``."""
    import ast

    found: list[tuple[str, int, str]] = []
    for path in sorted((ROOT / "packages" / "agent" / "src" / "aiq_agent").rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            values: list[ast.AST] = []
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and "DESCRIPTION" in target.id for target in node.targets
            ):
                values.append(node.value)
            if isinstance(node, ast.keyword) and node.arg == "description":
                values.append(node.value)
            for value in values:
                for sub in ast.walk(value):
                    if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                        found.append((path.relative_to(ROOT).as_posix(), sub.lineno, sub.value))
    return found


def test_no_tool_description_calls_a_file_a_plan() -> None:
    """A tool's DESCRIPTION is a prompt the model reads with every call (ADR-0144 shipped "the same plan")."""
    hits = [
        f"{relative}:{line}: {text.strip()[:160]}"
        for relative, line, text in _tool_descriptions()
        if FILE_AS_PLAN.search(text) or FILE_AS_PLAN_EN.search(text)
    ]
    assert hits == [], "Never call a file a plan (CONTEXT.md, „Fassung“), in a tool description either:\n" + "\n".join(
        hits
    )


def test_the_description_scan_sees_the_tools() -> None:
    """A walk that silently found nothing would pass the test above."""
    files = {relative for relative, _, _ in _tool_descriptions()}
    assert "packages/agent/src/aiq_agent/tools/viewer/register.py" in files
    assert "packages/agent/src/aiq_agent/tools/canvas/register.py" in files
    assert FILE_AS_PLAN_EN.search("the older Fassung of the same plan")
    assert not FILE_AS_PLAN_EN.search("reads the plan and research notes")


#: Every distribution this repository builds. Its description is what `pip show`,
#: the lockfile and a newcomer's first `cat pyproject.toml` read.
PACKAGE_GLOBS = (
    "apps/*/pyproject.toml",
    "packages/*/pyproject.toml",
)
PYPROJECTS = sorted(path.relative_to(ROOT).as_posix() for pattern in PACKAGE_GLOBS for path in ROOT.glob(pattern))

#: The framework as the frame: "NAT-based …", "NeMo Agent Toolkit workflows".
FRAMEWORK_FRAME = re.compile(r"\bNAT\b|NeMo|Agent Toolkit", re.IGNORECASE)


@pytest.mark.parametrize("relative", PYPROJECTS)
def test_no_package_describes_itself_by_its_framework(relative: str) -> None:
    """A package says what it does for Piloti; the framework is an implementation detail (VISION.md)."""
    description = tomllib.loads((ROOT / relative).read_text(encoding="utf-8"))["project"]["description"]
    assert not FRAMEWORK_FRAME.search(description), f"{relative}: {description!r}"


def test_the_scan_sees_the_packages() -> None:
    assert {
        "packages/agent/pyproject.toml",
        "packages/knowledge-layer/pyproject.toml",
        "apps/backend/pyproject.toml",
    } <= set(PYPROJECTS)
