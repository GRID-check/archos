# AITag

Zurückhaltendes Kennzeichen „AI“ auf KI-generierten Bildern: Umriss ohne Füllung, unten rechts.

**Props:** `ink` – Schrift und Rahmen in `ink` statt `on-ink` (für helle Bildbereiche).

**Ohne React:** `<div class="ui-media"><img …><span class="ui-ai-tag" title="KI-generiertes Bild">AI</span></div>`

- Stil `ai-tag` (11/14, +0.04em), Rahmen `stroke-hairline` in der Textfarbe, `radius-md`, 16px vom rechten und 12px vom unteren Rand.
- Pflicht auf jedem KI-generierten Bild (Gegenüberstellung, Login-Foto); nie auf Fotos, Produkt-Ausschnitten oder eigenen Animationen. Das Impressum nennt die Kennzeichnung.
- Geprüft: `scripts/check_brand_rules.mjs` sucht in den gebauten Seiten jedes Bild aus `AI_GENERATED_MEDIA` und verlangt ein `ui-ai-tag` im selben Rahmen.
- Farbe nach Untergrund: auf dunklen und mittleren Bildern `on-ink`, auf hellen `ink`.
