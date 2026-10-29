# Brand basis: what the brand says, and which source wins

The design system 3.0 handover (`tokens.json`, the component sheets) says how the brand
looks. The Markenbasis (the brand book, October 2026) says what the brand stands for and
how it speaks. Neither holds everything, and on a few points they disagree. This page
records the parts of the Markenbasis that no token or component carries, the values this
package had to derive because neither source gives them, and the precedence rule that
settles each conflict.

Sources: Markenbasis (14 pages) and the Moodboard „Schrift & Logo“ (8 slides), both owner
uploads, not in the repository; page numbers below are the PDF pages. Quotes stay German,
because the public copy is German first.

## Precedence

When two sources disagree, the first matching rule decides. The owner may revise it.

| Rule | Topic | Wins | Why |
|---|---|---|---|
| P1 | Visual values: colours, logo weight, nav weight, radii, spacing | Design system 3.0 | It is the later, binding hand-off („verbindliche Grundlage“) and the only source with exact values. |
| P2 | Positioning, values, tone, claims | Markenbasis | It is the brand's own statement. Where its examples break its own language rules, the rules win: no „KI-Workspace“, no „nimmt alles ab“. The audience is written „Architektur- und Planungsbüros“. |
| P3 | Third-party products | Neither may be shown | No third-party product imagery (the Moodboard's Harvey screenshot) and no competitor named on an ARCHOS surface. Harvey and Legora are a model for the business, never material. |
| P4 | Gaps | Encoded here | Markenbasis rules the design system lacks (below) live in this package and, where a machine can hold them, in `scripts/check_brand_rules.mjs`. |
| P5 | Austria | Facts stay, framing goes | „Hosting in Wien“ and the office address are facts. The brand itself is international: no Austria-centred marketing. |

### Conflicts and how they were settled

| Topic | Markenbasis / Moodboard | Design system 3.0 | Applied | Rule |
|---|---|---|---|---|
| Colours | `#FFFFFF`, `#F7F7F7`, `#5E5E5E`, `#111111` (MB p.13, MS s.3) | warm `#fafaf9` surface, `#f2f1f0` band, `#5e5b57` muted, `#0f0e0d` ink; never pure white or black | Design system | P1 |
| Logo weight | Switzer **Bold** (MB p.13) | Switzer **Semibold** (also MS s.2) | Semibold | P1 |
| Navigation weight | „Immer Medium“, one weight (MB p.13) | 420 for the navigation and the small header buttons (also MS s.2) | 420 | P1 |
| Fourth image family | „Linie“: line drawings (MB p.14, MS s.8) | „Animation“: the explainer video | Both: Linie is an image family, the animation is a video format (see Imagery) | P4 |
| ™ | Wordmark set as „ARCHOS™“ (MB p.1, p.14) | Text: „ARCHOS, ohne ™“ | No ™ in running text or UI; the wordmark component carries none either (there is no vector artwork yet) | P1 |
| Product noun | MB p.9 offers „Der KI-Workspace, in dem Ihr Projekt entsteht.“ | – | Not used: MB p.12 forbids „KI-Workspace“ | P2 |
| Mission | „Wir nehmen Planer:innen alles ab, was nicht Planung ist.“ (MB p.2) | – | Public wording „Wir übernehmen, was Planer:innen vom Planen abhält.“ (MB p.12's own „So“) | P2 |
| Hero line | „Der Workspace für Planungsbüros.“ (MB p.9, p.12) | „Der Workspace für Architekturbüros.“ (reference site) | Audience „Architektur- und Planungsbüros“; the website's hero copy is the website's decision | P2 |
| Address | „euch“ (MB p.4) and „Ihr Projekt“ (MB p.9–11) | „Sie“ | „Sie“ | P2 (the brand book itself uses „Ihr“ in product sentences) |
| Look model | „ähnlich wie bei Harvey“ (MB p.13); Harvey screenshot (MS s.7) | – | Never shown or named | P3 |

## Positioning

> „ARCHOS positioniert sich als der Workspace für Planungsbüros. Er verbindet Projekte,
> Fachwissen und KI in einem gemeinsamen Arbeitsraum.“ (MB p.2, p.9)

- Field: industry-specific, and for the project and the team (MB p.9). Not a tool for one
  person, not a platform for the whole construction industry.
- Claim: „Building forward.“ The only English line; set „ARCHOS. Building forward.“ with
  the full stops (MB p.10, p.12).
- Audience, in this order: larger architecture offices in the DACH region, then specialist
  planners (landscape, structure, facade), later smaller offices (MB p.6).
- What ARCHOS does today, next and later (MB p.3): faster, better information search
  (building law, material values); then automating single tasks with the office's own
  documents (compare, evaluate, check); in the long run the „Office Brain“ that connects
  projects, knowledge, plans and models and takes on „die ausführbare Arbeit dazwischen“.
- Division of labour (MB p.3, p.11): „ARCHOS generiert keine Entwürfe. ARCHOS automatisiert
  wiederkehrende Aufgaben im Planungsprozess.“ Design, stance and architectural innovation
  stay with people.

## Mission, vision, values

- **Mission** (public wording): „Wir übernehmen, was Planer:innen vom Planen abhält.“
  The brand book's internal form („alles ab, was nicht Planung ist“) breaks its own rule
  „präzise statt absolut“, so it does not appear in copy (P2).
- **Vision**: „Eine Planungswelt, in der Mensch und Maschine ihre Stärken ausspielen: Die
  Maschine übernimmt das Regelgeleitete, der Mensch entwirft. So wird besser, sicherer und
  schneller gebaut.“ (MB p.2)
- **Values** (MB p.2–4):
  - *Branchennähe*: „Wir sprechen Planung.“
  - *Präzision*: „Was wir liefern, muss stimmen.“
  - *Fortschritt, der in der Praxis ankommt*: „Neues muss im Büroalltag funktionieren, nicht nur im Experiment.“
  - *Klare Rollen für Mensch und KI*: „Wir versprechen keine KI-Utopie.“

## What ARCHOS is not (antonyms)

From MB p.2. A sentence that makes ARCHOS one of these is wrong, however good it sounds.

- not a generative design tool
- not an AI tool, not a chatbot
- not one more single-purpose tool
- not a platform for the whole construction industry
- not an AI utopia
- not loud, colourful or playful

## Tonality

„Ruhig, klar, selbstbewusst. Kurze Sätze, Fakten statt Versprechen, keine Floskeln.“ (MB p.2)
ARCHOS „spricht wie ein Planungsbüro, das Technologie sehr gut versteht – nicht wie ein
Technologieunternehmen, das Architektur entdeckt hat“ (MB p.12). Closeness comes from
expertise, not from warmth (MB p.5).

The brand's eleven sliders (MB p.5) lean to: challenger, international, serious, quiet,
elite, tech, black and white, professional, straightforward, reserved. „Revolution“ on the
slider means the size of the change for the office, never a word in copy.

Language rules (MB p.12), each with the brand book's own „So“:

| Rule | So | Not so |
|---|---|---|
| Short and self-assured | „Der Workspace für Planungsbüros.“ | „Die innovative KI-Lösung, die Ihren Planungsalltag revolutioniert.“ |
| Performance before promise | „Baurecht durchsuchen. Unterlagen vergleichen. Modelle prüfen.“ | „Mehr Freiheit für Ihre Kreativität.“ |
| Planning language, not AI language | „Planstand, Modell, Baurecht, Projektwissen“ | „LLMs, Agents, Reasoning-Modelle“ |
| AI as a property, not an actor | „ARCHOS prüft das Modell gegen das Baurecht.“ | „Unsere KI prüft das Modell.“ |
| Clear roles | „Planer:innen entwerfen. ARCHOS sucht, vergleicht und prüft.“ | „KI als Ersatz für Planer:innen“ |
| Progress without utopia | „Das Planungsbüro der Zukunft entsteht heute.“ | „ARCHOS revolutioniert die Architektur.“ |
| Precise, not absolute („alles“, „immer“, „vollständig“ sparingly) | „Wir übernehmen, was Planer:innen vom Planen abhält.“ | „Wir nehmen Planer:innen alles ab.“ |
| Closeness through competence | „Jede Planungsrunde erzeugt Arbeit. ARCHOS reduziert sie.“ | „Nervige Aufgaben? Macht jetzt die KI.“ |

Fixed terms: ARCHOS is a *Workspace* or a *Plattform*, never a tool or a copilot, never a
„KI-Workspace“. Use „KI“ sparingly, only where it explains something. German is the
default; avoid English marketing words where a clear German one exists. Gender with a
colon (Planer:innen). Recurring words: Planung, Planungsbüro, Planer:innen, Projekt,
Workspace, Pläne, Modelle, Unterlagen, Wissen, suchen, vergleichen, prüfen, automatisieren.

## Belegpflicht: every claim has a source

„Belegt wird das mit Fakten und, sobald vorhanden, mit Zahlen aus den Piloten.“ (MB p.10)

- A number, a percentage or a comparison in copy names its source next to it or in a
  footnote, and the source is public or ours (pilot data).
- An outside study is cited by name and date, e.g. „Labor market impacts of AI“
  (Anthropic, March 2026), which the brand book uses for the exposure of architecture and
  engineering to AI (MB p.6).
- No certificate, partner or customer that does not exist (design system, Datensicherheit).
- Until pilot numbers exist, the copy says what ARCHOS does, not how much it saves.

Machines cannot judge a source. Review holds this rule; `RETRACTED_CLAIMS` in
`scripts/check_brand_rules.mjs` holds the claims already retracted, on the website's copy.

## Imagery: four families

From MB p.14, with the design system's formats.

1. **Material**: real working material (printed plans, sketch rolls, cardboard models,
   pencils, scale rulers), photographed straight from above like a plan view, in soft
   natural light. Shows hybrid work: analogue planning and ARCHOS.
2. **Menschen**: calm, documentary photos at the table, with plans, in conversation.
   Later: portraits from the pilot offices.
3. **Linie**: fine line drawings instead of illustrations: floor-plan fragments, figure-
   ground plans, axes, axonometries. Black on light, the same stroke weights as the rest
   of the brand (`stroke-hairline`, `stroke-strong`), no shadows, no fills, no colour. The
   blog's line figures (`apps/website/src/components/figures/`) belong to this family.
4. **Produkt**: flat product cut-outs on exactly `surface-sunken`, never floating laptop or
   phone mock-ups; rather a detail (a plan excerpt with ARCHOS's answer beside it) than a
   whole screen.

The explainer animation (2:1 video on `surface-sunken`, no sound, never autoplay) is a
format, not a fifth family; it draws in the Linie family's manner. AI-generated images
carry the `AITag` (see `components/AITag.md`); no generated copies of someone else's photo.

## Logo: clear space and minimum size

Neither source defines these (MB and DS both silent), so this package derives them from the
wordmark's own proportions. Measured on Switzer Semibold, capitals, tracking −0.02em:
the cap height is 0.68 em, the word „ARCHOS“ is 3.98 em wide (5.9 cap heights).

Let **X** be the cap height of the wordmark as set (0.68 × its font size).

- **Clear space: X on every side.** Nothing (text, image edge, button) comes closer. In the
  header (22px wordmark, X = 15px, 64px bar) the vertical space is 21px above and below; in
  the footer sets it at 28px (X = 19px). Check a new placement against it.
- **Minimum size: 16px font size on screen** (X = 11px, the word about 64px wide) and **20mm
  wide in print**. Below that the semibold counters close up. The app icon (`mark.svg`)
  stands in where the word would be smaller.
- Lockups with the claim (MB p.1, p.14): stacked (wordmark, claim below, left-aligned) or
  horizontal (claim beside it, smaller). The claim takes the clear space of the wordmark,
  and the gap between them is X.

These numbers are derived, not handed over. TODO(owner): confirm them, or replace them when
a vector logo with its own spacing arrives.
