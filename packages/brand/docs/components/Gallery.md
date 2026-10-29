# Gallery

Große Karten zum Durchblättern, wie die Highlights auf Produktseiten: die nächste Karte schaut rechts herein, mittig darunter Pfeile und Anzeige.

**Props:** `items` – `[{ title, text, media }]`: `title` ist die Aussage in ink („Eine Frage. Das ganze Projekt als Kontext.“), `text` führt sie in `ink-muted` fort („Belegt aus Fachwissen, Projekt und Büro.“), `media` füllt die Karte (Produkt-Ausschnitt, unten links verankert); `label` – Name des Karussells für Screenreader.

- Karten 5:2, so breit wie der Inhalt (1216px), Abstand `space-4`, eckig, Grund `surface-sunken`.
- Satz oben links in `heading-2`, höchstens zwei Zeilen; drei Karten (Suchen, Vergleichen, Prüfen).
- Produkt-Ausschnitte in doppelter Auflösung (4960 × 1984), sRGB, verlustfrei; ihr Hintergrund ist exakt `surface-sunken` (#f2f1f0), damit Bild und Karte ineinander übergehen.
- Steuerung: zwei Pfeil-Buttons und ein Feld mit Anzeigen, alle 44px hoch, 4px Rundung, Grund `surface-sunken`. Aktive Anzeige als 28px-Strich in `ink`, die anderen als 6px-Quadrat in `ink-muted`.
- Unter 1024px: Karte ohne festes Format (mind. 560px, Smartphone 480px), Satz oben über die ganze Breite, der Produkt-Ausschnitt unten links verankert und 500px bzw. 440px hoch – so bleibt die Oberfläche lesbar. Karten auf dem Smartphone so breit wie der Bildschirm minus 48px, die nächste schaut herein.
- Wischen auf Touch-Geräten; Übergang 400ms `ease-out`, aus bei `prefers-reduced-motion`.
