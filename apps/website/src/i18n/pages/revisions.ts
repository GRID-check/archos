/**
 * Copy of the plan revision page, both locales. `{name}` is the brand name, filled by
 * `withName`. Text only: images, links and structure live in `src/views/RevisionsView.astro`.
 *
 * Evidence for each claim (Belegpflicht):
 * - recognising a new revision, the three ways to compare, marking on request, the inbox note,
 *   the current revision: releasenotes/notes/dokument-mit-allen-fassungen-*.yaml;
 * - "what changed" page by page with values: releasenotes/notes/compare-fassungen-pages-*.yaml;
 * - carrying annotations over, due dates and reminders: releasenotes/notes/anmerkungen-fassung-fristen-*.yaml;
 * - a revision against the room schedule: owner decision D16 (live), the home gallery's screenshot;
 * - folders and ZIP uploads: VISION.md ("Files and the Büroablage").
 * The automatic comparison when a revision is filed sits behind a feature flag
 * (the release note "notices a new Fassung"), so the page does not promise it.
 */
const de = {
  title: 'Planstände vergleichen',
  description:
    'Zwei Fassungen eines Plans nebeneinander, überlagert oder per Wischen. {name} markiert, was sich geändert hat, und sagt es in Worten.',
  hero: {
    title: 'Planstände vergleichen.',
    text: 'Jede neue Fassung ändert etwas. {name} zeigt, was: nebeneinander, überlagert oder per Wischen, und auf Wunsch am Plan markiert.',
    alt: '{name}: Planänderungen seit Rev. C – drei Änderungen mit Quellen, daneben der Grundriss mit markierten Stellen',
  },
  intro: {
    title: 'Was sich geändert hat. Auf einen Blick.',
    text: 'Ein neuer Planstand kommt vom Tragwerk, von der Haustechnik oder aus dem eigenen Team. Bisher heißt das: zwei PDFs öffnen, Blatt für Blatt vergleichen, Wolken suchen. In {name} liegt jedes Dokument mit allen Fassungen an einem Ort, und der Vergleich ist ein Klick.',
  },
  items: [
    {
      title: 'Neue Fassung erkannt',
      text: 'Am Dateinamen, an Nummer, Index und Datum im Plankopf und am Inhalt. Verknüpft wird erst, wenn Sie bestätigen.',
    },
    {
      title: 'Drei Arten zu vergleichen',
      text: 'Nebeneinander, überlagert mit den Änderungen in Farbe, oder mit dem Wischregler.',
    },
    {
      title: 'Änderungen am Plan markiert',
      text: 'Auf Wunsch markiert {name} am Plan, was sich geändert hat, und sagt es in Worten.',
    },
    {
      title: 'Seite für Seite, mit Werten',
      text: 'Fragen Sie, was sich geändert hat. {name} antwortet Seite für Seite, mit den geänderten Werten und dem Datum jeder Fassung.',
    },
  ],
  requirements: {
    title: 'Gegen das, was gilt.',
    text: 'Ein Planstand ist erst geprüft, wenn er gegen die Vorgaben abgeglichen ist: Raumprogramm, Wünsche der Bauherrschaft, Baurecht. {name} liest Plan und Projektunterlagen und zeigt Abweichungen mit Quelle, etwa eine Raumhöhe, die 10 cm unter dem Raumprogramm liegt.',
    imageAlt: '{name}-Prüfung: Raumhöhe 10 cm zu niedrig, mit Quellen aus Raumprogramm und Schnitt, daneben der markierte Schnitt',
  },
  round: {
    title: 'Die Prüfrunde bleibt im Projekt.',
    items: [
      { key: 'Anmerkungen', value: 'Offene Anmerkungen einer früheren Fassung nehmen Sie in die neue mit, mit Nummer, Ort und Verlauf.' },
      { key: 'Benachrichtigung', value: 'Wer einem Dokument zugeordnet ist, erfährt im Posteingang, wenn eine neue Fassung es ersetzt, mit der ersten Zeile der Änderungen.' },
      { key: 'Fristen', value: 'Wer für eine Anmerkung verantwortlich ist, sieht ihre Frist und wird am Vortag erinnert.' },
      { key: 'Aktueller Stand', value: '{name} antwortet aus der aktuellen Fassung. Eine ältere zieht es nur heran, wenn Sie sie nennen, und sagt das dazu.' },
    ],
  },
  faqTitle: 'Häufige Fragen.',
  faq: [
    {
      q: 'Welche Dateien kann {name} vergleichen?',
      a: 'Alle Fassungen eines Dokuments, etwa Pläne als PDF. Die Fassungen erkennt {name} beim Hochladen und fragt einmal nach, bevor es sie verknüpft.',
    },
    {
      q: 'Braucht der Vergleich Revisionswolken?',
      a: 'Nein. Nebeneinander, Überlagerung und Wischregler zeigen die Zeichnung selbst. Was sich geändert hat, sehen Sie in Farbe, ob eine Wolke daran steht oder nicht.',
    },
    {
      q: 'Wer entscheidet, ob eine Änderung stimmt?',
      a: 'Sie. {name} zeigt und benennt Änderungen. Was im Projekt gilt, bestätigen Sie in der Prüfung.',
    },
    {
      q: 'Wie kommen die Pläne in {name}?',
      a: 'Per Upload, auch als ganzer Ordner oder ZIP-Archiv, so wie sie auf dem Büroserver liegen.',
    },
  ],
  cta: {
    title: 'Bringen Sie zwei Planstände mit.',
    text: 'Wir vergleichen sie mit Ihnen in {name}, an einem echten Projekt.',
  },
};

