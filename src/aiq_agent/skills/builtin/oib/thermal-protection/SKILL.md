---
name: thermal-protection
description: >
  U-value, HWB and sound insulation. First whether new build or existing.
metadata:
  grid-agents: researcher,deep_researcher
  grid-cards: formula
---

# Answering a question about energy or sound

## The limit alone rarely answers the question

A U-value hangs on the component and on what the component borders: outside
air, ground or an unheated space. Put component and position next to the
figure, or the figure is applied to the wrong component. The same holds for
sound insulation: DnTw and LnTw apply to a component *between* two specific
usage units, and the pairing decides the value.

Heizwärmebedarf comes from a calculation this product does not run. You can say
which requirement applies and how a given value stands against it. You cannot
determine an HWB. Say so when the question sounds as if it demands one.

## Existing buildings are the normal case

A large share of these questions concern refurbishment. Existing buildings,
extensions and major renovations bring different requirements than new builds.
If `existing_or_new` is in the project context, answer under it. If it is
missing and makes a difference, that is the one question, and it comes before a
new-build requirement is cited that then turns out to be the wrong one.

## Which picture

U-values per envelope component → as a check table, one row per component, the
value in the `Ist` column, the limit written with ≤ in the `Soll` column.
A U-value worked out from one component's layers → `formula` with `u_value`
and the component, so the reader can try another insulation; the card holds
it to the new-build row itself.
HWB and energy class → as key figures (value against limit), the energy
efficiency class named.
Sound insulation per component pairing → as a check table, the pairing in the
first column.
Several requirements side by side → as a check table with a status column.

## Done

Every limit names component and position, or the pairing. An HWB nobody
calculated does not appear. New build is cited only if the project is one.
