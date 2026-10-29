# DuoCards

Zwei Karten, die die zwei Seiten einer Aussage zeigen: links hell und warm (Menschen), rechts dunkel und kühl (Maschine). Gleich breit; beim Überfahren wird eine Karte breiter und die andere tritt zurück.

**Props:** `items` – genau zwei `{ title, text, theme }` plus entweder `media` (füllt den unteren Teil) oder `photo` (Foto über die ganze Karte, `photoStyle` für Ausschnitt und Bearbeitung, `onPhoto` für Text in `on-ink`, `ai` für das Kennzeichen). Standard: erste hell, zweite dunkel.

- Steht unter einem mittigen `display`-Statement in einem Band-Abschnitt (`ui-band`).
- Titel `heading-1`, Text `body`, Innenabstand `space-12`, eckig.
- Auf der Website mit Fotos: links Planer:innen an einer Wand mit Skizzen (warm, leicht grünlich an der Wand, Text weiß), rechts ein Arbeitsplatz am Laptop (schwarz-weiß, kühl, dunkel). Das Foto behält beim Aufziehen seine Breite und wird nur weiter aufgedeckt, nicht gezoomt.
- KI-generierte Fotos tragen unten rechts das Kennzeichen `AITag`.
- Hover (nur mit Maus, ab 1024px): Breiten 7:5 statt 1:1, die andere Karte unter einem Schleier in der Abschnittsfarbe (45 %). Keine Unschärfe.
