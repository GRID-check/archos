# Hero

Einstieg jeder Inhaltsseite: die Zeile links über acht Spalten in `display-xl`, rechts unten bündig ein tragender Satz in `lead` (ink, rechtsbündig); auf der Startseite darunter ein breites Bild.

**Props:** `title`; `text` (ein bis zwei Sätze, `lead` in `ink`, rechtsbündig); `media` – ein `<img>`, im `hero-ratio` (etwa 7:4) über die volle Breite mit `gutter-wide` (nur Startseite); `as` (Standard `h1`).

- Gleich auf allen Seiten: Startseite, Datensicherheit, Blog, Kontakt, Impressum, Datenschutz. Titel mit Punkt („Kontakt.“, „Ihre Daten bleiben Ihre.“).
- Abstand oben `space-24`. Mit Bild `space-12` zum Bild; ohne Bild (Unterseiten) `space-24` bis zum Inhalt.
- Text im Container (1280px), Bild breit wie der Header – beide Kanten schließen mit dem Logo ab. Keine Buttons im Hero.
- Das Bild hat das Format des Heros (`--hero-ratio`); ein `<img>` mit `height`-Attribut bekommt `height: auto`, sonst schlägt die Attributhöhe das Format und `object-fit: cover` schneidet Wörter ab.
- Unter 1024px stehen Titel und Text untereinander, der Text dann linksbündig. Unter 768px: Titel 40/44 (diese Komponentenregel geht der allgemeinen Stufe `display-xl` 44/46 vor, wie in der Referenz); unter 385px wächst er mit der Breite mit (`min(40px, 10.4vw)`), damit „Architekturbüros.“ auf 360px passt; Abstand oben `space-12`, unten 56px; das Bild behält sein Format.
- Hero-Bild der Startseite: Produkt-Ausschnitt auf einem ruhigen, unscharfen Raum (warme Töne).
