# SplitPage

Seite ohne Header für Login und Demo-Anfrage: links Logo, Inhalt und eine kurze Fußzeile, rechts ein Foto – bei der Demo-Anfrage mit einer weißen Formular-Karte darauf.

**Props:** `variant` – `"login"` (5:7, Foto rechts randlos, Formular 400px) oder `"form"` (1:1, Karte 640px auf Foto); `children` – Inhalt links; `image`, `imageAlt`, `imageStyle`; `aside` – Inhalt der Karte (form) bzw. Ersatz fürs Foto (login); `asideNote` – Hinweis unter der Karte; `ai` – Kennzeichen am Foto; `footer` – Links (der erste steht links: „Zur Website“), `note` („© 2026 ARCHOS“).

- **Login:** Titel „Anmelden.“ in `heading-1`, darunter `body`/`ink-muted` „Willkommen zurück bei ARCHOS.“; zwei Sekundär-Buttons `lg` volle Breite (Microsoft, Google), Trenner „oder“ (Klasse `ui-split-or`), E-Mail-Feld, Primär-Button „Weiter“, Hinweis „Sie erhalten einen Anmeldelink per E-Mail.“, unten „Noch kein Zugang? Demo anfragen“. Fußzeile: Zur Website · Impressum · Datenschutz · ©.
- **Demo:** Titel in `display` (64/70), höchstens 592px breit, bricht auf drei Zeilen; `lead` in ink; die Logos der Pilotbüros (`LogoRow`, 40px) in `ui-split-logos` mit `space-18` Abstand (auf dem Smartphone unter der Formular-Karte). Rechts: Karte mit `ui-form-grid` (Vorname, Nachname, E-Mail, Büro, Funktion, Bürogröße, Land, Häkchen, Primär-Button voller Breite), darunter der Datenschutz-Hinweis hell auf dem Foto (`asideNote`, mit `data-theme="dark"`: Text und Link in `ink` des dunklen Themas, ohne Fläche). Abweichend von der Übergabe nicht in `ink-muted`: das erreichte über den hellsten Stellen des Fotos nur 3,05:1 (gemessen bei 1280px), unter den 4,5:1 von WCAG 1.4.3; `ink` erreicht 7:1. Fußzeile: Zur Website · Datensicherheit · Impressum · Datenschutz · ©.
- Fotos: ruhige, warme, unscharfe Räume (Demo) oder ein leerer Arbeitsraum im Abendlicht (Login). KI-generiert ⇒ `ai`.
- Unter 1024px untereinander; beim Login entfällt das Foto.
