"""Every surface names the product with the one string in ``packages/brand/identity.json``.

The name is copy, and it has changed four times (ADR-0148). The UI's copy reads
``PRODUCT_NAME`` from ``apps/workspace/bff/brand.ts`` (through ``{productName}`` in
the dictionaries); the agent's prompts read it from ``agent.common.brand`` (through
``{{ product_name }}``); both read ``identity.json``, which ``node packages/brand/sync.mjs``
copies beside each of them. A few files must spell the name as a literal because nothing
can import there (the service worker, the icons' SVG ``<title>``), and ``sync.mjs`` writes
those too (``packages/brand/name-copies.mjs``).

The rename drill at the bottom is the owner's acceptance test for "the next rename is
one edit": it changes the name in a scratch copy of the brand package, runs ``sync.mjs``
once, and expects every derived surface to carry the new name with no other edit.
"""

from __future__ import annotations

import importlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from agent.common import render_prompt_template
from agent.common.brand import PRODUCT_NAME

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "packages" / "brand" / "identity.json"
UI_BRAND = Path("apps/workspace/bff/brand.ts")
MCP_SERVER = Path("apps/workspace/bff/agent-api/mcp-server.ts")
MCP_CONFIG = Path("apps/workspace/bff/agent-api/mcp-config.ts")
AGENT_BRAND = Path("packages/agent/src/agent/common/brand.py")
IDENTITY_COPIES = (
    Path("packages/agent/src/agent/common/identity.json"),
    Path("apps/workspace/shared/brand/identity.json"),
    Path("apps/website/src/styles/brand/identity.json"),
)
SERVICE_WORKER = Path("apps/workspace/public/sw.js")
ICONS = (Path("apps/workspace/app/icon.svg"), Path("apps/website/public/favicon.svg"))
DRILL_NAME = "Drillname Nova"


def _name(identity: Path) -> str:
    return json.loads(identity.read_text(encoding="utf-8"))["name"]


def _sw_title(root: Path) -> str:
    match = re.search(r"\nvar GENERIC_TITLE = '([^']*)'", (root / SERVICE_WORKER).read_text(encoding="utf-8"))
    assert match, f"GENERIC_TITLE not found in {SERVICE_WORKER}"
    return match.group(1)


def _svg_title(path: Path) -> str:
    match = re.search(r"<title>([^<]*)</title>", path.read_text(encoding="utf-8"))
    assert match, f"no <title> in {path}"
    return match.group(1)


def _ui_product_name(workspace: Path) -> str:
    """``PRODUCT_NAME`` as the UI's module evaluates it, through its own path aliases."""
    script = "import { PRODUCT_NAME } from './bff/brand.ts'; console.log(PRODUCT_NAME)"
    out = subprocess.run(["bun", "-e", script], cwd=workspace, capture_output=True, text=True, check=True)
    return out.stdout.strip()


def test_every_identity_copy_is_the_source() -> None:
    source = SOURCE.read_bytes()
    for copy in IDENTITY_COPIES:
        assert (ROOT / copy).read_bytes() == source, f"{copy} is stale: run node packages/brand/sync.mjs"


def test_the_agent_reads_the_name_from_identity_json() -> None:
    assert PRODUCT_NAME == _name(SOURCE)


def test_the_ui_reads_the_name_from_identity_json() -> None:
    text = (ROOT / UI_BRAND).read_text(encoding="utf-8")
    assert "import identity from '@/shared/brand/identity.json'" in text
    assert re.search(r"export const PRODUCT_NAME(: string)? = identity\.name\n", text), (
        "PRODUCT_NAME in apps/workspace/bff/brand.ts must be identity.name, never a literal"
    )


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun evaluates the UI module")
def test_the_ui_and_the_agent_carry_the_same_product_name() -> None:
    assert _ui_product_name(ROOT / "apps" / "workspace") == PRODUCT_NAME


def test_the_literal_copies_carry_the_name() -> None:
    assert _sw_title(ROOT) == PRODUCT_NAME
    for icon in ICONS:
        assert _svg_title(ROOT / icon) == PRODUCT_NAME, f"{icon}: run node packages/brand/sync.mjs"


def test_the_mcp_server_titles_come_from_product_name() -> None:
    text = (ROOT / MCP_SERVER).read_text(encoding="utf-8")
    block = text.split("const SERVER_IDENTITY", 1)[1].split("> = {\n", 1)[1].split("\n}\n", 1)[0]
    titles = re.findall(r"title: ([^,]+),", block)
    assert titles, "SERVER_IDENTITY has no titles"
    for title in titles:
        assert "PRODUCT_NAME" in title and PRODUCT_NAME not in title, f"MCP server title {title} spells the name"


