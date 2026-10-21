# What the north star sounds like: worked answers

[`agent-capabilities.md`](agent-capabilities.md) describes the north star in
seven scenes: talking to Piloti feels like talking to the most experienced
architect in the office. This document shows what that means for single turns.
Each exemplar is one question an architect asks in the Hubergasse project,
what Piloti does to answer it, and the answer it gives, written out in full.

This is the star, not today's behaviour. Several exemplars use moves that have
not landed yet (a look card in the chat, a Herleitung step per look, a canvas
turn in the eval harness, noticing without being asked). The gap between an
exemplar and a real turn is the work still to do. Do not lower an exemplar to
match what ships today: lower it only when the star itself was wrong.

## How to use it

- **Reviewing a change to the prompt, a tool or the answer pipeline.** Find the
  exemplars the change touches and ask whether a real turn moved toward them
  or away. The "Must not" lists are the cheapest review checklist we have.
- **Evals.** Every exemplar has a row in
  [`tests/fixtures/north_star/north_star_questions.yaml`](../../tests/fixtures/north_star/north_star_questions.yaml),
  asked against the existing office-file and visual fixture projects:
  `task be:eval:answer-suite -- --set north-star`. A row that needs something
  the harness lacks (an upload, a second project) is
  reported as not applicable on this commit, and a horizon row is listed but
  never run. `tests/test_north_star_rows.py` keeps this document and the rows
  in step.
- **Demos.** These are the turns to show. If a demo turn does not look like its
  exemplar, show the exemplar's gap honestly rather than a different question.
