# Select

Auswahlfeld mit Label, im selben Look wie `Input`: eckig, Rand `line-strong`, schmaler Winkel rechts.

**Props:** `label`, `options` (Texte), `placeholder` (erste, leere Option; Standard „Auswählen …“); übrige Props gehen an `<select>`.

**Ohne React:** `<div class="ui-field"><label class="ui-field-label small" for="land">Land *</label><div class="ui-select"><select class="ui-input" id="land">…</select></div></div>`

- Für kurze, feste Listen: Bürogröße (1–5, 6–20, 21–50, 51–200, Über 200 Mitarbeitende), Land (Österreich, Deutschland, Schweiz, Anderes Land).
- Der Winkel ist ein Rahmen-Strich in `ink`, kein Icon.
