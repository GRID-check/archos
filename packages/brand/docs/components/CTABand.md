# CTABand

Abschlussfeld einer Unterseite: Frage und kurzer Satz links, Handlungen rechts, auf `surface-sunken`.

**Props:** `title` (`heading-1`), `text` (`lead` in ink), `primary`, `secondary` – je `{ label, href }`.

- Innenabstand `space-16`, eckig, im Container; danach `space-40` bis zum Footer.
- Primär „Demo anfragen“, Sekundär „Kontakt“. Höchstens einmal pro Seite, nur am Ende.
- **Smartphone (unter 768px):** Innenabstand `space-8`/`space-6`; die beiden Buttons teilen sich die Breite (je mindestens 140px) und stehen nebeneinander, solange beide in eine Zeile passen (ab etwa 400px Bildschirmbreite); auf 390px und 360px steht der zweite unter dem ersten, beide über die volle Breite. Genau so verhält sich die Referenz (`datensicherheit.html`); die README-Zeile „im CTA-Feld beide Buttons nebeneinander“ gilt also nur, wo Platz ist.
- Beispiel Datensicherheit: „Noch Fragen zur Datensicherheit?“ – „Wir gehen sie gern mit Ihnen durch, auch mit Ihrer IT.“
