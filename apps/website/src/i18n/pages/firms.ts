/**
 * Copy of the page for offices that search for AI, both locales. `{name}` is the brand
 * name, filled by `withName`. Text only: images, links and structure live in
 * `src/views/FirmsView.astro`.
 *
 * Evidence for each claim (Belegpflicht, packages/brand/docs/brand-basis.md):
 * - one place for plans, models, documents and office knowledge; the four abilities: VISION.md
 *   (its table of what the product does today), and owner decision D16 (model checks against building law, the
 *   drawing vs room schedule comparison, click-to-passage citations, the file formats are live);
 * - nothing changes until a person confirms: VISION.md principle 4;
 * - no designs: Markenbasis positioning; no training: the security page (src/i18n/pages/security.ts);
 * - file formats: docs/user-guides/documents.md (accepted types, Office previews, IFC, folders and ZIPs);
 * - legal texts cover Austria: VISION.md ("OIB-Richtlinien, Austrian law via RIS").
 */
const de = {
  title: 'KI für Architekturbüros',
  description:
    '{name} ist der Workspace für Architektur- und Planungsbüros. Er durchsucht Baurecht, vergleicht Planstände und prüft Modelle. Entwerfen bleibt Ihre Sache.',
  hero: {
    title: 'KI für Architekturbüros. Dort, wo geplant wird.',
    text: '{name} ist der Workspace für Architektur- und Planungsbüros. Pläne, Modelle, Unterlagen und Bürowissen liegen an einem Ort, und {name} übernimmt dort die regelgeleitete Arbeit.',
  },
  today: {
    title: 'Was {name} heute übernimmt.',
    text: 'Baurecht durchsuchen. Planstände vergleichen. Modelle prüfen. Projektwissen finden. Jede Antwort zeigt, woher sie kommt.',
    imageAlt:
      '{name} im Grundriss: Rückfrage von Tobias Kern, Aufgabe für Lena Hofer und eine Frage an {name} zum Fluchtweg, die Plan und Brandschutzkonzept liest',
    items: [
      {
        title: 'Baurecht durchsuchen',
        text: 'Bauordnung, OIB-Richtlinien und Projektunterlagen in einer Suche. Ein Klick öffnet die Stelle, aus der die Antwort stammt.',
      },
      {
        title: 'Planstände vergleichen',
        text: 'Zwei Fassungen nebeneinander, überlagert oder per Wischen. Auf Wunsch markiert {name}, was sich geändert hat.',
      },
      {
        title: 'Modelle prüfen',
        text: 'IFC-Modelle im Browser: Geschoße, Mengen, Schnitte. {name} misst Bauteile und prüft das Modell gegen Vorgaben und Baurecht.',
      },
      {
        title: 'Projektwissen finden',
        text: 'Was Ihr Büro schon gelöst hat, auffindbar nach Inhalt statt nach Dateiname, auch aus abgeschlossenen Projekten.',
      },
    ],
  },
  roles: {
    title: 'Wer was macht.',
    items: [
      { key: 'Planer:innen', value: 'Entwerfen, gewichten, entscheiden und zeichnen. Entwurf und Haltung bleiben beim Menschen.' },
      { key: '{name}', value: 'Sucht, vergleicht und prüft. Bereitet vor, was sich nach Regeln erledigen lässt, und nennt die Quelle.' },
      { key: 'Freigabe', value: 'Was {name} vorschlägt, ändert nichts im Projekt, bis eine Person es bestätigt.' },
      { key: 'Entwürfe', value: '{name} erzeugt keine Entwürfe. Es übernimmt wiederkehrende Aufgaben im Planungsprozess.' },
    ],
  },
  difference: {
    title: 'Mehr als ein Chat.',
    text: 'Allgemeine Chat-Assistenten helfen beim Formulieren. Für die Arbeit an einem Projekt braucht ein Büro mehr.',
    postLink: 'Im Journal: Sechs Fragen an jedes Werkzeug',
    items: [
      {
        title: 'Für das ganze Team',
        text: 'Ein Projekt, ein Stand, für alle Beteiligten. Nicht ein Gespräch, das bei einer Person liegt.',
      },
      {
        title: 'Versteht Pläne und Modelle',
        text: '{name} liest Zeichnungen und IFC-Modelle, nicht nur Text.',
      },
      {
        title: 'Belegt, nicht behauptet',
        text: 'Jede Aussage nennt Paragraf, Seite oder Blatt. Was {name} nicht belegen kann, gibt es nicht als Tatsache aus.',
      },
    ],
  },
  offices: {
    title: 'Für Büros, die vorne mitplanen.',
    text: '{name} entsteht gemeinsam mit Architektur- und Planungsbüros, die es im Projektalltag einsetzen.',
    logosLabel: 'Pilotbüros',
  },
  faqTitle: 'Häufige Fragen.',
  faq: [
    {
      q: 'Erzeugt {name} Entwürfe?',
      a: 'Nein. Entwurf, Haltung und Gestaltung bleiben bei Ihnen. {name} übernimmt die regelgeleitete Arbeit rund um die Planung: suchen, vergleichen, prüfen und vorbereiten.',
    },
    {
      q: 'Welche Unterlagen kann {name} lesen?',
      a: 'PDF, Word, Excel und PowerPoint sowie IFC-Modelle. Ganze Ordner und ZIP-Archive laden Sie so hoch, wie sie auf Ihrem Server liegen.',
    },
    {
      q: 'Wird mit unseren Daten ein KI-Modell trainiert?',
      a: 'Nein. Weder Fragen noch Antworten noch hochgeladene Unterlagen werden zum Training von KI-Modellen verwendet. Einzelheiten stehen auf der Seite Datensicherheit.',
    },
    {
      q: 'Für welches Baurecht funktioniert {name}?',
      a: 'Die Rechtstexte decken heute das österreichische Baurecht und die OIB-Richtlinien ab. Pläne, Modelle, Unterlagen und Bürowissen nutzt {name} unabhängig vom Land.',
    },
    {
      q: 'Wie fangen wir an?',
      a: 'Mit einer Demo an einem echten Projekt. Wir zeigen Ihnen {name} mit Ihren Fragen und klären, wie Ihr Büro einsteigt.',
    },
  ],
  cta: {
    title: '{name} an Ihrem Projekt sehen.',
    text: 'Wir zeigen Ihnen, was {name} in Ihrem Büro übernehmen kann, und beantworten Ihre Fragen.',
  },
};

