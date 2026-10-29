"""The brand-prose ratchet counts the retired names and a typed-out current name, and leaves history alone.

`scripts/check_brand_prose.py` is the copy half of ADR-0148: no retired product name
(Piloti, AI-Q, GRID) in what a person or an agent reads, and the current name only as
`{productName}`/`PRODUCT_NAME` outside the brand's own files and the public documents.
These run it on a scratch repository, so the real tree's baseline is not what they
depend on.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def checker():
    spec = importlib.util.spec_from_file_location("check_brand_prose", ROOT / "scripts" / "check_brand_prose.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def repo(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "ci").mkdir()
    monkeypatch.chdir(tmp_path)
    return tmp_path


def _add(repo: Path, path: str, text: str) -> None:
    (repo / path).parent.mkdir(parents=True, exist_ok=True)
    (repo / path).write_text(text, encoding="utf-8")
    subprocess.run(["git", "add", path], cwd=repo, check=True)


@pytest.mark.parametrize(
    ("text", "hits"),
    [
        ("Piloti reads your files.", 1),
        ("ask piloti, or PILOTI", 2),
        ("the piloti:// guide", 1),
        ("https://app.dev.piloti.at/api and Domain=dev.piloti.at, anna@piloti.test", 0),
        ("AI-Q blueprint and AIQ", 2),
        ("GRID operates the platform", 1),
        ("Grid platform and Grid agent", 2),
        ("image grid-oib-backend", 1),
        # CSS and the English word never count.
        ("display: grid; grid-template-columns: 1fr", 0),
        ("<div className='grid grid-cols-2'>", 0),
        ("a Grid of cards, the document grid", 0),
        # Identifiers are the brand-names check's business, not this one's.
        ("pilotiWakes piloti_wakes GRID_URL AIQ_API", 0),
        # A link to an ADR file keeps the filename it has.
        ("[ADR-0146](0146-piloti-draws-sketches-in-excalidraws-own-format.md)", 0),
    ],
)
def test_retired_names_are_words_not_css(checker, text: str, hits: int) -> None:
    assert checker.count_retired(text) == hits


def test_a_marked_line_may_quote_an_old_name_in_backticks(checker) -> None:
    assert checker.count_retired("`piloti://guide` became `workspace://guide` <!-- brand-history -->") == 0
    assert checker.count_retired("`piloti://guide` became `workspace://guide`") == 1
    # The marker covers backticks only: prose on the same line still counts.
    assert checker.count_retired("Piloti said `piloti` <!-- brand-history -->") == 1


@pytest.mark.parametrize(
    ("text", "hits"),
    [
        ("Welcome to ARCHOS", 1),
        ("Archos reads it", 1),
        ("bash archos/scripts/cloud-setup.sh, the `archos` clone", 0),
        ("mail kontakt@archos.tech or see https://archos.tech/blog", 0),
        ("app.archos.tech and ghcr.io/archos-at/archos", 0),
    ],
)
def test_the_current_name_counts_as_a_literal_not_as_a_host(checker, text: str, hits: int) -> None:
    assert checker.count_current(text) == hits


def test_the_current_name_is_allowed_only_where_copy_belongs(checker, repo: Path) -> None:
    _add(repo, "apps/workspace/i18n/dictionaries/en.ts", "export const en = { title: 'ARCHOS' }\n")
    _add(repo, "packages/brand/identity.json", '{"name": "ARCHOS"}\n')
    _add(repo, "apps/workspace/shared/brand/identity.json", '{"name": "ARCHOS"}\n')
    _add(repo, "VISION.md", "ARCHOS is the workspace for architects.\n")
    _add(repo, "docs/user-guides/start.md", "Open ARCHOS.\n")
    _add(repo, "apps/website/src/content/blog/de/post.md", "ARCHOS im Büro.\n")
    _add(repo, "docs/architecture/x.md", "ARCHOS calls the BFF.\n")
    measured = checker.measure(repo, checker.tracked_files(repo))
    assert measured == {"apps/workspace/i18n/dictionaries/en.ts": 1, "docs/architecture/x.md": 1}


def test_adrs_up_to_the_cutoff_are_history(checker, repo: Path) -> None:
    _add(repo, "docs/adr/0147-old.md", "Piloti decided.\n")
    _add(repo, "docs/adr/0148-new.md", "Piloti was renamed.\n`piloti` is the old token. <!-- brand-history -->\n")
    _add(repo, "docs/adr/README.md", "| 0146 | Piloti draws |\n")
    assert checker.measure(repo, checker.tracked_files(repo)) == {"docs/adr/0148-new.md": 1}


@pytest.mark.parametrize(
    ("marker", "counted"),
    [
        ("<!-- history: 2026-10-01 -->", False),
        (f"<!-- history: {__import__('datetime').date(2026, 10, 29).isoformat()} -->", False),
        ("<!-- history: 2026-11-30 -->", True),  # after the cutover: not history, whatever it says
        ("<!-- nothing -->", True),
    ],
)
def test_a_dated_history_marker_freezes_a_doc_written_before_the_cutover(checker, repo, marker, counted) -> None:
    _add(repo, "docs/roadmap/plan.md", f"{marker}\nPiloti will grow.\n")
    _add(repo, "apps/workspace/note.md", "<!-- history: 2026-10-01 -->\nPiloti\n")  # outside docs/: no effect
    measured = checker.measure(repo, checker.tracked_files(repo))
    assert ("docs/roadmap/plan.md" in measured) is counted
    assert measured["apps/workspace/note.md"] == 1


def test_a_legacy_module_that_says_when_it_goes_is_history(checker, repo: Path) -> None:
    _add(
        repo,
        "apps/workspace/bff/legacy-door-names.ts",
        "// Old MCP names. Drop after release 2026.11.\nconst OLD = 'piloti://guide'\n",
    )
    assert checker.measure(repo, checker.tracked_files(repo)) == {}


def test_manifest_notes_and_their_translations_and_past_summaries_are_history(checker, repo: Path) -> None:
    _add(repo, "releasenotes/notes/old-1.yaml", "---\nfeatures:\n  - >\n    Piloti now reads\n    plans.\n")
    _add(repo, "releasenotes/notes/new-2.yaml", "---\nfeatures:\n  - >\n    Piloti now writes.\n")
    _add(repo, "ci/brand_history_manifest.txt", "# frozen\nreleasenotes/notes/old-1.yaml\n")
    translations = [
        {"en": "Piloti now reads plans.", "de": "Piloti liest jetzt Pläne."},
        {"en": "Piloti now writes.", "de": "Piloti schreibt jetzt."},
        {"en": "In week 41 Piloti grew.", "de": "In Woche 41 wuchs Piloti."},
    ]
    _add(repo, "releasenotes/translations/de.json", json.dumps(translations, ensure_ascii=False))
    summaries = "2026-W45: >\n  Piloti later.\n\n2026-W41: >\n  In week 41 Piloti grew.\n"
    _add(repo, "releasenotes/summaries.yaml", summaries)
    measured = checker.measure(repo, checker.tracked_files(repo))
    assert measured == {
        "releasenotes/notes/new-2.yaml": 1,
        "releasenotes/translations/de.json": 2,  # the new note's English and German
        "releasenotes/summaries.yaml": 1,  # week 45 began after the cutover
    }


def test_a_listed_note_that_is_gone_fails(checker, repo: Path, capsys) -> None:
    _add(repo, "ci/brand_history_manifest.txt", "releasenotes/notes/missing.yaml\n")
    assert checker.main([]) == 1
    assert "missing.yaml is listed but does not exist" in capsys.readouterr().err


def test_the_ratchet_refuses_growth_and_follows_every_cleanup(checker, repo: Path) -> None:
    _add(repo, "apps/workspace/ui/a.tsx", "const t = 'Piloti'\n")
    assert checker.main(["--rebaseline"]) == 0
    assert json.loads((repo / "ci/brand_prose_baseline.json").read_text()) == {"apps/workspace/ui/a.tsx": 1}
    assert checker.main([]) == 0

    _add(repo, "apps/workspace/ui/a.tsx", "const t = 'Piloti or Piloti'\n")
    assert checker.main([]) == 1

    _add(repo, "apps/workspace/ui/a.tsx", "const t = PRODUCT_NAME\n")
    assert checker.main([]) == 1  # below the baseline until --update lowers it
    assert checker.main(["--update"]) == 0
    assert json.loads((repo / "ci/brand_prose_baseline.json").read_text()) == {}


def test_update_never_adds_a_new_file(checker, repo: Path) -> None:
    (repo / "ci/brand_prose_baseline.json").write_text("{}\n")
    _add(repo, "docs/architecture/new.md", "Piloti\n")
    assert checker.main(["--update"]) == 1
    assert json.loads((repo / "ci/brand_prose_baseline.json").read_text()) == {}


def test_the_real_tree_holds_its_baseline() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_brand_prose.py"], cwd=ROOT, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr


def test_rebaseline_re_keys_a_move_but_never_raises_the_total(checker, repo: Path) -> None:
    _add(repo, "docs/old.md", "Piloti\n")
    assert checker.main(["--rebaseline"]) == 0
    subprocess.run(["git", "mv", "docs/old.md", "docs/new.md"], cwd=repo, check=True)
    assert checker.main(["--rebaseline"]) == 0
    assert json.loads((repo / "ci/brand_prose_baseline.json").read_text()) == {"docs/new.md": 1}

    _add(repo, "docs/other.md", "Piloti\n")
    assert checker.main(["--rebaseline"]) == 1
    assert json.loads((repo / "ci/brand_prose_baseline.json").read_text()) == {"docs/new.md": 1}


def test_the_legal_notices_may_name_the_former_name_in_one_phrase_only(checker, repo: Path) -> None:
    _add(repo, "apps/workspace/bff/legal/content/de.ts", "const a = '{productName} (vormals Piloti) verarbeitet'\n")
    _add(repo, "apps/workspace/bff/legal/content/en.ts", "const a = '(formerly Piloti) and Piloti alone'\n")
    _add(repo, "apps/workspace/ui/footer.tsx", "const a = '(formerly Piloti)'\n")
    assert checker.measure(repo, checker.tracked_files(repo)) == {
        "apps/workspace/bff/legal/content/en.ts": 1,
        "apps/workspace/ui/footer.tsx": 1,
    }
