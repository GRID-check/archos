# FeatureTiles

Zwei bis sechs gleichwertige Punkte im Raster, nur über Weißraum gegliedert – ohne Trennlinien, Karten oder Icons.

**Props:** `items` – `[{ title, text, href? }]`; `columns` (Standard: Anzahl, höchstens 4).

- Optional `href` (Website): Der Titel wird zum Textlink mit „→“ (`ui-link`, kein Icon, kein neues Token) und führt zur Seite, die den Punkt erklärt – etwa von „Baurecht durchsuchen“ zur Baurecht-Seite.

- Titel `heading-3`, Text `body` in `ink-muted`, Abstand `space-3`. Keine Labels, Nummern oder Icons.
- Startseite: drei Punkte unter dem Teamfoto 3:1 („Gebaut für Architektur- & Planungsbüros.“), Text höchstens 356px breit.
- Datensicherheit: sechs Punkte in drei Spalten, Reihen mit `space-16` Abstand, Text höchstens 380px. Titel als kurze Aussage („Kein Training mit Ihren Daten“, „Hosting in Wien“).
