# TextLink

Link im Fließtext: Farbe `link` (= `ink`), erkennbar an der Unterstreichung.

**Props:** `href`, `children`; `arrow` hängt → an. Übrige Props gehen an `<a>`.

**Ohne React:** `<a class="ui-link" href="…">Linktext</a>`

- Unterstreichung `stroke-hairline`, im Hover `stroke-strong`. Nie farbig.
- Linktext beschreibt das Ziel, nicht „hier klicken“. Quellen stehen in `small` darunter.
