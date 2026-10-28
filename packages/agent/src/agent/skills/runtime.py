"""Per-run skills: one backend, Deep Agents' catalog, and what reached the model.

Skills run on Deep Agents' ``SkillsMiddleware`` in both agents (ADR-0135): the
Agent Skills spec's progressive disclosure, where the prompt carries one line
per skill (name, description, path) and the model reads the ``SKILL.md`` it
chooses with ``read_file``. What this module adds is what the middleware does
not know about:

- **Which skills, for whom.** A :class:`SkillRuntime` is built per run
  (ADR-0018) from the skills already resolved for this tenant and agent
  (``resolver.py``: the BFF payload, the ``grid-agents`` gate, curated offers
  only when taken up), laid out as sources on one :class:`~.backend.SkillsBackend`.
- **What reached the model.** ``activated`` lists the skills whose body the
  model read (the backend's ``read``) or was handed in full and then named in
  the envelope's ``skills_applied`` (:meth:`record_applied`). The "Skills used"
  disclosure reads it as *what shaped this answer*, so a skill that was only
  listed is never in it.
- **The pinned shortcut** (ADR-0063, ADR-0064). The turn-start decision may
  name the one skill a question is the subject of; :meth:`pin` puts its body
  in the turn's prompt so the model saves the read. Deep Agents' own
  ``pinned_skills`` does the same by appending a ``HumanMessage``, which
  Piloti cannot use: a ``HumanMessage`` is where Piloti's turn begins
  (``answer_pipeline.this_turn``). The body is rendered in the shape the
  middleware pins with, ``<skill name=… path=…>``.

A SKILL IS AN OFFER. Nothing here can require one: a pinned body is still read
past when the question is not its subject, and only the model's own account
(``skills_applied``) makes it activated. Standing instructions belong in prompt
text, never in a skill the model is told to open.

All scaffolding is English; the agent answers in the reader's language.
"""

from __future__ import annotations

import html
import logging
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from deepagents.backends import CompositeBackend
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents.middleware.types import ModelRequest

from .backend import OFFICE_SOURCE
from .backend import SKILLS_ROOT
from .backend import SkillsBackend
from .backend import skill_path
from .builtin import canonical_skill_name
from .models import Skill
from .models import preferred_cards
from .models import skill_hidden

logger = logging.getLogger(__name__)

#: The catalog both agents read, in place of Deep Agents' stock text (which
#: tells the model about "Deepagents" sources and helper scripts it has none
#: of). The three slots are the middleware's; it fills them.
SKILLS_PROMPT = (
    "## Skills\n"
    "Working methods you may follow, one line each. A skill is an offer: you decide whether the task is its subject.\n"
    "{skills_locations}{skills_load_warnings}\n\n"
    "{skills_list}\n\n"
    "To follow a skill, read its whole `SKILL.md` first with `read_file` at the path shown, passing `limit=1000`, "
    "then follow it. A skill that says to load another is asking you to read that one too."
)

_PINNED_HEADING = "### Given in full for this question"
_PINNED_DOCTRINE = (
    "This method is probably what the question is about, so it is here already: do not read it again. "
    "If your answer follows it, name it in the `skills_applied` field of your answer envelope; "
    "that is how the reader learns which method shaped the answer."
)
_CARDS_LINE = "Preferred cards: {types} — the author's preference, not a requirement."
_CARDS_HEADING = "## Preferred cards"
_CARDS_DOCTRINE = (
    "Where the content supports it, present the result as one of these cards: {types}. "
    "This is the skill author's preference, not a requirement — if none of them fits the "
    "result, pick the card that does or answer in prose. Never invent content just to fill "
    "one of these cards. Their exact shapes follow, so you can emit them without looking them up."
)


def skills_middleware(backend: Any, sources: Sequence[str]) -> SkillsMiddleware:
    """Deep Agents' ``SkillsMiddleware`` with the catalog text both agents share."""
    return SkillsMiddleware(backend=backend, sources=list(sources), system_prompt=SKILLS_PROMPT)


def source_path(source: str) -> str:
    """The path an agent lists a source under: ``/skills/<source>/``."""
    return f"{SKILLS_ROOT}{source}/"


def preferred_cards_block(skill: Skill) -> str | None:
    """The ``grid-cards`` block appended to a body when it is read, or None.

    The full card shapes ride along because the read is the moment we know which
    of the card types this turn could need, and it saves a ``describe_card``
    round. Still a preference: an author naming three cards must not be able to
    force a ``calculation`` onto an answer that has nothing to compute.
    """
    cards = preferred_cards(skill.metadata)
    if not cards:
        return None
    types = ", ".join(f"`{card}`" for card in cards)
    block = f"{_CARDS_HEADING}\n{_CARDS_DOCTRINE.format(types=types)}"
    from agent.cards.catalog import render_card_details

    details = render_card_details(cards)
    return f"{block}\n\n{details}" if details else block


