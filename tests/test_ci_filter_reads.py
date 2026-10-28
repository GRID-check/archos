"""Every file a test reads as source is in the CI filter of the tier that runs the test.

The check and its reasoning: scripts/check_ci_filter_reads.py. It runs in
`be:test:harness`, which CI's Repo checks job runs on every pull request, so a
pull request that only adds a read still meets it.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "check_ci_filter_reads", Path(__file__).resolve().parents[1] / "scripts" / "check_ci_filter_reads.py"
)
assert _SPEC and _SPEC.loader
reads = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(reads)


def test_every_file_a_test_reads_is_in_its_tiers_filter_and_no_more():
    absent, stale = reads.drift()
    listed = [f"{tier} lacks {path} (read by {test})" for tier, paths in absent.items() for path, test in paths.items()]
    listed += [f"{tier} still lists {path}" for tier, paths in stale.items() for path in paths]
    assert listed == [], "run `python scripts/check_ci_filter_reads.py --fix`"


def test_python_chains_skip_comments_and_docstrings():
    source = '''"""See frontends/ui/a.ts."""
UI = ROOT / "frontends" / "ui"  # not "x/y.ts"
path = UI / "src" / "b.ts"
'''
    assert reads.chains(reads.python_tokens(source)) == ["frontends/ui", "src/b.ts"]


def test_script_chains_take_either_quote_and_skip_comments():
    source = """// read('no/comment.ts')
/* `no/block.ts` */
const label = <p>don't</p>
read('apps', "backend", 'x.py')
join(repoRoot, "frontends/ui", 'y.js')
"""
    assert reads.chains(reads.script_tokens(source)) == ["apps/backend/x.py", "frontends/ui/y.js"]


def test_a_chain_resolves_under_a_directory_the_file_names():
    files = {"frontends/ui/src/lib/documents/search.ts", "README.md"}
    directories = {
        "frontends",
        "frontends/ui",
        "frontends/ui/src",
        "frontends/ui/src/lib",
        "frontends/ui/src/lib/documents",
    }
    source = (
        'LIB = ROOT / "frontends" / "ui" / "src" / "lib"\n'
        'cap = number(LIB / "documents" / "search.ts", "SEARCH_CAP")\n'
        'name = "README.md"\n'
    )
    assert reads.files_read("t.py", source, files, directories) == {"frontends/ui/src/lib/documents/search.ts"}


def test_the_harness_tests_are_exempt():
    assert "tests/test_ci_filter_coverage.py" in reads.harness_tests()
