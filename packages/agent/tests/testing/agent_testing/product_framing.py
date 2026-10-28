"""What the product-framing guard scans and what it refuses: the first-impression docs,
the agent prompts, the old frame and a file called a plan.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = next(path for path in Path(__file__).resolve().parents if (path / "Taskfile.yml").is_file())

#: Where a reader, human or agent, learns what the product is.
FIRST_IMPRESSION = [
    "README.md",
    "AGENTS.md",
    "CONTEXT.md",
    "docs/README.md",
    "docs/architecture/system-overview.md",
    "docs/architecture/overview.md",
    "frontends/ui/README.md",
]

PROMPTS = sorted(
    path.relative_to(ROOT).as_posix()
    for path in (ROOT / "packages" / "agent" / "src" / "aiq_agent").rglob("prompts/*")
    if path.suffix in {".j2", ".md"}
)

#: The old frame. VISION.md names these on purpose (as what Piloti is not), and
#: docs/product/vision.md quotes the frame it replaced, so neither is scanned.
OLD_FRAME = re.compile(
    r"compliance assistant|grid oib|answers oib questions|research assistant for austrian building|oib chatbot",
    re.IGNORECASE,
)

#: A file called a plan. Compounds (Lageplan, Bebauungsplan, Bestandspläne) do not
#: match; a research plan is not a file and is written in the singular here.
FILE_AS_PLAN = re.compile(r"(?<![\w-])(Pläne|Plänen|Planstand|Planstände|Planständen)(?![\w-])")
