# Video

Erklär-Animation mit Standbild, Play-Button in der Mitte und einer feinen Fortschrittslinie unten; startet erst auf Klick.

**Props:** `sources` – `[{ src, type }]` (WebM VP9 zuerst, dann MP4 H.264); `poster` – Standbild; `label` – Beschreibung für Screenreader; `ratio` (Standard 2:1); `loop`.

- Grund `surface-sunken`; der Hintergrund der Animation ist exakt #f2f1f0, damit Video und Fläche ineinander übergehen (Farbraum bt709 kennzeichnen).
- Das Standbild zeigt einen Moment ohne Text in der Mitte – dort sitzt der Play-Button (56px, `ink`, `radius-md`, Dreieck in `on-ink`).
- Klick aufs Video pausiert und setzt fort; die Linie unten (2px, beim Überfahren 4px) zeigt den Fortschritt in `ink` auf `line` und springt per Klick an die Stelle.
- Ohne Ton (`muted`), `playsinline`, Animation in 2:1, mindestens doppelte Breite (2432px).