class SkillRuntime:
    """One run's skills: the backend that serves them and what reached the model.

    ``sources`` maps a source directory to its skills, in the order the agent
    lists them; a later source wins a name clash, as in the middleware.
    """

    def __init__(self, sources: Mapping[str, Sequence[Skill]] | None = None) -> None:
        self._sources = {name: tuple(skills) for name, skills in (sources or {}).items() if skills}
        self._by_name: dict[str, Skill] = {}
        self._path: dict[str, str] = {}
        for source, skills in self._sources.items():
            for skill in skills:
                self._by_name[skill.name] = skill
                self._path[skill.name] = f"{SKILLS_ROOT.rstrip('/')}{skill_path(source, skill.name)}"
        self._activated: list[str] = []
        self._pinned: list[str] = []
        self.backend = SkillsBackend(self._sources, on_read=self._record_activation, read_suffix=preferred_cards_block)

    @classmethod
    def office(cls, skills: Sequence[Skill]) -> SkillRuntime:
        """A runtime whose skills all sit in the one office source, as Piloti's do."""
        return cls({OFFICE_SOURCE: skills})

    @property
    def skills(self) -> tuple[Skill, ...]:
        """Every skill this run offers, one per name."""
        return tuple(self._by_name.values())

    @property
    def sources(self) -> tuple[str, ...]:
        """The source names that hold at least one skill, in order."""
        return tuple(self._sources)

    def mounted(self) -> CompositeBackend:
        """The backend as an agent sees it, under :data:`SKILLS_ROOT`.

        The default route is the skills backend itself; callers deny every path
        outside ``/skills/`` by permission, so nothing reaches it that way.
        """
        return CompositeBackend(default=self.backend, routes={SKILLS_ROOT: self.backend})

    def catalog_block(self) -> str | None:
        """The catalog section, rendered by ``SkillsMiddleware`` itself; None without skills.

        For an agent that cannot host the middleware (Piloti's graph is its own,
        and its system prompt must stay byte-identical across turns): the
        middleware loads the catalog from the backend exactly as it does in
        ``before_agent``, and renders the section it would have appended to a
        system message. The text is the one deep research's agents read.
        """
        if not self._sources:
            return None
        middleware = skills_middleware(self.mounted(), [source_path(s) for s in self._sources])
        loaded = middleware.before_agent({}, None, None) or {}  # ty: ignore[invalid-argument-type]
        request = ModelRequest(model=None, messages=[], state=dict(loaded))  # ty: ignore[invalid-argument-type]
        message = middleware.modify_request(request).system_message
        return message.text if message is not None else None

    def pin(self, name: str) -> bool:
        """Give ``name``'s body in full in this run's prompt; False when it is no skill here."""
        skill = self._by_name.get(canonical_skill_name(name))
        if skill is None or skill.name in self._pinned:
            return False
        self._pinned.append(skill.name)
        return True

    @property
    def pinned(self) -> tuple[str, ...]:
        return tuple(self._pinned)

    def pinned_block(self) -> str | None:
        """The pinned bodies under one heading, each in the middleware's ``<skill>`` shape."""
        if not self._pinned:
            return None
        parts = [f"{_PINNED_HEADING}\n{_PINNED_DOCTRINE}"]
        for name in self._pinned:
            skill = self._by_name[name]
            body = skill.body.strip()
            cards = preferred_cards(skill.metadata)
            if cards:
                body = f"{body}\n\n{_CARDS_LINE.format(types=', '.join(f'`{c}`' for c in cards))}"
            attrs = f'name="{html.escape(name, quote=True)}" path="{html.escape(self._path[name], quote=True)}"'
            parts.append(f"<skill {attrs}>\n{body}\n</skill>")
        return "\n\n".join(parts)

    def prompt_block(self) -> str | None:
        """The catalog, then the pinned bodies; None when the run has no skills."""
        blocks = [block for block in (self.catalog_block(), self.pinned_block()) if block]
        return "\n\n".join(blocks) or None

    @property
    def activated(self) -> tuple[str, ...]:
        """Skills whose body reached the model and shaped the answer, in order."""
        return tuple(self._activated)

    @property
    def hidden_activated(self) -> tuple[str, ...]:
        """Activated skills marked ``grid-hidden``: named in the disclosure, kept off the live line."""
        return tuple(name for name in self._activated if skill_hidden(self._by_name[name].metadata))

    def _record_activation(self, skill: Skill) -> None:
        """Record ONE activation, first wins, and announce it."""
        if skill.name in self._activated:
            return
        self._activated.append(skill.name)
        from .events import emit_skill_activated

        emit_skill_activated(skill)

    def record_applied(self, names: Sequence[str]) -> tuple[str, ...]:
        """Activate the PINNED skills the model says it followed; return what newly activated.

        Only a pinned body can be accepted this way: a read one is already
        active, and a name that matches nothing had no body reach the model.
        """
        accepted: list[str] = []
        for raw in names:
            name = canonical_skill_name(str(raw).strip().strip("`"))
            if name not in self._pinned:
                logger.debug("skills_applied names %r, which was not pinned this run; ignored", name)
                continue
            if name in self._activated:
                continue
            self._record_activation(self._by_name[name])
            accepted.append(name)
        return tuple(accepted)
