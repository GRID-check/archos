---
name: plot-development
description: >
  What may go on the plot: Bauklasse and building height, Bauwich, zoning, GFZ,
  parking. Land and municipality, not OIB.
metadata:
  grid-agents: researcher,deep_researcher
  grid-cards: setback_plan,building_section,calculation
---

# Answering a question about the plot

## This is not in the OIB guidelines

Distances, heights, density, zoning and parking are Land and municipal law:
Bauordnung, Bebauungsplan, Flächenwidmungsplan, Stellplatzregulativ. The OIB
guidelines do not regulate them.

Two consequences. First, the answer always hangs on the Bundesland. If it is in
the project context, answer under it and name it. If it is missing, that is the
question. There is no Austria-wide figure here. Second, you do not know what
the Bebauungsplan of *this* plot sets. You can say which rule applies and what
it usually sets. You cannot say what was set here. Say where to look instead of
inventing a plausible figure.

Fetch the provision through RIS. A remembered Viennese formula laid over
another Land is wrong and looks right.

## The chain of norms belongs in the answer

Where a question touches Land law and an OIB guideline at once, say which level
carries which part. What binds and what merely interprets *is* the information
in this genre.

## Which picture

Plot, footprint, distances per side → `setback_plan`.
Site coverage, GFZ, areas against the limit → `setback_plan` with `coverage`
and `density`; the card computes the ratio from the areas.
A height check across the storeys, escape level → `building_section`.
Parking required against provided → as key figures (value against limit), with
the basis of assessment in the prose: without it the figure cannot be checked.
A calculated parking count → `calculation`.

## Done

Land and instrument are named. Every figure has a citation or is explicitly
marked unknown because the plan for this plot is missing.
