"""The UI's copy of each shared vocabulary is what the generator writes.

``apps/workspace/shared/vocabularies.generated.ts`` is rendered from the
Python source each tuple names (``scripts/generate_vocabularies.py``). A
change to a source without regenerating, or a hand edit of the module,
fails here, so the two languages cannot hold different sets.
"""

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_generator():
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    spec = importlib.util.spec_from_file_location(
        "scripts.generate_vocabularies", REPO_ROOT / "scripts" / "generate_vocabularies.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_committed_module_is_what_the_generator_writes() -> None:
    generator = _load_generator()
    assert generator.OUT_PATH.read_text(encoding="utf-8") == generator.render(), (
        f"{generator.OUT_PATH.relative_to(REPO_ROOT)} is out of sync with its Python sources. "
        "Run `uv run python scripts/generate_vocabularies.py` and commit the result."
    )


def test_every_vocabulary_is_exported() -> None:
    generator = _load_generator()
    module = generator.render()
    for name, members, _ in generator.VOCABULARIES:
        assert f"export const {name} = [" in module
        assert members, f"{name} is read from an empty source"
