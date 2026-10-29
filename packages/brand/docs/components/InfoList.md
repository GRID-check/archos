# InfoList

Zeilen aus Begriff und Wert, für Rechtstexte und Kontaktdaten: Abschnittstitel links, Zeilen rechts.

**Props:** `items` – `[{ key, value }]`; `title` (Standard-Layout: `heading-2` links über vier Spalten, Liste rechts über sieben).

**Ohne React:** `<ul class="ui-info body"><li><p class="ui-info-k">Firma</p><p class="ui-info-v">ARCHOS FlexCo in Gründung</p></li></ul>`

- Begriff `ink`, Wert `ink-muted`, Verhältnis 2:3, feine Linien `line` zwischen den Zeilen, 20px Innenabstand.
- Links im Wert bleiben `ink` und unterstrichen (`ui-link`).
- Impressum: Unternehmen · Kontakt · Geschäftsführung · Offenlegung · Hinweise. Datenschutz: Verantwortlich · Website · Software ARCHOS · Empfänger · Ihre Rechte. Kontakt: E-Mail · Adresse · LinkedIn (ohne Titel, links neben dem Formular).
- Titel mit Punkt („Unternehmen.“), Abschnitte mit `space-16` Abstand. Keine Telefonnummer.
