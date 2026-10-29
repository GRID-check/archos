# Header

Kopfzeile jeder Inhaltsseite über die volle Breite: Logo links, Menü mittig, rechts Login und der schwarze Button „Demo anfragen“. Läuft beim Scrollen mit, leicht transparent und unscharf.

**Props:** `links` – `[{ label, href }]`: Plattform · Datensicherheit · Blog; `current` – aktive Seite (unterstrichen); `login` – `{ label, href }` (kleiner Sekundär-Button, führt zur Login-Seite); `cta` – `{ label, href }` (kleiner Primär-Button, führt zur Demo-Seite); `sticky` (Standard `true`); `menuExtra` – weitere Punkte nur im mobilen Menü (Kontakt).

- Breite: `ui-wide`, also volle Breite mit `gutter-wide` (64px) Rand. Höhe `header-height`.
- Hintergrund `surface-glass` mit `glass-blur`; keine Linie, kein Schatten – auch nicht beim Scrollen (Designsystem: „Keine Trennlinien … auch nicht unter dem Header“).
- Menüpunkte im Stil `nav` (14px, Stärke 420), Buttons `sm` (13px, 420). Unterstreichung nur bei Hover und auf der aktiven Seite.
- Login- und Demo-Seite haben keinen Header, nur das Logo oben links (`SplitPage`).
- **Smartphone (unter 768px):** Menüpunkte und Login wandern in ein Menü. Im Header bleiben Logo, „Demo anfragen“ (Primär) und der Sekundär-Button „Menü“ (offen: „Schließen“). Das Menü füllt den Bildschirm unter dem Header: Punkte groß (26/32), dazu Kontakt (`menuExtra`); unten Login (Sekundär) und Demo anfragen (Primär) über die volle Breite, je 46px hoch. Ohne Icon, ohne Animation.
