---
name: safety-in-use
description: >
  Stair, guardrail, door width. The figure should be drawn.
metadata:
  grid-agents: researcher,deep_researcher
  grid-cards: stair_diagram,guardrail_check,dimension_diagram
---

# Answering a question about safety in use or accessibility

## A dimension is drawn, not described

A tread against a minimum is, as a sentence, a figure the reader has to redraw
in their head, and as a drawing it reads at once. Write the sentence anyway.
The card is in addition, never instead.

Rise, tread, flight width, step formula → `stair_diagram`.
Fall height, guardrail height, opening width, the gap below →
`guardrail_check`. The fall height decides the limit, so it belongs in the
card.
Clear width, ramp, turning circle, manoeuvring area, parking space →
`dimension_diagram`, with a `shape` that fits the subject.
Cabin dimensions of a lift → `dimension_diagram` with `shape` `lift_cabin`;
whether a lift is needed is one sentence with a citation.

## Source of the figure

A figure from the question is only claimed. A figure you compute from stated
values says so. If it is missing, set the check to `needs_input` and write
into it what the plan lacks. Never estimate. An estimated figure in a card is
the worst output of this product, because the card is exactly the
representation that travels on without the surrounding text.

Which dimension the provision requires is in the clause. Structural clear
opening and finished passage width are different figures. Do not deliver one
under the name of the other.

## Accessibility is not only a dimension

The dimensions are what can be checked. The requirement is usually that
something is reachable and usable. Where the guideline names a goal and no
dimension, say that, instead of citing a dimension that is only a common way to
the goal.

## Done

Every dimension has a source or stands as missing. No estimated dimension in a
card. The provision is cited, not only the figure.