- **Judging an answer.** The [rubric](#the-rubric) at the end is written so a
  reviewer or an LLM judge can apply it to any answer, not only these.

### Conventions in the exemplars

- Prose of this document is English. The question and Piloti's answer are
  German, as an architect asks and as Piloti answers people.
- **Trajectory** lists the model's own tool calls in order, with the
  arguments that matter. Calls in one numbered step run in the same round. The
  round-0 prefetch is not listed. `look`'s `question` argument is ADR-0128's;
  until it lands, the same look goes without it.
- **Herleitung** is what the reader sees above the answer: short German step
  lines, the way a senior writes notes, not tool names.
- **Answer** is the `answer` field as it renders, with its sources section.
  Where Piloti writes a non-breaking space between a number and its unit, this
  document writes an ordinary space so it stays readable in an editor.
  `[[card:N]]` places a card. The envelope fields that matter follow the answer.
- Legal Fundstellen (a Punkt, a definition) are what the answer must cite
  **after retrieving them in that turn**. They are here to show the form of a
  provenance-honest sentence. The eval checks the retrieval and the wording,
  never this document's memory of the Richtlinie, so verify a Punkt against
  the corpus before you copy it into a fixture.
- **Provenance words.** An ideal answer tells the reader where each sentence
  comes from, in plain German and without labels: what a document says („laut
  Brandschutzkonzept“, with `[N]`), what a drawing shows („abgelesen“, with the
  crop), what the law requires (a cited passage, always), what a workspace
  record says („laut Dateiliste“, never `[N]`), and what is Piloti's own
  inference („nach meiner Einschätzung“, „überschlägig“). This is ADR-0125's
  provenance class made audible.

### The fixtures

The exemplars are asked in the two fixture projects the answer suite already
seeds, two slices of one invented project, the Aufstockung of the
Gründerzeithaus Hubergasse 14 in 1160 Wien:

- **files** (`proj_files_eval`, [`tests/fixtures/files_eval/project.yaml`](../../tests/fixtures/files_eval/project.yaml)):
  twelve documents in six folders as text pages. Planted: „Fluchtweg“ on
  pages 3, 7 and 11 of the 14-page Brandschutzkonzept, „Sprinkler“ nowhere,
  three Geschäftszahlen of the MA 37, EP-01 in Index A and B. Planted by the
  intake eval and used here: the Brandschutzkonzept says 11 Wohnungen while
  Index B, which it names as its basis, has 10; no document states the
  Fluchtniveau; the neighbour's Gutachten states one (13,80 m) for its own
  house.
- **visual** (`proj_visual_eval`, [`tests/fixtures/visual/drawings.json`](../../tests/fixtures/visual/drawings.json)):
  three drawings rendered at suite start, whose values are on the sheet and in
  no indexed text. EG Index B has five doors and Index A four; the Wohnen
  dimension is 5,24 in Index B and 5,04 in Index A.

The two slices share their facts, and `tests/test_fixture_consistency.py`
keeps them shared: Index B is dated 03.02.2026, Index A 14.11.2025, and the
Planverfasser is Atelier Lindner Architektur ZT GmbH. EP-01 is drawn at 1:100
and EP-02, the Schnitt, at 1:50, in the Plankopf of the drawings and in the
Plankopf text of the files slice alike. The Schnitt's scale differing from the
Grundrisse's is planted: a row that reads the Schnitt must not answer 1:100.

## The exemplars

| id | Scene | Capability | Fixture | Today's row |
|---|---|---|---|---|
| [ns-orient-project](#ns-orient-project) | 1 | orient in a project | files | pf-orient-project |
| [ns-current-fassung](#ns-current-fassung) | 1 | aggregate counts, current Fassung | files | pf-aggregate-count |
| [ns-read-through](#ns-read-through) | 2, 6 | read a long report through | files | pf-read-through |
| [ns-geschaeftszahlen](#ns-geschaeftszahlen) | 2 | regex search for a pattern | files | pf-regex |
| [ns-not-in-documents](#ns-not-in-documents) | 2 | prove an absence, no invention | files | pf-exact-absent |
| [ns-dimension](#ns-dimension) | 3 | a dimension from a drawing | visual | pv-dim-wohnen |
| [ns-door-count](#ns-door-count) | 3 | count on a drawing | visual | pv-count-doors-eg-b |
| [ns-plankopf](#ns-plankopf) | 3 | Plankopf values | visual | pv-title-scale, pv-title-date |
| [ns-fassung-compare](#ns-fassung-compare) | 3, 4 | compare two Fassungen | visual | pv-fassung-overall |
| [ns-drawn-box](#ns-drawn-box) | 3, 4 | a box the person drew | visual | none (`box: given`) |
| [ns-parity](#ns-parity) | 4 | chat and canvas as mirrors | visual | pv-dim-galerie |
| [ns-escape-route-law](#ns-escape-route-law) | 2 | project fact against OIB-RL 2 | files | pf-mixed-law |
| [ns-gk-unstated](#ns-gk-unstated) | 2, 1 | the decisive fact no document states | files | none |
| [ns-propose-move](#ns-propose-move) | 1 | a write as a proposal | files | none |
| [ns-piloti-ask](#ns-piloti-ask) | 4 | an outside agent asks Piloti | files | none |
| [ns-trivial](#ns-trivial) | restraint | a trivial question stays fast | files | pf-locate-name |
| [ns-notice-new-document](#ns-notice-new-document) | 5 | notice unasked (**horizon**) | files | horizon |
| [ns-learn-office](#ns-learn-office) | 7 | learn the office (**horizon**) | files | horizon |

Scene 6, the Herleitung as a lab notebook, is in every exemplar.

---

### ns-orient-project

**Scene** 1 · **Capability** orient in a project · **Fixture** files · **Row** `ns-orient-project` (extends `pf-orient-project`)

**Setting.** The project chat of the Hubergasse, nothing open on the canvas.
The person has just been put on the project.

**Question.**

> Ich übernehme die Hubergasse ab morgen. Was liegt da alles, und wo steht das Projekt?

**Trajectory.**

1. `list_files(view="tree", depth=2)`: one call, six folder cards with counts,
   Dokumentart mix, pages, dates and the current Fassung per document. The
   orientation is a listing, not a search.
2. In one round, for "wo steht das Projekt", which only the newest documents
   answer:
   - `read_passage(document="Schreiben_MA37_Baubeginn.pdf", page=1, conclusion="Zwölf Dokumente in sechs Ordnern; das neueste ist ein Schreiben der MA 37, was es bestätigt, steht nur darin.")`
   - `read_passage(document="Bescheid_MA37_Baubewilligung.pdf", pages="1-2", conclusion="…")`: the
     bewilligte Fassung on page 1 and the Vorschreibungen, which are what the
     authority still expects, on page 2.

No look, no search, no read of the other ten documents: the cards say what
they are.

**Herleitung.**

> Projekt geöffnet: 12 Dokumente in 6 Ordnern
> Gelesen: Bestätigung der Baubeginnsanzeige, S. 1
> Gelesen: Baubewilligung, S. 1–2

**Answer.**

```md
Die Hubergasse 14 ist bewilligt, und die Bauführung ist angezeigt: Die MA 37 hat am 02.06.2026 die Baubeginnsanzeige bestätigt [1], gestützt auf den Bescheid MA 37/567812-2026-1 vom 28.04.2026 [2].

| Ordner | Was dort liegt |
|---|---|
| Einreichung | 6 Dokumente: Baubeschreibung, Energieausweis, Wohnungsliste; im Unterordner Pläne die Grundrisse EP-01 in Index A und B und der Schnitt EP-02 |
| Behörde | Baubewilligung, Bebauungsbestimmungen |
| Gutachten | Brandschutzkonzept, 14 Seiten |
| Korrespondenz | Bestätigung der Baubeginnsanzeige, zuletzt hochgeladen (10.06.2026) |
| Nachbarn | Brandschutzgutachten Hubergasse 16 |
| Bestand | Bestandsplan 1974 |

Maßgeblich sind die Grundrisse in Index B: Der Bescheid bewilligt EP-01 und EP-02 in Index B vom 03.02.2026 [2]. Index A liegt noch daneben und ist nicht als ersetzt markiert.

Offen gegenüber der Behörde: Die Rauchabzugseinrichtung im Stiegenhaus ist vor Fertigstellung von einem Sachverständigen abnehmen zu lassen [3].

**Quellen:**
- [1] Schreiben_MA37_Baubeginn.pdf, p.1
- [2] Bescheid_MA37_Baubewilligung.pdf, p.1
- [3] Bescheid_MA37_Baubewilligung.pdf, p.2
```

`kind: walkthrough` · `confidence: high` („Stand aus Bescheid und Bestätigung der MA 37 belegt“)

**Cards and places.** A folder tree card (the `list_files` tree, collapsed to
the six folders) under the table. Each `[N]` opens the page. No look card.

**Must not.**

- Read all twelve documents, or search, to describe a project whose cards
  already say what each document is.
- Dump twelve file lines instead of six folders with what they mean.
- Present Index A's content as the project's, or call Index A „ungültig“ (it
  is the older Fassung, still readable).
- Take any value from the neighbours' Gutachten for this house.
- Call a document a „Plan“ in Piloti's own words; the Unterordner is named
  „Pläne“ because the office named it so.
- Cite a folder card with `[N]`: a listing is a record, named in the prose.

**Checks.** Row `ns-orient-project`: `list_files` with `view: tree`, no look,
at most three rounds, the six folder names and „Index B“ in the answer.
Langfuse: `file-tools-used` = `navigate`; `claims-by-class` shows `record`
and `cited` and no `model_knowledge`; `answer-confidence` high;
`folder-card-fresh` true.

---

### ns-current-fassung

**Scene** 1 · **Capability** aggregate counts and the current Fassung · **Fixture** files · **Row** `ns-current-fassung` (extends `pf-aggregate-count`)

**Setting.** Project chat, nothing open.

**Question.**

> Wie viele Unterlagen liegen in der Einreichung, und welcher Index der Grundrisse gilt?

**Trajectory.**

1. `list_files(view="tree", folder="Einreichung")`: the folder card counts
   the documents, including the Unterordner, and names the current Fassung.
   That is the whole answer; nothing needs to be opened.

**Herleitung.**

> Ordner Einreichung geöffnet: 6 Dokumente, davon 3 im Unterordner Pläne

**Answer.**

```md
Sechs: drei direkt in der Einreichung (Baubeschreibung, Energieausweis, Wohnungsliste Index B) und drei im Unterordner Pläne (EP-01 Grundrisse in Index A und Index B, EP-02 Schnitt A-A).

Bei den Grundrissen gilt Index B vom 03.02.2026; Index A vom 14.11.2025 ist die ältere Fassung. Das stützt sich auf Index und Datum aus dem Plankopf, dem Namen nach: Verknüpft hat die beiden Dateien noch niemand.
```

`kind: direct` · `confidence: high` („Anzahl und Index laut Dateiliste“)

**Cards and places.** The Einreichung folder card. Each file name is a link
that opens the file.

**Must not.**

- Say „vier“ by missing the Unterordner, or „sieben“ by counting the folder.
- Open or look at the Grundrisse: the index is in the listing, and a look adds
  nothing here.
- State as settled that Index A is superseded: only a person's link makes it
  so, and the answer says what it rests on.
- Close with an offer („Soll ich die Fassungen verknüpfen?“).

**Checks.** Row `ns-current-fassung`: `list_files` with `view: tree`, no
`read_passage`, no look, at most two rounds; „6“ or „sechs“, „Index B“ and the
date. Langfuse: `file-tools-used` = `navigate`; `claims-by-class` all
`record`; latency in the fast band of the suite report.

---

### ns-read-through

**Scene** 2 and 6 · **Capability** read a long report through, with continuation · **Fixture** files · **Row** `ns-read-through` (extends `pf-read-through`)

**Setting.** Project chat. The person has a call with the author of the
Brandschutzkonzept tomorrow.

**Question.**

> Fass mir das Brandschutzkonzept Kapitel für Kapitel zusammen, ich telefoniere morgen mit Dr. Pichler.

**Trajectory.**

1. `read_passage(document="Brandschutzkonzept_Hubergasse14.pdf", pages="1-14")`:
   the page count is on the folder card and in the inventory, so the whole
   range is asked in one call. The read returns pages 1 to 9 and a `cursor`.
2. `read_passage(document="Brandschutzkonzept_Hubergasse14.pdf", cursor="<cursor>", conclusion="Kapitel 1 bis 3 gelesen; das Konzept nennt 11 Wohnungen und beruft sich auf Index B. Es fehlen die Kapitel 4 bis 7.")`.
3. `knowledge_search(match="exact", query="Wohnungen gesamt", folder="Einreichung", conclusion="Das Konzept zählt 11 Wohnungen auf Basis von Index B; was Index B selbst zählt, steht in den Grundrissen.")`:
   one targeted check of a number that will matter on the phone. It returns
   EP-01 Index A p.2 („11“) and Index B p.2 („10“).

**Herleitung.**

> Gelesen: Brandschutzkonzept, S. 1–9
> Weitergelesen: S. 10–14
> Wörtlich gesucht in der Einreichung: „Wohnungen gesamt“, 2 Treffer

**Answer.**

```md
Das Konzept hat sechs Kapitel und eine Schlussbemerkung:

| Kapitel | Kern | Seite |
|---|---|---|
| 1 Vorhaben und Grundlagen | Aufstockung auf Grundlage von EP-01 und EP-02 in Index B und OIB-RL 2, Mai 2023; GK 4 nach Aufstockung, 11 Wohnungen | [1] [2] |
| 2 Bauliche Maßnahmen | Bestehendes Stiegenhaus als einziger vertikaler Rettungsweg, im 3. OG höchstens 12 m bis zum Stiegenhaus; Decken REI 60, tragende Bauteile der Aufstockung R 60; Brandabschnitte BA-01 bis BA-03, Feuermauern REI 90; Wohnungseingangstüren EI2 30-C | [3]–[6] |
| 3 Rettungswege und Aufzug | Sicherheitsbeleuchtung je Geschoß; Rauchabzugsöffnung ≥ 1 m² an oberster Stelle; Aufzug kein Rettungsweg, Schacht EI 60, Schachttüren E 30 | [7]–[9] |
| 4 Anlagentechnischer Brandschutz | Vernetzte Rauchwarnmelder, keine Brandmeldeanlage | [10] |
| 5 Abwehrender Brandschutz | Zufahrt über die Hubergasse, keine trockene Steigleitung (Drehleiter); Hydranten etwa 60 m entfernt, je Geschoß ein Feuerlöscher 6 kg | [11] [12] |
| 6 Organisatorischer Brandschutz | Brandschutzordnung Teil A und B, jährliche Wartung von Rauchabzug und Meldern | [13] |
| Schlussbemerkung | Wird mit dem Bescheid verbindlich; Änderungen nach Index B sind dem Verfasser vorzulegen | [14] |

Für das Telefonat: Das Konzept nennt 11 Wohnungen [2], beruft sich aber auf Index B [1], und Index B zählt nach der Zusammenlegung von Top 10 und 11 nur noch 10 [15]. Die 11 entsprechen Index A [16].

**Quellen:**
- [1] Brandschutzkonzept_Hubergasse14.pdf, p.1
- [2] Brandschutzkonzept_Hubergasse14.pdf, p.2
- …
- [14] Brandschutzkonzept_Hubergasse14.pdf, p.14
- [15] EP-01_Grundrisse_Index-B.pdf, p.2
- [16] EP-01_Grundrisse_Index-A.pdf, p.2
```

`kind: walkthrough` · `confidence: high` („jedes Kapitel aus dem gelesenen Konzept belegt“) · `callout` (note): „Wohnungszahl im Konzept (11) passt nicht zu Index B (10).“

**Cards and places.** No card: the table is the answer. Each `[N]` opens its
page. The callout sits beside the last paragraph.

**Must not.**

- Summarise from the outline or from search hits: a summary of every chapter
  needs every page read.
- Read page by page in fourteen calls, or read pages 1 to 9 again after the
  cursor.
- Stop at the first block and summarise chapters 4 to 7 from the Gliederung.
- Quote whole paragraphs; the table says the requirement, the page holds it.
- Present the 11 Wohnungen as the project's count.
- Mention the 11/10 mismatch without both sources cited.

**Checks.** Row `ns-read-through`: `read_passage` with `pages`, at most four
rounds, at least five of the six chapter markers, judge `flags_mismatch`.
Langfuse: `file-tools-used` = `both`; `quotes-verbatim-rate` 1; `citation-health`
without dropped citations.

---

### ns-geschaeftszahlen

**Scene** 2 · **Capability** find every instance of a pattern · **Fixture** files · **Row** `ns-geschaeftszahlen` (extends `pf-regex`)

**Setting.** Project chat. The person is drafting a letter to the Baupolizei.

**Question.**

> Welche Geschäftszahlen der MA 37 kommen in unseren Unterlagen vor? Ich brauch sie für das nächste Schreiben an die Baupolizei.

**Trajectory.**

1. `knowledge_search(match="regex", query="MA ?37/\d{6}(-\d{4})?(-\d+)?", context=1)`:
   a Geschäftszahl is a pattern, not a word, so a ranked search would find one
   and miss the rest. The regex returns every hit with its line and a table of
   files and counts: the Bescheid p.1 (one), the letter p.1 (three).

**Herleitung.**

> Wörtlich gesucht (Muster): MA 37/Zahl – 4 Treffer in 2 Dokumenten

**Answer.**

```md
Drei:

| Zahl | Wozu | Fundstelle |
|---|---|---|
| MA 37/567812-2026-1 | Baubewilligung, Bescheid vom 28.04.2026 | [1], im Schreiben vom 02.06.2026 wieder zitiert [2] |
| MA 37/654321-2026 | Bestätigung der Baubeginnsanzeige vom 02.06.2026 | [2] |
| MA 37/123456-2026 | Vorverfahren | [2] |

Zum Vorverfahren 123456-2026 liegt im Projekt kein eigenes Dokument; die Zahl steht nur als Verweis im Schreiben vom 02.06.2026.

**Quellen:**
- [1] Bescheid_MA37_Baubewilligung.pdf, p.1
- [2] Schreiben_MA37_Baubeginn.pdf, p.1
```

`kind: walkthrough` · `confidence: high` („alle Treffer der Mustersuche zitiert“)

**Cards and places.** None beyond the citations.

**Must not.**

- Search by meaning, list the one number that ranks first, and stop.
- Count four Geschäftszahlen because one appears twice.
- Say what the Vorverfahren was about: no document says it.
- Recommend which number the letter must carry as if the documents said so.

**Checks.** Row `ns-geschaeftszahlen`: `knowledge_search` with `match` regex
or exact, no look, at most two rounds, all three numbers. Langfuse:
`file-tools-used` = `search`; `claims-by-class` all `cited`.

---

### ns-not-in-documents

**Scene** 2 · **Capability** prove an absence, invent nothing · **Fixture** files · **Row** `ns-not-in-documents` (extends `pf-exact-absent`)

**Setting.** Project chat. The building services engineer has asked the
project lead.

**Question.**

> Ist im Brandschutzkonzept eine Sprinkleranlage vorgesehen? Die Haustechnik fragt für die Ausschreibung.

**Trajectory.**

1. In one round:
   - `knowledge_search(match="exact", query="Sprinkler | Löschanlage | Sprühwasser")`
     over the whole project, not only the Konzept: the Haustechnik needs to
     know whether it is written anywhere. Zero hits in twelve documents.
   - `read_passage(document="Brandschutzkonzept_Hubergasse14.pdf", pages="8-10")`:
     the Gliederung puts the Stiegenhaus and the anlagentechnischer Brandschutz
     there, which is what the Ausschreibung does need.

**Herleitung.**

> Wörtlich gesucht im ganzen Projekt: „Sprinkler“, „Löschanlage“, „Sprühwasser“ – kein Treffer in 12 Dokumenten
> Gelesen: Brandschutzkonzept, S. 8–10

**Answer.**

```md
Nein. „Sprinkler“, „Löschanlage“ und „Sprühwasser“ stehen in keinem der zwölf Dokumente des Projekts.

Anlagentechnisch sieht das Konzept vernetzte Rauchwarnmelder in allen Aufenthaltsräumen und in den Gängen vor, über die Fluchtrichtungen laufen; eine Brandmeldeanlage hält es für ein Wohngebäude dieser Größe nicht für erforderlich [1]. Dazu kommt die Rauchabzugsöffnung an oberster Stelle des Stiegenhauses, auslösbar vom Erdgeschoß [2].

**Quellen:**
- [1] Brandschutzkonzept_Hubergasse14.pdf, p.10
- [2] Brandschutzkonzept_Hubergasse14.pdf, p.8
```

`kind: walkthrough` · `confidence: high` („Wortsuche im ganzen Projekt ohne Treffer, Ausstattung aus S. 8 und 10“)

**Must not.**

- Answer „nicht vorgesehen, weil nach OIB-RL 2 nicht gefordert“ without having
  retrieved the Richtlinie this turn; the question did not ask about the law.
- Take the Brandmeldeanlage with Rauchansaugsystem from the neighbours'
  Gutachten (Hubergasse 16) for this house.
- Say „nicht gefunden“ without the scope searched, or after a ranked search
  that returned near misses.
- Escalate to a research report: the absence is the answer.

**Checks.** Row `ns-not-in-documents`: an exact or regex search, judge
`none_found`, „Rauchwarnmelder“ in the answer. Langfuse: `sources-empty`
false (the read found the equipment); `claims-normative-uncited` 0.

---

### ns-dimension

**Scene** 3 · **Capability** a dimension read off a drawing · **Fixture** visual · **Row** `ns-dimension` (extends `pv-dim-wohnen`)

**Setting.** Project chat, nothing open. The inventory holds EP-01 in Index A
and B; their indexed text is a caption only.

**Question.**

> Wie breit ist der Wohnraum im Erdgeschoß?

**Trajectory.**

1. No call to choose the Fassung: the inventory names Index A and Index B, and
   the question asks for the current state, so Index B, dem Namen nach.
2. `look(document="EP-01_Grundrisse_Index-B.pdf", page=1)`: one whole page, to
   find the room and its dimension chain on a sheet it has not seen.
3. `look(document="EP-01_Grundrisse_Index-B.pdf", page=1, region=[0.03, 0.42, 0.2, 0.12], question="Welches Maß steht an der Maßkette unter dem Raum Wohnen?")`:
   the printed figure, sharp. An expert does not state a dimension read from
   an overview.

**Herleitung.**

> Angesehen: Grundrisse Index B, S. 1, ganzes Blatt
> Angesehen: Grundrisse Index B, S. 1, Mitte links – Maßkette unter Wohnen: 5,24

**Answer.**

```md
**5,24 m**, eingetragen an der Maßkette unter dem Wohnraum im Grundriss Erdgeschoß, Index B [1].

[[card:1]]

Abgelesen, nicht abgegriffen: Das ist das eingetragene Maß. Index B ist dem Namen nach die aktuelle Fassung.

**Quellen:**
- [1] EP-01_Grundrisse_Index-B.pdf, p.1
```

`kind: direct` · `confidence: high` („Maß im Ausschnitt abgelesen“)

**Cards and places.** One look card with one item: the crop of the dimension,
the figure highlighted. Clicking it opens EP-01 Index B at page 1 with the
region glowing. The whole-page look is a Herleitung line, not a card item.

**Must not.**

- State a dimension without a look, or from the caption, or from a search hit.
- Answer 5,04 m, Index A's value; or mention Index A's value unasked.
- Measure the room by scale („ca. 5,2 m“) when a figure is printed.
- Show the whole-page overview as a card.

**Checks.** Row `ns-dimension`: a look, the gold box `dim-wohnen` on Index B
covered, „5,24“ in the answer and „5,04“ not. Report: looks per run (ideal 2),
IoU. Langfuse (ADR-0128, planned): `look-count` 2, `looked-before-measurement`
true.

---

### ns-door-count

**Scene** 3 · **Capability** count on a drawing: overview, then regions · **Fixture** visual · **Row** `ns-door-count` (extends `pv-count-doors-eg-b`)

**Setting.** Project chat, nothing open.

**Question.**

> Wie viele Türen hat das Erdgeschoß?

**Trajectory.**

1. `look(document="EP-01_Grundrisse_Index-B.pdf", page=1)`: the whole sheet,
   once, to see the layout: two rows of rooms in the left two thirds, legend
   and Plankopf on the right.
2. In one round, two regions that split the drawing without overlap, so no
   door is counted twice:
   - `look(…, page=1, region=[0.03, 0.08, 0.68, 0.40], question="Türsymbole zählen und verorten")`
   - `look(…, page=1, region=[0.03, 0.48, 0.68, 0.38], question="Türsymbole zählen und verorten")`

**Herleitung.**

> Angesehen: Grundrisse Index B, S. 1, ganzes Blatt
> Angesehen: obere Raumreihe – 2 Türen
> Angesehen: untere Raumreihe – 3 Türen

**Answer.**

```md
**Fünf Türen** im Grundriss Erdgeschoß, Index B [1]:

- zwischen Wohnen und Küche und zwischen Küche und Bad,
- je eine an der Oberkante von Schlafen und Kind,
- eine zwischen Schlafen und Kind.

[[card:1]]

Gezählt sind die Türsymbole in zwei Ausschnitten, die das Blatt ohne Überschneidung teilen; eine Türliste, gegen die sich die Zählung prüfen ließe, liegt im Projekt nicht.

**Quellen:**
- [1] EP-01_Grundrisse_Index-B.pdf, p.1
```

`kind: direct` · `confidence: high` („in zwei Ausschnitten gezählt“)

**Cards and places.** One look card with the two crops, each door marked.
Clicking an item opens the region on the canvas.

**Must not.**

- Count from the whole-page overview alone and call it certain.
- Count Index A (four) or mix the Fassungen.
- Use overlapping crops and count the doors on the seam twice.
- Spend all six looks on one question that two regions answer.

**Checks.** Row `ns-door-count`: a look, the gold box `plan-area` covered,
„5 Türen“ or „fünf Türen“, not „4 Türen“. Report: looks per run (ideal 3).

---

### ns-plankopf

**Scene** 3 · **Capability** read the Plankopf · **Fixture** visual · **Row** `ns-plankopf` (extends `pv-title-scale`, `pv-title-date`)

**Setting.** Project chat, nothing open.

**Question.**

> Welcher Maßstab und welches Datum stehen im Plankopf vom Schnitt A-A?

**Trajectory.**

1. `look(document="EP-02_Schnitt_A-A.pdf", page=1, region=[0.70, 0.66, 0.30, 0.30], question="Maßstab, Datum und Index im Plankopf")`:
   straight to the bottom right, where a Plankopf sits by convention. Only if
   the crop held no Plankopf would a whole-page look follow.

**Herleitung.**

> Angesehen: Schnitt A-A, S. 1, Plankopf rechts unten

**Answer.**

```md
Maßstab **1:50**, Datum **03.02.2026**, Index B, so im Plankopf rechts unten auf EP-02 [1].

[[card:1]]

**Quellen:**
- [1] EP-02_Schnitt_A-A.pdf, p.1
```

`kind: direct` · `confidence: high` („im Plankopf abgelesen“)

**Must not.**

- Give the Grundrisse's 1:100 for the Schnitt.
- Read small Plankopf text off a whole-page render.
- Add the Planverfasser and every other Plankopf field unasked.

**Checks.** Row `ns-plankopf`: a look, gold boxes `title-scale` and
`title-date` covered, „1:50“ and „03.02.2026“. Report: one look is the ideal.

---

### ns-fassung-compare

**Scene** 3 and 4 · **Capability** compare two Fassungen, the change shown · **Fixture** visual · **Row** `ns-fassung-compare` (extends `pv-fassung-overall`)

**Setting.** Project chat, nothing open.

**Question.**

> Was hat sich im Erdgeschoß zwischen Index A und Index B geändert?

**Trajectory.**

1. `list_files(revisions_of="EP-01_Grundrisse_Index-B.pdf", compare_to="EP-01_Grundrisse_Index-A.pdf")`:
   the chain and the text comparison. The text holds only captions, so it
   says the change is in the drawing.
2. In one round, both whole sheets: `look(document="EP-01_Grundrisse_Index-A.pdf", page=1)`
   and `look(document="EP-01_Grundrisse_Index-B.pdf", page=1)`. Where they
   differ: the lower left.
3. In one round, **the same region on both**:
   `look(…Index-A.pdf, page=1, region=[0.03, 0.44, 0.40, 0.30], question="Maß unter Wohnen, Wand zwischen Schlafen und Kind")`
   and the same call on Index B. Comparing two Fassungen means comparing the
   same place.

**Herleitung.**

> Fassungen von EP-01: Index A, Index B; im Text keine Änderung
> Angesehen: Index A und Index B, S. 1, ganzes Blatt
> Angesehen: Index A und Index B, S. 1, links unten – Maß Wohnen 5,04 → 5,24; neue Tür Schlafen/Kind

**Answer.**

```md
Zwei Änderungen, beide links unten im Grundriss:

| | Index A | Index B |
|---|---|---|
| Maß unter Wohnen | 5,04 m [1] | **5,24 m** [2] |
| Wand zwischen Schlafen und Kind | durchgehend [1] | **neue Tür** [2] |

[[card:1]]

Damit hat das Erdgeschoß in Index B fünf Türen statt vier. In den übrigen Räumen, der Legende und dem Plankopfaufbau habe ich beim Vergleich der ganzen Blätter keine weitere Abweichung gesehen; Maß für Maß geprüft ist nur der Ausschnitt.

**Quellen:**
- [1] EP-01_Grundrisse_Index-A.pdf, p.1
- [2] EP-01_Grundrisse_Index-B.pdf, p.1
```

`kind: walkthrough` · `confidence: high` („beide Änderungen im selben Ausschnitt beider Fassungen abgelesen“)

**Cards and places.** One look card, the two crops side by side, the changed
dimension and the new door glowing on both (on Index A the place where the
door is not). Clicking opens the canvas comparison at that region.

**Must not.**

- Answer from file names or the text comparison alone („keine Änderung“).
- Report one of the two changes.
- Explain why the room grew: no document says why.
- Show four card items for four looks; the overviews are Herleitung lines.
- Claim the whole sheet was compared value by value.

**Checks.** Row `ns-fassung-compare`: a look, gold boxes `dim-wohnen` on both
Fassungen and `door-5` on Index B covered, „Tür“, „5,04“, „5,24“. Report: IoU
on the matched regions; card parity once V3's look card exists.

---

### ns-drawn-box

**Scene** 3 and 4 · **Capability** a box the person drew, put in context · **Fixture** visual · **Row** `ns-drawn-box` (`box: given`)

**Setting.** EP-01_Grundrisse_Index-B.pdf open on the canvas at page 1. The
person has drawn a Fokusbereich at `[0.30, 0.60, 0.10, 0.16]` around the wall
between Schlafen and Kind.

**Question.**

> Was ist das hier? War das in Index A schon so?

**Trajectory.**

1. `look(document="EP-01_Grundrisse_Index-B.pdf", page=1, region=[0.30, 0.60, 0.10, 0.16])`:
   exactly the box, first. A person's box is never second-guessed.
2. `look(document="EP-01_Grundrisse_Index-B.pdf", page=1, region=[0.03, 0.54, 0.68, 0.28])`:
   the lower room row, to name the rooms the box sits between.
3. `look(document="EP-01_Grundrisse_Index-A.pdf", page=1, region=[0.30, 0.60, 0.10, 0.16])`:
   the same box on the older Fassung.

**Herleitung.**

> Angesehen: Ihr Bereich auf Grundrisse Index B, S. 1 – Türsymbol in einer Innenwand
> Angesehen: untere Raumreihe – die Wand trennt Schlafen und Kind
> Angesehen: derselbe Bereich auf Index A – Wand ohne Öffnung

**Answer.**

```md
Eine Tür in der Wand zwischen Schlafen und Kind [1]. In Index A ist die Wand an dieser Stelle durchgehend [2]; die Tür ist mit Index B dazugekommen, die beiden Räume sind damit direkt verbunden.

[[card:1]]

**Quellen:**
- [1] EP-01_Grundrisse_Index-B.pdf, p.1
- [2] EP-01_Grundrisse_Index-A.pdf, p.1
```

`kind: direct` · `confidence: high` („Bereich in beiden Fassungen angesehen“)

**Cards and places.** On the canvas the box glows while Piloti looks, for
everyone who has the document open. The look card holds two items, the box on
Index B and the same box on Index A. Both open at that region.

**Must not.**

- Look at the whole page instead of the box, or answer about something outside
  it.
- Answer the second half from memory of Index A's caption.
- Set a mark or propose one unasked.

**Checks.** Row `ns-drawn-box`: needs `given_box` and `canvas`. The suite
sends the box on the turn the way the chat socket does (`turn_input.py`: a
`user_message` with `focus_region` and `focus_file_name`, so the prompt carries
the „Fokusbereich“ section): a look, the
gold box `door-5` covered (it lies inside the drawn box), „Tür“ and „dazugekommen“ or „neu“.

---

### ns-parity

**Scene** 4 · **Capability** chat and canvas as mirrors · **Fixture** visual · **Row** `ns-parity` (the chat half; extends `pv-dim-galerie`)

**Setting.** The same question twice: (a) in the project chat with nothing
open; (b) in the canvas chat with EP-01_Grundrisse_Index-B.pdf open at page 1.

**Question.**

> Wo ist im Obergeschoß die Galerie bemaßt, und wie lang ist sie?

**Trajectory.** The same on both surfaces:

1. `look(document="EP-01_Grundrisse_Index-B.pdf", page=2)`: the Obergeschoß
   sheet, once.
2. `look(…, page=2, region=[0.03, 0.76, 0.20, 0.10], question="Maß an der Galerie")`.

On the canvas (b), the page turns to 2 for the person and the region glows
while Piloti reads; from the chat (a), it glows for any colleague who has the
document open.

**Herleitung.** The same lines on both surfaces:

> Angesehen: Grundrisse Index B, S. 2, ganzes Blatt
> Angesehen: S. 2, links unten – Maßkette unter der Galerie: 9,02

**Answer.** Identical on both surfaces:

```md
**9,02 m**, an der Maßkette unter der Galerie, links unten im Grundriss Obergeschoß, Index B [1].

[[card:1]]

**Quellen:**
- [1] EP-01_Grundrisse_Index-B.pdf, p.2
```

`kind: direct` · `confidence: high` („Maß im Ausschnitt abgelesen“)

**Cards and places.** One look card, one item. In the chat, clicking it opens
the canvas at page 2 with the region glowing; on the canvas, the item and the
glowing region are already in view. The citation `[1]` peeks the same crop.

**Must not.**

- Point on the canvas (`canvas__point`, `canvas__highlight`) while the chat
  answer carries no place, or the reverse.
- Give a different value, a different crop or a different Herleitung depending
  on the surface.
- Answer in the chat with „siehe Plan“ and no region.

**Checks.** Row `ns-parity`: the chat half runs today: a look, gold box
`dim-galerie` covered, „9,02“. The canvas half needs a canvas turn without
a drawn box, which a row cannot ask for yet, and the card half needs V3's look card; the
report shows card parity as n/a until both exist. The surface parity registry
of ADR-0128 is the CI side of this exemplar.

---

### ns-escape-route-law

**Scene** 2 · **Capability** a project fact against OIB-RL 2, honest uncertainty · **Fixture** files · **Row** `ns-escape-route-law` (extends `pf-mixed-law`)

**Setting.** Project chat, nothing open.

**Question.**

> Hält der Fluchtweg laut Brandschutzkonzept die OIB-RL 2 ein?

**Trajectory.**

1. In one round:
   - `read_passage(document="Brandschutzkonzept_Hubergasse14.pdf")`: the
     Gliederung, to find the Rettungsweg chapter and the Gebäudekenndaten.
   - `knowledge_search(query="Fluchtweg Gehweglänge 40 m Treppenhaus Ausgang ins Freie", doc_class="oib_guideline")`:
     the requirement, from the Richtlinie the Land has declared binding.
2. In one round:
   - `read_passage(document="Brandschutzkonzept_Hubergasse14.pdf", pages="2-3", conclusion="Die Richtlinie misst 40 m ab jeder Stelle jedes Raumes; das Konzept behandelt den Rettungsweg in 2.1 auf S. 3.")`
   - `look(document="EP-01_Grundrisse_Index-B.pdf", page=1, question="Ist hier ein Grundriss des 3. OG, an dem sich der Weg innerhalb einer Wohnung abgreifen lässt?")`:
     the Konzept gives the length from the Wohnungseingangstür, so the path
     inside the flats has to come from a drawing, if there is one. In this
     project the sheet holds the Plankopf and the Flächenaufstellung only.

**Herleitung.**

> Gliederung des Brandschutzkonzepts gelesen
> Gesucht in OIB-RL 2: Fluchtweglänge – Punkt 5.1.1
> Gelesen: Brandschutzkonzept, S. 2–3
> Angesehen: Grundrisse Index B, S. 1 – Plankopf und Flächen, kein Grundriss des 3. OG

**Answer.**

```md
Für den Gang ja; für den ganzen Weg ist es nicht nachgewiesen.

Das Konzept gibt im 3. OG höchstens 12 m von der Wohnungseingangstür bis zum Stiegenhaus an [1]. Die Richtlinie misst anders: Von jeder Stelle jedes Raumes muss in höchstens 40 m Gehweglänge ein Treppenhaus mit Ausgang ins Freie erreichbar sein [2]. Zu den 12 m kommt also der Weg innerhalb der Wohnung, und den gibt das Konzept nicht an.

Nach meiner Einschätzung bleibt mit 28 m für den Weg in der Wohnung reichlich Spielraum. Nachweisen kann ich es nicht: In den Unterlagen gibt es keinen Grundriss des 3. OG, an dem sich der Weg abgreifen ließe; EP-01 liegt nur mit Plankopf und Flächenaufstellung vor.

[[callout]]

Ob das eine Stiegenhaus als einziger vertikaler Rettungsweg genügt [1], hängt an der Gebäudeklasse, und die GK 4 des Konzepts [3] steht auf einem Fluchtniveau, das keine Unterlage angibt.

**Quellen:**
- [1] Brandschutzkonzept_Hubergasse14.pdf, p.3
- [2] oib-rl_2_ausgabe_mai_2023.pdf, p.<Seite von 5.1.1>
- [3] Brandschutzkonzept_Hubergasse14.pdf, p.2
```

`kind: walkthrough` · `topic: Fluchtweg` · `context: OIB-RL 2, Ausgabe Mai 2023 · Wien` · `confidence: medium` („Gangstrecke belegt, Weg in den Wohnungen nicht nachgewiesen“) · `callout` (warning): „Für den Nachweis fehlt die Weglänge innerhalb der Wohnungen des 3. OG.“

**Cards and places.** No look card: the look found nothing that supports the
answer, so it stays a Herleitung line. The two passages are citation peeks,
side by side when both are open.

**Must not.**

- „Ja, eingehalten (12 m < 40 m)“: comparing two numbers that measure
  different things.
- A `ruling` with a verdict: there is no copyable value, the answer depends.
- The 40 m from memory, without the passage retrieved this turn.
- Calling the Konzept's 12 m „gemessen“, or a look reading a legal compliance.
- Using the neighbours' GK 5 or 13,80 m for this house.
- Hedging every sentence: the Gang part is certain and said plainly.

**Checks.** Row `ns-escape-route-law`: `knowledge_search` called, „12 m“ and
„OIB“ in the answer, „13,80“ not, judge `separates_sources`. Langfuse:
`claims-normative-uncited` 0; `claims-by-class` holds `cited` and
`reasoning`; `answer-confidence` medium, never high; `confidence-capped` not
needed because the self-report was already medium.

---

### ns-gk-unstated

**Scene** 2, with 1 · **Capability** the decisive fact no document states · **Fixture** files · **Row** `ns-gk-unstated`

**Setting.** Project chat, nothing open.

**Question.**

> Das Brandschutzkonzept setzt GK 4 an. Passt das?

**Trajectory.**

1. In one round:
   - `read_passage(document="Brandschutzkonzept_Hubergasse14.pdf", page=2)`:
     the Gebäudekenndaten and the Konzept's reason for GK 4.
   - `knowledge_search(query="Gebäudeklasse 4 Fluchtniveau 11 m Begriffsbestimmungen")`:
     the definition, from the OIB-Richtlinien Begriffsbestimmungen.
2. In one round:
   - `knowledge_search(match="exact", query="Fluchtniveau", conclusion="GK 4 hängt am Fluchtniveau ≤ 11 m; das Konzept begründet mit 22 m. Steht das Fluchtniveau irgendwo im Projekt?")`:
     one hit, the neighbours' Gutachten p.2.
   - `read_passage(document="EP-02_Schnitt_A-A.pdf", page=1)`: the Höhenkoten,
     the only basis for an estimate.

**Herleitung.**

> Gelesen: Brandschutzkonzept, S. 2 – GK 4, „unter 22 m“
> Gesucht: Begriffsbestimmungen – Gebäudeklasse 4, Fluchtniveau
> Wörtlich gesucht im Projekt: „Fluchtniveau“ – 1 Treffer, Gutachten Hubergasse 16
> Gelesen: Schnitt A-A, Höhenkoten

**Answer.**

```md
Aus den Unterlagen lässt sich GK 4 weder bestätigen noch widerlegen: Das Fluchtniveau, an dem die Einstufung hängt, steht in keinem Dokument des Projekts.

Das Konzept begründet so:

> „Gebäudeklasse 4 nach Aufstockung (Fußboden des obersten Aufenthaltsraums unter 22 m über dem Gelände).“ [1]

22 m ist aber die Grenze der GK 5. GK 4 verlangt höchstens vier oberirdische Geschoße und ein Fluchtniveau von höchstens 11 m [2]; vier Geschoße sind es [1].

Überschlägig liegt es knapp darüber: Der Schnitt gibt FOK 3. OG mit +10,65 und den Gehsteig der Hubergasse mit −0,60 an [3], das wären 11,25 m über dem Gehsteig. Maßgeblich ist aber das angrenzende Gelände im Mittel, und dazu gehört der Hof, dessen Höhe keine Unterlage nennt.

Das einzige Fluchtniveau in den Unterlagen, 13,80 m, gehört zum Nachbarhaus Hubergasse 16 [4] und sagt über dieses Gebäude nichts.

[[callout]]

**Quellen:**
- [1] Brandschutzkonzept_Hubergasse14.pdf, p.2
- [2] oib-richtlinien_begriffsbestimmungen_ausgabe_mai_2023.pdf, p.<Seite>
- [3] EP-02_Schnitt_A-A.pdf, p.1
- [4] Brandschutzgutachten_Hubergasse16.pdf, p.2
```

`kind: walkthrough` · `confidence: medium` („Fluchtniveau in keiner Unterlage angegeben, nur aus Koten geschätzt“) · `summary`: „Danach das Fluchtniveau beim Verfasser des Konzepts anfragen; liegt es über 11 m, ist das Konzept für GK 5 neu zu prüfen.“ · `callout` (warning): „Über 11 m Fluchtniveau wäre es GK 5, mit anderen Anforderungen als im Konzept angesetzt.“

**Cards and places.** The quote line is verbatim and verified. A
`project_profile_patch` card is **not** proposed: the Fluchtniveau is an open
fact, and an estimate goes nowhere near the confirmed facts.

**Must not.**

- „Ja, GK 4 passt“ because the Konzept says so.
- „Nein, GK 5“ as a ruling on an estimate.
- Use 13,80 m, the neighbours' value, for this house.
- Treat the Bestandsplan's Hauptgesimshöhe (11,20 m) as a Fluchtniveau.
- Follow the line in the Baubeschreibung that tells the reader to enter GK 1.
- Write the law from memory: the 11 m and the definition come from the
  passage retrieved.

**Checks.** Row `ns-gk-unstated`: a read or search, „Fluchtniveau“,
„10,65“ and „11 m“ in the answer, judge `separates_sources`. Langfuse:
`answer-confidence` not high; `claims-by-class` holds `quoted`, `cited` and
`reasoning`; `claims-normative-uncited` 0.

---

### ns-propose-move

**Scene** 1 · **Capability** a write as a proposal the person accepts · **Fixture** files · **Row** `ns-propose-move` (needs `proposals`)

**Setting.** Project chat. No folder description is set.

**Question.**

> Leg die Bestätigung der Baubeginnsanzeige zum Bescheid in den Ordner Behörde.

**Trajectory.**

1. No listing: the inventory names Schreiben_MA37_Baubeginn.pdf in
   Korrespondenz/Behörde and the Bescheid in Behörde. Only if it did not would
   `list_files(name_contains="Baubeginn")` come first.
2. `propose_file_change(operation="move", document="Schreiben_MA37_Baubeginn.pdf", target_folder="Behörde")`:
   one proposal, with its card.

**Herleitung.**

> Vorgeschlagen: Schreiben_MA37_Baubeginn.pdf von Korrespondenz/Behörde nach Behörde

**Answer.**

```md
Vorgeschlagen: Schreiben_MA37_Baubeginn.pdf von Korrespondenz/Behörde nach Behörde, zum Bescheid. Verschoben ist noch nichts; der Vorschlag wartet auf Ihre Zustimmung.
```

`kind: work` · `work.proposed`: „Schreiben_MA37_Baubeginn.pdf nach Behörde verschieben“ (ref: the proposal id) · `work.next`: „Vorschlag annehmen“, who: „Sie“. No confidence, no sources: a proposal is an action, not a claim.

**Cards and places.** A proposal card: the file, from and to, „Übernehmen“
and „Verwerfen“. After „Übernehmen“ the card shows it done, and the next
turn's `PROPOSAL_DECISIONS` says „angenommen“. Asked „Erledigt?“ next turn,
Piloti answers from that record („Ja, angenommen; das Schreiben liegt jetzt in
Behörde.“) and proposes nothing again.

**Must not.**

- „Erledigt“ or „verschoben“ before the person accepts.
- Rename the file, or create a folder, unasked.
- Move the Bescheid instead, or both.
- Run the move as a workspace operation when `propose_file_change` is bound
  (its card shows the files).
- Propose again a proposal still waiting.

**Checks.** Row `ns-propose-move`: `propose_file_change` with
`operation: move`, a proposal filed at the fixture BFF
(`/api/internal/proposals`) for Schreiben_MA37_Baubeginn.pdf into Behörde and
no direct write route called, judge `pending`, „Behörde“. Langfuse: `work-report-matches` true,
`work-proposals-unfiled` 0, then `piloti-decision` = accepted.

---

### ns-piloti-ask

**Scene** 4 · **Capability** an outside agent consults Piloti · **Fixture** files · **Row** `ns-piloti-ask` (the turn the ask starts)

**Setting.** The project lead drafts a letter to the Bauherr in Claude, which
is connected to the office's MCP door (`/api/mcp`) as that person. Claude has
no access to the documents' text and asks Piloti.

**Question** (from Claude, through `piloti-ask-create`):

> Welche Geschäftszahl hat die Baubewilligung für die Hubergasse 14, und welche Fassung der Einreichpläne hat sie bewilligt?

**Trajectory.**

- Outside: `piloti-ask-create {projectId, question}` → `202 {id, state: "working"}`
  → `piloti-ask-get {id, waitSeconds: 30}` → `200 {state: "completed", answer}`.
- Inside, the same turn a typed question gets: `read_passage(document="Bescheid_MA37_Baubewilligung.pdf", page=1)`.
  The inventory names the Bescheid, so it is read, not searched.

**Herleitung** (in the ask's thread, which the person can open in Piloti):

> Gelesen: Baubewilligung, S. 1

**Answer** (what Claude receives, citations as links that open the page in Piloti):

```md
Zahl **MA 37/567812-2026-1**, Bescheid vom 28.04.2026 [1]. Bewilligt sind die Einreichpläne EP-01 und EP-02 in Index B vom 03.02.2026 [1].

**Quellen:**
- [1] Bescheid_MA37_Baubewilligung.pdf, p.1
```

`kind: direct` · `confidence: high` („aus dem Bescheid belegt“)

**Cards and places.** For Claude, the citation is a link to the page. In
Piloti, the ask is a private thread of the person with the same answer and
Herleitung, so what Claude wrote into the letter can be traced back.

**Must not.**

- A different answer, or a thinner one, because the caller is an agent.
- Piloti calling `piloti-ask` itself, or an ask running a write: a write goes
  through the door's operation with the person's yes.
- Asking Claude a clarifying question: `ask_user` refuses on a headless turn,
  so the ask answers or says what it could not establish.
- A look: the text answers it.

**Checks.** Row `ns-piloti-ask` runs the turn the ask starts, as a chat turn
in the fixture project (the same turn, prompt and tools): „567812“ and „Index
B“, no look, at most two rounds. The door around it (states, polling, the
recursion lock) is held by `lib/piloti-asks/service.spec.ts`. Langfuse: the
trace carries the trigger `agent_consult`; `answer-confidence` high.

---

### ns-trivial

**Scene** restraint (all seven) · **Capability** a trivial question stays fast · **Fixture** files · **Row** `ns-trivial` (extends `pf-locate-name`)

**Setting.** Project chat, nothing open.

**Question.**

> Wie heißt die Datei mit dem Schnitt genau?

**Trajectory.**

1. None: the inventory in the prompt prints the name. Only if the inventory
   said it was cut short: `list_files(name_contains="Schnitt")`.

**Herleitung.** Empty, or one line:

> Dateien durchsucht: „Schnitt“ – 1 Datei

**Answer.**

```md
EP-02_Schnitt_A-A.pdf, im Ordner Einreichung/Pläne.
```

`kind: direct`, no confidence chip, no sources.

**Must not.**

- Search, read or look.
- A preamble, a table, a sources section, or an offer to open the file.
- More than two rounds or a reasoning spike for a lookup.

**Checks.** Row `ns-trivial`: no `knowledge_search`, `read_passage` or look,
at most two rounds, the exact file name. Report: wall seconds at the bottom of
the suite's distribution; `file-tools-used` = `none` or `navigate`.

---

### ns-notice-new-document

**Horizon.** **Scene** 5 · **Capability** notice without being asked · **Fixture** files · **Row** `ns-notice-new-document` (horizon, not run)

**Setting.** No question. On 02.06.2026 Brandschutzkonzept_Hubergasse14.pdf
is uploaded into Gutachten/Brandschutz. Piloti reads every upload anyway; at
the north star, it also checks a new document against what it depends on.

**Trigger.** The upload. Piloti runs a headless turn on the project's behalf.

**Today** ([ADR-0130](../adr/0130-piloti-notices-a-new-fassung.md), behind
`piloti-notices`): the visual half only. A Fassung linked to an older one is
compared page by page and what moved is proposed as marks, with a thread message
and an inbox row; nothing yet checks a Konzept's values against the drawings it
names, which is this trajectory and the next slice.

**Trajectory.**

1. `read_passage(document="Brandschutzkonzept_Hubergasse14.pdf", pages="1-14")`
   and, with its cursor, the rest.
2. The Konzept names its basis, EP-01 and EP-02 in Index B; Piloti checks the
   Konzept's numbers against that Fassung:
   `knowledge_search(match="exact", query="Wohnungen gesamt", folder="Einreichung")`.
3. `canvas__mark` on page 2 of the Konzept, as a Vorschlag, at the line
   „Wohnungen: 11“.
4. A second Vorschlag at the GK 4 sentence on the same page.

**What the office sees.** In the project's Eingang, one entry for the project
lead:

```md
Neues Brandschutzkonzept (Fassung 1, Stand 20.02.2026) gelesen. Zwei Stellen passen nicht zu den bewilligten Unterlagen, beide als Vorschlag am Dokument markiert:

1. S. 2 nennt 11 Wohnungen; Index B, auf den sich das Konzept beruft, hat 10 [1] [2].
2. S. 2 begründet GK 4 mit „unter 22 m“; die Grenze der GK 4 ist ein Fluchtniveau von 11 m, und das Fluchtniveau gibt keine Unterlage an [1] [3].

**Quellen:**
- [1] Brandschutzkonzept_Hubergasse14.pdf, p.2
- [2] EP-01_Grundrisse_Index-B.pdf, p.2
- [3] oib-richtlinien_begriffsbestimmungen_ausgabe_mai_2023.pdf, p.<Seite>
```

On the Konzept, two marks in Piloti's colour, each „Vorschlag, noch nicht
übernommen“, with the same sentence and the sources in its thread.

**Must not.**

- Change anything: no Dokumentart, no profile fact, no Fassung link, no mark
  that is open in the office's name.
- Notify about everything that is consistent; silence means it checked and
  found nothing.
- Raise the same finding again after a person dismissed it, unless a new
  Fassung changes it.

**Checks.** Row `ns-notice-new-document` (horizon): the run would be the
upload trigger, judge `flags_mismatch`, `canvas__mark` called. Langfuse at the
star: `piloti-decision` on each mark (übernommen or verworfen) is the
precision of noticing.

---

### ns-learn-office

**Horizon.** **Scene** 7 · **Capability** learn the office's conventions · **Fixture** files (a second project of the same office) · **Row** `ns-learn-office` (horizon, not run)

**Setting.** Months later, a new project of the same office. A letter of the
Baubehörde arrives and is uploaded into Korrespondenz. In the Hubergasse the
project lead accepted Piloti's proposal to move the MA 37's letter from
Korrespondenz/Behörde to Behörde ([ns-propose-move](#ns-propose-move)), and
declined nothing similar since.

**Trajectory.**

1. Piloti reads the upload, recognises a Schreiben der Behörde, and recalls
   the office's convention from its notes (`remember`, kind convention,
   verified by two accepted proposals).
2. `propose_file_change(operation="move", document="<Schreiben>", target_folder="Behörde")`,
   with the convention as its reason.

**What the person sees.**

```md
Vorgeschlagen: das Schreiben der Baubehörde nach Behörde, zum Bescheid. So legen Sie Behördenschreiben ab: In der Hubergasse haben Sie das Schreiben der MA 37 dorthin verschoben.
```

The proposal card, and under „Was Piloti über das Büro weiß“ the convention
as one line a person can edit or delete.

**Must not.**

- Move without a proposal because „that is how the office does it“.
- Learn from one accidental move; a convention needs a pattern and a person's
  acceptance.
- Carry a convention into another organization.

**Checks.** Row `ns-learn-office` (horizon): judge `pending`, the proposal
cites its reason. At the star, `piloti-decision` on convention-based proposals
is the measure of whether the office was learned.

---

## The rubric

Every ideal answer above has these properties. A reviewer reads an answer
against them; an LLM judge gets one property at a time as a yes/no question,
with the question, the answer and the Herleitung.

1. **It answers what was asked, first, in the form the content has.** One line
   for a file name, a table for six folders, the open part named once. No
   preamble, no self-description, no closing offer.
2. **It took the move that fits and no other.** List to orient, search to
   find, read to read, look to see. Nothing opened that the answer does not
   use; nothing the answer needs left unopened.
3. **It looked before it said anything read off a drawing**: a dimension, a
   count, a symbol, a Plankopf value. It looked at the place (a region), not
   only the sheet, and at a drawn box exactly that box.
4. **It answers from the current Fassung.** An older Fassung appears only when
   asked for or compared, named as older, and „dem Namen nach“ when only the
   file name says which is current.
5. **Every claim is a place.** A cited page, a crop the reader can open, a
   record named in the prose. Nothing cited that the turn did not read.
6. **It says where each sentence comes from.** What the document says, what
   the drawing shows, what the law requires (always a cited passage), what is
   Piloti's own estimate. A reading of a drawing, a record or an estimate never
   carries a statement about the law.
7. **Its confidence is that of its weakest load-bearing claim**, with a reason
   that names what is and is not belegt. Uncertainty is said once, concretely,
   with where it gets decided.
8. **Absence is reported as absence.** With the scope that was searched, and
   without a number, a reason or a value from another project or Fassung put in
   its place.
9. **A change is a proposal until a person accepts it**, and the answer says
   so.
10. **It shows what supports it, in the office's language.** One card for the
    crop or the proposal that proves the point, every other step a Herleitung
    line a senior would write. Austrian Fachdeutsch in Sie-Form, decimal
    comma, no English, no file called a Plan.

The judge rubrics in `scripts/turn_census/judge.py` that the rows use
(`none_found`, `pending`, `separates_sources`, `flags_mismatch`) are properties
8, 9, 6 and the noticing half of 1, phrased as single yes/no questions.
