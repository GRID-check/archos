# Input

Eingabefeld mit Label darüber, einzeilig oder mehrzeilig, für Login, Demo- und Kontaktformular.

**Props:** `label` (Pflicht, immer sichtbar; Pflichtfelder mit „ *“), `hint`, `error` (ersetzt den Hinweis, beginnt mit „Fehler:“, setzt `aria-invalid`), `multiline` (Textfeld, mindestens 144px hoch); übrige Props gehen an `<input>` bzw. `<textarea>`.

**Ohne React:** `<div class="ui-field"><label class="ui-field-label small" for="mail">E-Mail *</label><input class="ui-input" id="mail" type="email" placeholder="name@buero.at"></div>`

- Eckig, Rand `line-strong`, im Fokus `ink` mit `focus-ring`. Fehler schwarz-weiß: Rand `stroke-strong` plus Text.
- Platzhalter zeigen ein Beispiel („name@buero.at“, „Name des Planungsbüros“, „z. B. Projektleitung“). Kein Telefonfeld.
- Zwei Spalten im Formular: Klasse `ui-form-grid`, volle Breite `ui-form-full`. Felder untereinander mit 28px, Spalten mit `space-8`.
- Unter jedem Formular in `small`/`ink-muted`: wofür die Angaben genutzt werden, mit Link zur Datenschutzerklärung.