def test_what_an_outside_agent_reads_at_connect_time_spells_no_name() -> None:
    """The MCP instructions and the OAuth resource names a client shows come from ``PRODUCT_NAME``."""
    names = "|".join(re.escape(name) for name in (PRODUCT_NAME, "Piloti", "AI-Q"))
    spelled = re.compile(rf"""['"`][^'"`\n]*\b(?:{names})\b""")
    for module in (MCP_SERVER, MCP_CONFIG):
        text = (ROOT / module).read_text(encoding="utf-8")
        assert "PRODUCT_NAME" in text, module
        assert not spelled.search(text), f"{module} spells a product name: {spelled.search(text).group(0)}"


def test_a_prompt_names_the_agent_with_the_product_name() -> None:
    rendered = render_prompt_template("You are {{ product_name }}.", document_inventory="", answer_envelope_schema="")
    assert rendered == f"You are {PRODUCT_NAME}."


# ── The rename drill ────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def drill(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A scratch tree holding the brand package and every derived surface, renamed by one edit and one sync."""
    if shutil.which("node") is None:
        pytest.skip("node runs packages/brand/sync.mjs")
    scratch = tmp_path_factory.mktemp("rename-drill")
    brand = scratch / "packages" / "brand"
    shutil.copytree(ROOT / "packages" / "brand", brand, ignore=shutil.ignore_patterns("node_modules"))
    for path in (UI_BRAND, SERVICE_WORKER, *ICONS, Path("apps/workspace/tsconfig.json"), AGENT_BRAND):
        (scratch / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / path, scratch / path)
    (scratch / AGENT_BRAND).with_name("__init__.py").write_text("", encoding="utf-8")

    identity = brand / "identity.json"
    data = json.loads(identity.read_text(encoding="utf-8"))
    assert data["name"] != DRILL_NAME
    data["name"] = DRILL_NAME
    identity.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")  # the one edit

    subprocess.run(["node", "packages/brand/sync.mjs"], cwd=scratch, check=True, capture_output=True)
    return scratch


def test_rename_drill_reaches_every_identity_copy(drill: Path) -> None:
    for copy in IDENTITY_COPIES:
        assert _name(drill / copy) == DRILL_NAME, copy


def test_rename_drill_reaches_the_agent(drill: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    package = drill / AGENT_BRAND.parent
    monkeypatch.syspath_prepend(str(package.parent))
    module = importlib.import_module(f"{package.name}.brand")
    try:
        assert module.PRODUCT_NAME == DRILL_NAME
    finally:
        sys.modules.pop(f"{package.name}.brand", None)
        sys.modules.pop(package.name, None)


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun evaluates the UI module")
def test_rename_drill_reaches_the_ui(drill: Path) -> None:
    assert _ui_product_name(drill / "apps" / "workspace") == DRILL_NAME


def test_rename_drill_reaches_the_literal_copies(drill: Path) -> None:
    assert _sw_title(drill) == DRILL_NAME
    for icon in ICONS:
        assert _svg_title(drill / icon) == DRILL_NAME, icon
    check = subprocess.run(
        ["node", "packages/brand/sync.mjs", "--check"], cwd=drill, capture_output=True, text=True, check=False
    )
    assert check.returncode == 0, check.stderr


WEBSITE_DEPS = ROOT / "apps" / "website" / "node_modules"


def test_rename_drill_redraws_the_icon(drill: Path) -> None:
    """The icon is the name's initial: one run of ``build-brand-assets.mjs`` after the sync redraws it."""
    if not all((WEBSITE_DEPS / dep).is_dir() for dep in ("fontkit", "sharp")):
        pytest.skip("build-brand-assets.mjs borrows fontkit and sharp from apps/website (bun install there)")
    site = drill / "apps" / "website"
    site.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "apps" / "website" / "package.json", site / "package.json")
    if not (site / "node_modules").exists():
        (site / "node_modules").symlink_to(WEBSITE_DEPS, target_is_directory=True)
    script = "packages/brand/build-brand-assets.mjs"
    subprocess.run(["node", script], cwd=drill, check=True, capture_output=True)
    initial = f'data-initial="{DRILL_NAME[0].upper()}"'
    for icon in (Path("packages/brand/mark.svg"), *ICONS):
        assert initial in (drill / icon).read_text(encoding="utf-8"), icon
    for icon in ICONS:
        assert _svg_title(drill / icon) == DRILL_NAME, icon
    assert (site / "public" / "media" / "share-card.png").is_file()
    check = subprocess.run(["node", script, "--check"], cwd=drill, capture_output=True, text=True, check=False)
    assert check.returncode == 0, check.stderr