const en: typeof de = {
  title: 'Comparing plan revisions',
  description:
    'Two revisions of a plan side by side, overlaid or with a swipe. {name} marks what changed and says it in words.',
  hero: {
    title: 'Comparing plan revisions.',
    text: 'Every new revision changes something. {name} shows what: side by side, overlaid or with a swipe, and on request marked on the plan.',
    alt: '{name}: changes to the plan since Rev. C, three changes with their sources, beside the floor plan with the changes marked',
  },
  intro: {
    title: 'What changed. At a glance.',
    text: 'A new revision arrives from the structural engineer, the building services consultant or your own team. Until now that meant opening two PDFs, comparing sheet by sheet and hunting for revision clouds. In {name}, each document sits in one place with all its revisions, and comparing is one click.',
  },
  items: [
    {
      title: 'New revision recognised',
      text: 'From the file name, from the number, index and date in the title block, and from the content. Nothing is linked until you confirm.',
    },
    {
      title: 'Three ways to compare',
      text: 'Side by side, overlaid with the changes in colour, or with the swipe slider.',
    },
    {
      title: 'Changes marked on the plan',
      text: 'On request, {name} marks on the plan what changed and says it in words.',
    },
    {
      title: 'Page by page, with values',
      text: 'Ask what changed. {name} answers page by page, with the values that changed and the date of each revision.',
    },
  ],
  requirements: {
    title: 'Against what applies.',
    text: 'A revision is not checked until it has been compared with the requirements: room schedule, the client’s wishes, building law. {name} reads the plan and the project documents and shows deviations with their source, such as a ceiling height 10 cm below the room schedule.',
    imageAlt: '{name} check: ceiling height 10 cm too low, with sources from the room schedule and the section, beside the marked section',
  },
  round: {
    title: 'The review stays in the project.',
    items: [
      { key: 'Annotations', value: 'Open annotations from an earlier revision carry over to the new one, with their number, position and thread.' },
      { key: 'Notification', value: 'Whoever is assigned to a document is told in their inbox when a new revision replaces it, with the first line of the changes.' },
      { key: 'Due dates', value: 'Whoever is responsible for an annotation sees its due date and is reminded the day before.' },
      { key: 'Current revision', value: '{name} answers from the current revision. It uses an older one only when you name it, and says so.' },
    ],
  },
  faqTitle: 'Frequently asked questions.',
  faq: [
    {
      q: 'Which files can {name} compare?',
      a: 'All revisions of one document, such as plans as PDF. {name} recognises the revisions on upload and asks once before linking them.',
    },
    {
      q: 'Does the comparison need revision clouds?',
      a: 'No. Side by side, overlay and swipe show the drawing itself. You see what changed in colour, whether it carries a cloud or not.',
    },
    {
      q: 'Who decides whether a change is right?',
      a: 'You do. {name} shows and names changes. You confirm in the review what applies to the project.',
    },
    {
      q: 'How do the plans get into {name}?',
      a: 'By upload, also as a whole folder or ZIP archive, as they sit on the office server.',
    },
  ],
  cta: {
    title: 'Bring two plan revisions.',
    text: 'We compare them with you in {name}, on a real project.',
  },
};

export default { de, en };
