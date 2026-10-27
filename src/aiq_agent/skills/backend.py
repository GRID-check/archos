"""One run's resolved skills, served read-only as ``SKILL.md`` files (ADR-0135).

Deep Agents' ``SkillsMiddleware`` reads skills through a backend: it lists the
directories of each source, downloads every ``SKILL.md`` to build the catalog
(name, description, path), and the model then opens the one it chooses with
``read_file``. This backend is that filesystem for the skills a run resolved —
platform files, the offers the office took up, and the office's own rows —
none of which needs to exist on disk.

Paths are relative to where the backend is mounted, which is always
:data:`SKILLS_ROOT` behind a ``CompositeBackend`` (it strips the prefix):
``/<source>/<name>/SKILL.md``. A source is a directory the middleware is told to
read, so it is also the gate on who sees what: deep research mounts the
``synthesis`` collection for its writer and ``oib``/``bim`` for its researchers,
and the office's skills under :data:`OFFICE_SOURCE`.

Two reads, two meanings. ``download_files`` is the middleware loading the
catalog, and records nothing. ``read`` is the ``read_file`` tool handing a body
to the model, and is the one place a skill becomes ACTIVATED (``on_read``): the
"Skills used" disclosure reports what reached the model, not what was listed.
The ``grid-cards`` preference rides only on that read, because a card shape is
worth nothing until the skill is in play.

Read-only by construction: every write verb refuses. There is nothing on disk
behind it to change, but a refusal here means a write that reached this backend
by a route nobody planned for still changes nothing.
"""

from __future__ import annotations

from collections.abc import Callable
from collections.abc import Mapping
from collections.abc import Sequence
from difflib import get_close_matches
from typing import Any

import yaml
from deepagents.backends import StateBackend
from deepagents.backends.protocol import DeleteResult
from deepagents.backends.protocol import EditResult
from deepagents.backends.protocol import FileUploadResponse
from deepagents.backends.protocol import ReadResult
from deepagents.backends.protocol import WriteResult
from deepagents.backends.utils import create_file_data
from deepagents.backends.utils import slice_read_response

from .models import Skill

#: Where every agent sees the skills: the ``CompositeBackend`` route.
SKILLS_ROOT = "/skills/"

#: The source of the skills the BFF serves for an organization.
OFFICE_SOURCE = "office"

_READ_ONLY = "the skills mount is read-only"

#: A miss lists every skill when the run offers at most this many, else the closest few.
_LIST_ALL_UNDER = 12
_CLOSEST = 3


def skill_document(skill: Skill) -> str:
    """The ``SKILL.md`` for ``skill``: YAML frontmatter, then the body.

    Rendered from the validated model rather than copied from a file, because
    most skills have no file: an office row is a database row. The frontmatter
    is the Agent Skills spec's, ``allowed-tools`` spelled as the spec spells it.
    """
    front: dict[str, Any] = {"name": skill.name, "description": skill.description}
    if skill.license:
        front["license"] = skill.license
    if skill.compatibility:
        front["compatibility"] = skill.compatibility
    if skill.allowed_tools:
        front["allowed-tools"] = skill.allowed_tools
    if skill.metadata:
        front["metadata"] = dict(skill.metadata)
    head = yaml.safe_dump(front, allow_unicode=True, sort_keys=False, width=10_000)
    return f"---\n{head}---\n\n{skill.body.strip()}\n"


def skill_path(source: str, name: str) -> str:
    """The mount-relative path of a skill's ``SKILL.md``."""
    return f"/{source}/{name}/SKILL.md"


class SkillsBackend(StateBackend):
    """A read-only, in-memory filesystem of skills, one directory per source.

    ``StateBackend`` supplies ``ls``, ``read``, ``grep``, ``glob`` and
    ``download_files`` over a dict of files; this class hands it the dict
    instead of a graph's ``files`` channel, so it needs no graph to run in.
    """

    def __init__(
        self,
        sources: Mapping[str, Sequence[Skill]],
        *,
        on_read: Callable[[Skill], None] | None = None,
        read_suffix: Callable[[Skill], str | None] | None = None,
    ) -> None:
        super().__init__()
        self._skills = {skill_path(source, s.name): s for source, skills in sources.items() for s in skills}
        self._files = {path: create_file_data(skill_document(s)) for path, s in self._skills.items()}
        self._on_read = on_read
        self._read_suffix = read_suffix

    def _read_files(self) -> dict[str, Any]:
        return self._files

    def _miss(self, file_path: str) -> str:
        """A prescriptive error for a path that is no skill: what exists, and what to call.

        ``use_skill`` answered an unknown name with the names offered; a bare
        "not found" would cost the model a round to rediscover them. With few
        skills every path is listed, otherwise the closest by skill name.
        """
        shown = f"{SKILLS_ROOT.rstrip('/')}{file_path}"
        paths = sorted(self._skills)
        if not paths:
            return f"{shown} does not exist: no skills are offered this turn. Continue without one."
        if len(paths) > _LIST_ALL_UNDER:
            asked = file_path.rstrip("/").removesuffix("/SKILL.md").rsplit("/", 1)[-1]
            names = get_close_matches(asked, [self._skills[p].name for p in paths], n=_CLOSEST, cutoff=0.4)
            close = [p for p in paths if self._skills[p].name in names]
            if close:
                paths, intro = close, "The closest skills"
            else:
                return (
                    f"{shown} does not exist, and no skill is named like it. Read a path exactly as the "
                    "Skills section lists it, or continue without a skill."
                )
        else:
            intro = "The skills offered this turn"
        listed = ", ".join(f"{SKILLS_ROOT.rstrip('/')}{p}" for p in paths)
        return (
            f"{shown} does not exist. {intro}: {listed}. "
            "Call read_file with one of these paths, or continue without one."
        )

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        skill = self._skills.get(file_path)
        if skill is None:
            result = super().read(file_path, offset=offset, limit=limit)
            return ReadResult(error=self._miss(file_path)) if result.error else result
        file_data = self._files[file_path]
        suffix = self._read_suffix(skill) if self._read_suffix else None
        if suffix:
            file_data = create_file_data(f"{file_data['content']}\n{suffix}\n")
        result = slice_read_response(file_data, offset, limit)
        if result.error is None and self._on_read is not None:
            self._on_read(skill)
        return result

    def write(self, file_path: str, content: str) -> WriteResult:  # noqa: ARG002 - the protocol's shape
        return WriteResult(error=f"Cannot write to {file_path}: {_READ_ONLY}.")

    def edit(
        self,
        file_path: str,
        old_string: str,  # noqa: ARG002 - the protocol's shape
        new_string: str,  # noqa: ARG002
        replace_all: bool = False,  # noqa: ARG002, FBT001, FBT002
    ) -> EditResult:
        return EditResult(error=f"Cannot edit {file_path}: {_READ_ONLY}.")

    def delete(self, file_path: str) -> DeleteResult:
        return DeleteResult(error=f"Cannot delete {file_path}: {_READ_ONLY}.")

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [FileUploadResponse(path=path, error="permission_denied") for path, _ in files]
