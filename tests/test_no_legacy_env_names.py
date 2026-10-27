"""No environment variable is read or set under its old ``AIQ_`` name (ADR-0145 row 10b).

Every variable took the house prefix ``GRID_``. For one release the image
entrypoint still adopts an old name an operator set by hand, and the Compose
files interpolate it; those, the rename table and the published release notes
are the only files that may spell one. Remove an entry here when its fallback
goes.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: The one-release fallback, its tests, the rename table and history.
ALLOWED = (
    "deploy/entrypoint.py",
    "tests/test_entrypoint_roles.py",
    "tests/test_no_legacy_env_names.py",
    "deploy/compose/docker-compose.yaml",
    "deploy/compose/docker-compose.coolify.yaml",
    "docs/deployment/environment-variables.md",
    "docs/adr/0145-the-repository-is-laid-out-by-job.md",
    "docs/adr/0079-background-work-runs-on-one-claim-substrate.md",
    "releasenotes/notes/",
)

OLD_NAME = re.compile(r"\bAIQ_")


def test_no_file_spells_an_old_environment_variable_name():
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    offenders = []
    for path in tracked:
        if path.startswith(ALLOWED) or not (ROOT / path).is_file():
            continue
        try:
            text = (ROOT / path).read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        offenders += [f"{path}:{n}" for n, line in enumerate(text.splitlines(), 1) if OLD_NAME.search(line)]

    assert not offenders, "Old AIQ_ names; use GRID_:\n" + "\n".join(offenders)
