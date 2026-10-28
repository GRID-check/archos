"""Shared agent skills substrate (agentskills.io format).

Builtin (platform) skills ship as SKILL.md files under
``packages/agent/src/agent/skills/builtin`` and are validated STRICTLY at discovery;
org-authored skills are served by the BFF internal endpoint
(``/api/internal/skills/resolve``) and resolved fail-open per run. Both reach
the model through Deep Agents' ``SkillsMiddleware`` over :class:`SkillsBackend`
(ADR-0135).
"""

from .backend import OFFICE_SOURCE
from .backend import SKILLS_ROOT
from .backend import SkillsBackend
from .builtin import BUILTIN_SKILLS_DIR
from .builtin import discover_builtin_skills
from .models import GRID_CARDS_KEY
from .models import GRID_METADATA_KEYS
from .models import MAX_DESCRIPTION_CHARS
from .models import MAX_NAME_CHARS
from .models import Skill
from .models import SkillValidationError
from .models import parse_skill_md
from .models import preferred_cards
from .resolver import SkillResolver
from .resolver import resolve_served_skills
from .runtime import SKILLS_PROMPT
from .runtime import SkillRuntime
from .runtime import skills_middleware

__all__ = [
    "BUILTIN_SKILLS_DIR",
    "GRID_CARDS_KEY",
    "GRID_METADATA_KEYS",
    "MAX_DESCRIPTION_CHARS",
    "MAX_NAME_CHARS",
    "OFFICE_SOURCE",
    "SKILLS_PROMPT",
    "SKILLS_ROOT",
    "Skill",
    "SkillResolver",
    "SkillRuntime",
    "SkillValidationError",
    "SkillsBackend",
    "discover_builtin_skills",
    "parse_skill_md",
    "preferred_cards",
    "resolve_served_skills",
    "skills_middleware",
]
