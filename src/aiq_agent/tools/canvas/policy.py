"""What the canvas may show to everyone: nothing from a restricted folder.

A reply in a thread, a proposed mark and a labelled highlight or pointer are
read by EVERYONE who can open the document, not by the conversation's readers.
The asker's conversation, though, may have drawn on a folder not every project
member may read (ADR-0087, ADR-0088), on another project (ADR-0094), or on
restricted memory; the model writes such a post from everything in its
context, and nothing downstream can tell which sentence came from where. So
the rule is about the CONVERSATION, not the sentence, and it is the strictest
one the agent can check without asking anybody:

**A shared write is refused when the conversation is confined.** That is: the
BFF recorded a restricted folder on it (in this turn or an earlier one, its
subject included, or the check could not be made: ``RestrictedUse.confined``
fails closed), this turn admitted restricted content (``admitted``), or it drew
on another project in a way that narrows its readers
(:func:`~aiq_agent.knowledge.restricted_use.drew_on_other_projects`).

Two consequences, both deliberate:

- A document that itself sits in a restricted folder gets no posts from Piloti
  through a confined conversation, although everyone who reads it may read the
  folder. The agent cannot tell that recorded folder from another one, and
  „probably the same folder" is not a rule.
- A turn asked in a thread (``reply_in_thread``) is answered WITHOUT restricted
  collections in scope (``conversation_register``), so its own research cannot
  be what shuts the door it was asked to answer through.

The refusal is a sentence for the model, and the tool records it on its trace
step as ``{"refused": "restricted"}``.
"""

from __future__ import annotations

from aiq_agent.knowledge.restricted_use import current_restricted_use
from aiq_agent.knowledge.restricted_use import drew_on_other_projects

RESTRICTED_REFUSAL = (
    "Nicht möglich: Diese Unterhaltung hat Inhalte aus einem Ordner mit eingeschränktem Zugriff oder aus "
    "einem anderen Projekt verwendet. Was du im Dokument zeigst oder schreibst, sehen alle, die es öffnen, "
    "deshalb bleibt es hier im Chat. Sag der Person, dass du es nur hier beantworten kannst; nicht erneut "
    "versuchen."
)


def shared_write_refusal() -> str | None:
    """The refusal for a write everyone who opens the document would see, or None when it may go out."""
    use = current_restricted_use()
    if use is not None and (use.confined or use.admitted):
        return RESTRICTED_REFUSAL
    if drew_on_other_projects():
        return RESTRICTED_REFUSAL
    return None


def withhold_restricted_for_thread() -> None:
    """Take every restricted collection out of this turn's scope: it answers into a thread everyone reads.

    Called at turn start, before anything reads the scope, for a question asked
    in an Anmerkung's thread. The bound use only ever narrows, so this is the
    same move as a refused admission, made in advance.
    """
    use = current_restricted_use()
    if use is not None:
        use.drop(set(use.drawable))
