# Button

Schwarz-weiße Schaltfläche für Handlungen: der schwarze Primär-Button trägt die Haupthandlung eines Bereichs, der Sekundär-Button mit Rahmen alles Weitere.

**Props:** `variant` – `"secondary"` (Standard; Rahmen `ink`), `"primary"` (Fläche `ink`, Text `on-ink`), `"text"` (unterstrichen, ohne Rahmen); `size` – `"sm"` (30px, 13px in Stärke 420, nur im Header), `"md"` (40px), `"lg"` (46px, Formulare und CTA); `arrow` hängt → an; `href` rendert einen Link. Volle Breite: Klasse `ui-btn-block`.

**Ohne React:** `<a class="ui-btn ui-btn-primary ui-btn-sm" href="/demo">Demo anfragen</a>`

- Beschriftung: Verb zuerst, kurz, ohne Ausrufezeichen („Demo anfragen“, „Login“, „Weiter“, „Nachricht senden“).
- Primär (schwarz), höchstens einer pro Bereich: „Demo anfragen“ im Header (`sm`), das Absenden eines Formulars (Demo, Login „Weiter“, Kontakt), die erste Handlung im CTA-Feld.
- Sekundär: Login im Header, Anmeldung mit Microsoft oder Google, „Demo anfragen“ im Demo-Abschnitt der Startseite, „Weitere Beiträge“, zweite Handlung im CTA-Feld.
- Formular-Buttons auf Split-Seiten laufen über die volle Breite (`ui-btn-block`).
- 4px Rundung (`radius-sm`) – wie alle Bedienelemente. Keine Pillen, keine Icons außer →.