const en: typeof de = {
  title: 'AI for architecture firms',
  description:
    '{name} is the workspace for architecture and planning firms. It searches building law, compares plan revisions and checks models. Design stays with you.',
  hero: {
    title: 'AI for architecture firms. Where the planning happens.',
    text: '{name} is the workspace for architecture and planning firms. Plans, models, documents and office knowledge sit in one place, and {name} takes over the rule-based work there.',
  },
  today: {
    title: 'What {name} takes over today.',
    text: 'Search building law. Compare plan revisions. Check models. Find project knowledge. Every answer shows where it comes from.',
    imageAlt:
      '{name} on the floor plan: a query from Tobias Kern, a task for Lena Hofer and a question to {name} about the escape route, which reads the plan and the fire safety concept',
    items: [
      {
        title: 'Search building law',
        text: 'Building code, OIB guidelines and project documents in one search. One click opens the passage the answer comes from.',
      },
      {
        title: 'Compare plan revisions',
        text: 'Two revisions side by side, overlaid or with a swipe. On request, {name} marks what changed.',
      },
      {
        title: 'Check models',
        text: 'IFC models in the browser: storeys, quantities, sections. {name} measures elements and checks the model against requirements and building law.',
      },
      {
        title: 'Find project knowledge',
        text: 'What your office has already solved, found by content instead of file name, closed projects included.',
      },
    ],
  },
  roles: {
    title: 'Who does what.',
    items: [
      { key: 'Planners', value: 'Design, weigh, decide and sign. Design and judgement stay with people.' },
      { key: '{name}', value: 'Searches, compares and checks. Prepares what follows rules, and names the source.' },
      { key: 'Approval', value: 'What {name} suggests changes nothing in the project until a person confirms it.' },
      { key: 'Designs', value: '{name} does not generate designs. It takes over recurring tasks in the planning process.' },
    ],
  },
  difference: {
    title: 'More than a chat.',
    text: 'General chat assistants help with wording. Working on a project takes more.',
    postLink: 'In the journal: six questions for any tool',
    items: [
      {
        title: 'For the whole team',
        text: 'One project, one shared picture, for everyone involved. Not a conversation that sits with one person.',
      },
      {
        title: 'Understands plans and models',
        text: '{name} reads drawings and IFC models, not only text.',
      },
      {
        title: 'Cited, not claimed',
        text: 'Every statement names the section, page or sheet. What {name} cannot back up, it does not present as fact.',
      },
    ],
  },
  offices: {
    title: 'For firms that plan ahead.',
    text: '{name} is built together with architecture and planning firms that use it in their daily project work.',
    logosLabel: 'Pilot firms',
  },
  faqTitle: 'Frequently asked questions.',
  faq: [
    {
      q: 'Does {name} generate designs?',
      a: 'No. Design, judgement and form stay with you. {name} takes over the rule-based work around planning: searching, comparing, checking and preparing.',
    },
    {
      q: 'Which documents can {name} read?',
      a: 'PDF, Word, Excel and PowerPoint files, and IFC models. You upload whole folders and ZIP archives as they sit on your server.',
    },
    {
      q: 'Is an AI model trained on our data?',
      a: 'No. Neither questions, answers nor uploaded documents are used to train AI models. The details are on the data security page.',
    },
    {
      q: 'Which building law does {name} cover?',
      a: 'The legal texts cover Austrian building law and the OIB guidelines today. {name} works with plans, models, documents and office knowledge in any country.',
    },
    {
      q: 'How do we start?',
      a: 'With a demo on a real project. We show you {name} with your questions and agree how your firm gets started.',
    },
  ],
  cta: {
    title: 'See {name} on your project.',
    text: 'We show you what {name} can take over in your firm and answer your questions.',
  },
};

export default { de, en };
