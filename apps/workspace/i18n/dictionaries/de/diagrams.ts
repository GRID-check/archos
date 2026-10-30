import type { en } from '../en'

/**
 * `diagrams` — siehe die englische Quelle für die Begründung.
 *
 * „Schematisch" statt „Skizze": eine Skizze ist eine Zeichnung, die noch nicht
 * fertig ist; schematisch heißt, dass die Darstellung bewusst keine Maße
 * behauptet. Das ist hier der ganze Punkt und der Unterschied zu den fünfzehn
 * Schemakarten, deren Geometrie gerechnet wird.
 */
export const diagrams: typeof en.diagrams = {
  schematicOnly: 'Schematisch — ohne Maßangabe.',
  /** The file name a diagram gets when neither the source nor the surface names it. */
  defaultTitle: 'Diagramm',
  fallback: 'Dieses Diagramm konnte nicht gezeichnet werden. Der Quelltext steht darüber.',
  kind: {
    flow: 'Ablaufdiagramm',
    map: 'Gliederung',
    handoff: 'Übergaben',
    schedule: 'Zeitplan',
    shares: 'Anteile',
  },
  scrollable: '{name}, seitlich scrollbar',
  file: {
    action: 'Im Projekt ablegen',
    pending: 'Wird abgelegt …',
    done: 'Im Projekt abgelegt',
    open: 'Im Projekt öffnen',
    failed: 'Konnte nicht abgelegt werden',
    partial: 'Das Bild wurde abgelegt, das PDF nicht.',
    completePdf: 'PDF ergänzen',
  },
  marking:
    'Von {productName} erstellt — KI-generiert, nicht geprüft. Schematisch: ohne Maßangabe. Kein Nachweis; prüfen Sie jede Angabe, bevor Sie das Dokument weitergeben.',
  // Hier ist „Skizze" das richtige Wort: eine Person hat die Zeichnung von Hand
  // weitergeführt, und von Hand kann sie alles gezeichnet haben, auch einen
  // Umriss des Grundstücks. Deshalb zusätzlich „nicht maßstäblich".
  markingEdited:
    'Von {productName} entworfen, von einer Person bearbeitet — KI-unterstützt, nicht geprüft. Skizze: nicht maßstäblich, ohne Maßangabe. Kein Nachweis; prüfen Sie jede Angabe, bevor Sie das Dokument weitergeben.',
  markingSketch:
    'Von {productName} erstellt — KI-generiert, nicht geprüft. Skizze: nicht maßstäblich, ohne Maßangabe. Kein Nachweis; prüfen Sie jede Angabe, bevor Sie das Dokument weitergeben.',
  sketch: {
    action: 'Als Skizze bearbeiten',
    // Auf eine Auswahl von Elementen: eine Anmerkung, die an ihnen hängt und mit ihnen wandert.
    annotate: 'Anmerkung',
    // Ein Element zeigt auf etwas im Arbeitsbereich: eine Dokumentseite, ein Modellelement, eine Anmerkung.
    link: {
      action: 'Verknüpfen',
      title: 'Element verknüpfen',
      hint: 'Die Verknüpfung zeigt, was gemeint ist. Sie ist keine Maßangabe.',
      tabDocument: 'Dokument',
      tabElement: 'Modellelement',
      tabAnnotation: 'Anmerkung',
      search: 'Suchen …',
      page: 'Seite',
      model: 'Modell',
      noModels: 'In diesem Projekt liegt kein gelesenes Modell.',
      noResults: 'Nichts gefunden.',
      searching: 'Sucht …',
      apply: 'Verknüpfen',
      unlink: 'Verknüpfung lösen',
      cancel: 'Abbrechen',
      open: 'Öffnen: {title}',
      openPage: '{title}, S. {page}',
      version: 'Fassung {number}',
      gone: 'Nicht mehr vorhanden',
      unresolved: 'Verknüpft; das Ziel zeigt sich beim nächsten Öffnen',
    },
    title: 'Skizze bearbeiten',
    description: 'Ausgangspunkt ist {productName}s Zeichnung. Eine Skizze ist nicht maßstäblich und behauptet keine Maße.',
    loading: 'Zeichenfläche wird geladen …',
    loadFailed: 'Die Zeichenfläche konnte nicht geladen werden.',
    save: 'Im Projekt ablegen',
    saving: 'Wird abgelegt …',
    close: 'Schließen',
    discardQuestion: 'Änderungen verwerfen?',
    discard: 'Verwerfen',
    keepEditing: 'Weiter bearbeiten',
    defaultTitle: 'Skizze',
    notToScale: 'Skizze — nicht maßstäblich, ohne Maßangabe.',
    fallback: 'Diese Skizze konnte nicht gezeichnet werden. Bitten Sie {productName}, sie noch einmal zu zeichnen.',
    reviseDescription: 'Jedes Speichern wird eine neue Fassung dieses Dokuments; frühere Fassungen bleiben im Verlauf.',
    opening: 'Skizze wird geöffnet …',
    openFailed: 'Die Skizze konnte nicht geöffnet werden.',
    saveVersion: 'Als neue Fassung speichern',
    savingVersion: 'Wird gespeichert …',
    savedVersion: 'Als Fassung {number} gespeichert',
    saveFailed: 'Konnte nicht gespeichert werden',
    staleVersion: 'Inzwischen gibt es eine neuere Fassung. Öffnen Sie die Skizze erneut, um auf ihr weiterzuarbeiten.',
    renderUnavailable: 'Das Bild der Skizze konnte gerade nicht gezeichnet werden. Bitte gleich noch einmal speichern.',
    sceneRejected: 'Die Skizze enthält etwas, das hier nicht gespeichert wird: ein Bild, eingebettete Inhalte oder zu viele Elemente.',
    viewOnly: 'Sie können diese Skizze ansehen, aber nicht ändern. Was die anderen zeichnen, erscheint hier sofort.',
    agentFor: '{name} · für {forName}',
    peerSaved: '{name} hat eine Fassung gespeichert. Ihre Zeichenfläche zeigt genau diese.',
    peerSavedDiffers: '{name} hat eine Fassung gespeichert. Was Sie seitdem gezeichnet haben, ist noch nicht gespeichert.',
    tooLargeLive: 'Ein Element ist zu groß, um live geteilt zu werden. Die anderen sehen es, sobald Sie speichern.',
    refusedLive: 'Ein Element kann nicht live geteilt werden. Beim Speichern wird es noch einmal geprüft.',
    pdfStale: 'Die PDF daneben konnte nicht neu erstellt werden und zeigt noch die vorige Fassung.',
    discardShared: '{names} ist noch im Raum und behält die Änderungen. Schließen, ohne zu speichern?',
    savedDraft: 'Im Entwurf zur Freigabe gespeichert (Fassung {number}); veröffentlicht wird er erst mit der Freigabe.',
    reviewOpen: 'Diese Skizze ist in Prüfung: Speichern geht erst, wenn die Freigabe entschieden ist. Sie können weiterzeichnen, die anderen sehen es live; gespeichert wird nichts.',
    keepDrawing: 'Weiterzeichnen',
    reviseDraftDescription: 'Sie bearbeiten den Entwurf, der in Freigabe ist. Speichern ändert den Entwurf; veröffentlicht wird er erst mit der Freigabe.',
    reviewOpenDescription: 'Diese Skizze ist in Prüfung. Sie können live mitzeichnen, gespeichert wird erst nach der Freigabe.',
    saveAgain: 'Inzwischen hat jemand eine neuere Fassung gespeichert. Ihre Änderungen sind eingearbeitet; bitte erneut speichern.',
  },
  sketchEdit: {
    eyebrow: 'Skizze ändern',
    // Die vorgeschlagenen Schritte, nummeriert.
    steps: 'Schritte',
    legendAdded: 'neu',
    legendRemoved: 'entfernt',
    legendChanged: 'geändert',
    previewAlt: 'Die Skizze nach der Änderung, Neues grün, Entferntes rot gestrichelt, Geändertes blau über dem grau gestrichelten Stand davor.',
    previewLoading: 'Vorschau wird gezeichnet …',
    previewFailed: 'Die Vorschau konnte nicht gezeichnet werden. Die Schritte stehen darunter.',
    warnings: 'Hinweise zur Anordnung',
    applied: 'In die Skizze übernommen',
    dismissed: 'Verworfen, die Skizze bleibt, wie sie ist',
    undo: 'Rückgängig',
    undoing: 'Wird zurückgenommen …',
    undone: 'Rückgängig gemacht: die Fassung davor gilt wieder.',
    undoBlocked: 'Danach gibt es schon eine neuere Fassung der Skizze, deshalb lässt sich diese Änderung nicht mehr einfach zurücknehmen.',
    undoFailed: 'Konnte nicht rückgängig gemacht werden.',
    changed: 'Die Skizze hat sich inzwischen geändert: ein Element, das diese Änderung braucht, wurde entfernt oder von jemand anderem bearbeitet. Übernommen wurde nichts. Bitten Sie {productName}, es auf dem neuen Stand noch einmal zu versuchen.',
    movedOn: 'Seitdem gibt es eine neuere Fassung der Skizze, oder sie ist in Freigabe. Zurückgenommen wurde nichts.',
    refused: 'Diese Änderung passt nicht zur Skizze. Bitten Sie {productName}, sie noch einmal zu lesen.',
  },
  rejected: {
    empty: 'Das Diagramm war leer.',
    'too-large': 'Das Diagramm ist zu groß, um abgelegt zu werden.',
    'malformed-xml': 'Das Diagramm ist kein wohlgeformtes XML.',
    'doctype-or-entity': 'Das Diagramm deklariert einen Dokumenttyp oder eine Entität. Das ist nicht zulässig.',
    'not-svg': 'Die Datei ist kein SVG.',
    'missing-viewport': 'Das Diagramm nennt keine Größe und lässt sich deshalb nicht auf eine Seite setzen.',
    'script-element': 'Das Diagramm enthält ein Skript.',
    'foreign-object': 'Das Diagramm bettet HTML ein (foreignObject). Bitte mit abgeschaltetem htmlLabels zeichnen.',
    'style-element':
      'Das Diagramm bringt ein Stylesheet mit. Die Stile müssen vor dem Ablegen auf die Elemente übertragen werden.',
    'unsupported-element': 'Das Diagramm verwendet ein Element, das dieses Produkt nicht zeichnet.',
    'event-handler-attribute': 'Das Diagramm enthält einen Ereignis-Handler.',
    'external-reference': 'Das Diagramm verweist auf etwas außerhalb seiner selbst.',
    'source-too-large': 'Der Quelltext des Diagramms ist zu lang.',
    'too-deep': 'Die Elemente des Diagramms sind zu tief ineinander verschachtelt.',
  },
}
