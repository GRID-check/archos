/**
 * Copy of the building law page, both locales. `{name}` is the brand name, filled by
 * `withName`. Text only: images, links and structure live in `src/views/BuildingLawView.astro`.
 *
 * Name no edition or date of the legal corpus here: nothing on the site's side verifies it.
 * Evidence for each claim (Belegpflicht):
 * - corpus: OIB-Richtlinien, Austrian law via RIS, a curated norm register, norms an office
 *   uploads itself, cited at the passage: VISION.md ("Building law and norms"); the nine states:
 *   packages/ris-adapter/src/register.py (Landesrecht filter);
 * - one click opens the passage: owner decision D16;
 * - the project's facts (Bundesland, Gebäudeklasse, uses) asked at setup, OIB-Richtlinien derived:
 *   VISION.md ("Starting a project");
 * - an Einschätzung is marked as one, nothing ungrounded as fact: VISION.md principle 3;
 * - Aktenvermerk drafted into the project, valid with a person's Freigabe: VISION.md ("Writing").
 */
const de = {
  title: 'Baurecht und OIB-Richtlinien durchsuchen',
  description:
    'Bauordnung, OIB-Richtlinien und die Unterlagen Ihres Projekts in einer Suche. Jede Antwort nennt die Stelle, aus der sie stammt.',
  hero: {
    title: 'Baurecht durchsuchen.',
    text: 'Bauordnung, OIB-Richtlinien und die Unterlagen Ihres Projekts in einer Suche. Jede Antwort nennt die Stelle, aus der sie stammt.',
  },
  intro: {
    title: 'Das Projekt bestimmt, was gilt.',
    text: 'Welche Anforderung ein Projekt trifft, hängt am Bundesland, an der Gebäudeklasse und an der Nutzung. {name} kennt diese Angaben aus dem Projekt und sucht mit ihnen, statt allgemein zu antworten.',
    imageAlt:
      '{name}-Herleitung: eine Frage zum Termin mit dem Küchenplaner, darunter zehn Quellen aus Fachwissen, Projektwissen und Büroablage',
  },
  items: [
    {
      title: 'Die Stelle, nicht nur die Antwort',
      text: 'Jede Aussage nennt Paragraf, Punkt der Richtlinie oder Seite. Ein Klick öffnet die Stelle im Original.',
    },
    {
      title: 'Das Projekt als Rahmen',
      text: 'Bundesland, Gebäudeklasse und Nutzungen fragt {name} beim Einrichten des Projekts ab und leitet daraus ab, welche OIB-Richtlinien gelten.',
    },
    {
      title: 'Gesetz und Unterlagen zusammen',
      text: 'Antworten stützen sich auf Bauordnung und OIB-Richtlinien ebenso wie auf Bebauungsplan, Bescheid und Raumprogramm im Projekt.',
    },
    {
      title: 'Einschätzungen gekennzeichnet',
      text: 'Ist etwas eine Einschätzung, steht das in der Antwort. Was {name} nicht belegen kann, gibt es nicht als Tatsache aus.',
    },
    {
      title: 'Eigene Normen dazu',
      text: 'Normen, die Ihr Büro lizenziert hat, laden Sie selbst hoch. {name} zitiert sie wie jede andere Quelle.',
    },
    {
      title: 'Aus der Antwort ein Aktenvermerk',
      text: 'Auf Wunsch schreibt {name} einen Aktenvermerk ins Projekt. Gültig wird er mit Ihrer Freigabe.',
    },
  ],
  coverage: {
    title: 'Was heute abgedeckt ist.',
    items: [
      { key: 'Landesrecht', value: 'Das Baurecht der neun österreichischen Bundesländer, aus dem Rechtsinformationssystem des Bundes (RIS).' },
      { key: 'OIB-Richtlinien', value: 'Die OIB-Richtlinien mit ihren Begriffsbestimmungen.' },
      { key: 'Normen', value: 'Ein kuratiertes Normenverzeichnis und die Normen, die Ihr Büro selbst hochlädt.' },
      { key: 'Deutschland und Schweiz', value: 'Die Rechtstexte noch nicht. Pläne, Modelle, Unterlagen und Bürowissen nutzt {name} unabhängig vom Land.' },
    ],
  },
  roles: {
    title: '{name} sucht und belegt. Sie entscheiden und zeichnen.',
    text: 'Über ein Ansuchen entscheidet die Behörde. Die Verantwortung für die Planung bleibt bei Ihrem Büro. {name} sorgt dafür, dass Sie die Grundlage dafür schneller vor sich haben, mit jeder Fundstelle.',
  },
  faqTitle: 'Häufige Fragen.',
  faq: [
    {
      q: 'Welche OIB-Richtlinien gelten in meinem Bundesland?',
      a: 'Das legt jedes Bundesland in seinen bautechnischen Vorschriften fest, zu seinem eigenen Zeitpunkt. Eine Übersicht veröffentlicht das Österreichische Institut für Bautechnik auf oib.or.at. {name} leitet beim Einrichten Ihres Projekts ab, welche Richtlinien dafür gelten.',
    },
    {
      q: 'Was ist der Unterschied zwischen Gebäudeklasse und Bauklasse?',
      a: 'Die Gebäudeklasse stammt aus den OIB-Richtlinien und steuert vor allem die Anforderungen an den Brandschutz. Die Bauklasse ist ein Begriff der Bauordnung für Wien, über den der Bebauungsplan die zulässige Gebäudehöhe festlegt. Ein Wiener Gebäude hat beides, und beides folgt aus verschiedenen Regeln.',
    },
    {
      q: 'Woher stammen die Gesetzestexte?',
      a: 'Das Landesrecht stammt aus dem Rechtsinformationssystem des Bundes (RIS), die OIB-Richtlinien vom Österreichischen Institut für Bautechnik. Jede Fundstelle können Sie dort im Original nachlesen.',
    },
    {
      q: 'Ersetzt {name} die Prüfung durch die Behörde?',
      a: 'Nein. {name} bereitet vor, sucht und belegt. Über ein Ansuchen entscheidet die Behörde, und die Planung verantwortet Ihr Büro.',
    },
    {
      q: 'Gilt das auch für Projekte in Deutschland oder der Schweiz?',
      a: 'Die Rechtstexte decken heute Österreich ab. Projektunterlagen, Pläne, Modelle und Bürowissen nutzt {name} in jedem Land.',
    },
  ],
  cta: {
    title: 'Bringen Sie eine Frage aus Ihrem Projekt mit.',
    text: 'Wir beantworten sie mit Ihnen in {name}, mit Fundstelle.',
  },
};

const en: typeof de = {
  title: 'Searching building law and OIB guidelines',
  description:
    'Building code, OIB guidelines and your project documents in one search. Every answer names the passage it comes from.',
  hero: {
    title: 'Searching building law.',
    text: 'Building code, OIB guidelines and your project documents in one search. Every answer names the passage it comes from.',
  },
  intro: {
    title: 'The project decides what applies.',
    text: 'Which requirement a project meets depends on the state, the building class and the use. {name} knows these facts from the project and searches with them, instead of answering in general.',
    imageAlt:
      '{name} derivation: one question about an appointment with the kitchen planner, below it ten sources from specialist knowledge, project knowledge and office files',
  },
  items: [
    {
      title: 'The passage, not just the answer',
      text: 'Every statement names the section, the point of the guideline or the page. One click opens the passage in the original.',
    },
    {
      title: 'The project as the frame',
      text: '{name} asks for the state, building class and uses when the project is set up, and derives which OIB guidelines apply.',
    },
    {
      title: 'Law and documents together',
      text: 'Answers draw on the building code and the OIB guidelines as much as on the zoning plan, the permit and the room schedule in the project.',
    },
    {
      title: 'Assessments marked',
      text: 'When something is an assessment, the answer says so. What {name} cannot back up, it does not present as fact.',
    },
    {
      title: 'Your own standards too',
      text: 'Standards your office has licensed, you upload yourself. {name} cites them like any other source.',
    },
    {
      title: 'From answer to file note',
      text: 'On request, {name} writes a file note into the project. It takes effect with your approval.',
    },
  ],
  coverage: {
    title: 'What is covered today.',
    items: [
      { key: 'State law', value: 'The building law of the nine Austrian states, from the federal legal information system (RIS).' },
      { key: 'OIB guidelines', value: 'The OIB guidelines with their definitions.' },
      { key: 'Standards', value: 'A curated register of standards and the standards your office uploads itself.' },
      { key: 'Germany and Switzerland', value: 'Not the legal texts yet. {name} works with plans, models, documents and office knowledge in any country.' },
    ],
  },
  roles: {
    title: '{name} searches and cites. You decide and sign.',
    text: 'The authority decides on an application. Responsibility for the design stays with your firm. {name} puts the basis for it in front of you sooner, with every citation.',
  },
  faqTitle: 'Frequently asked questions.',
  faq: [
    {
      q: 'Which OIB guidelines apply in my state?',
      a: 'Each Austrian state sets this in its technical building regulations, at its own time. The Austrian Institute of Construction Engineering publishes an overview on oib.or.at. When your project is set up, {name} derives which guidelines apply to it.',
    },
    {
      q: 'What is the difference between building class and Bauklasse?',
      a: 'The building class (Gebäudeklasse) comes from the OIB guidelines and mainly governs fire safety requirements. The Bauklasse is a term of the Vienna building code, through which the zoning plan sets the permitted building height. A Viennese building has both, and each follows from different rules.',
    },
    {
      q: 'Where do the legal texts come from?',
      a: 'State law comes from the federal legal information system (RIS), the OIB guidelines from the Austrian Institute of Construction Engineering. You can read every citation there in the original.',
    },
    {
      q: 'Does {name} replace the authority’s review?',
      a: 'No. {name} prepares, searches and cites. The authority decides on an application, and your firm is responsible for the design.',
    },
    {
      q: 'Does this work for projects in Germany or Switzerland?',
      a: 'The legal texts cover Austria today. {name} works with project documents, plans, models and office knowledge in any country.',
    },
  ],
  cta: {
    title: 'Bring a question from your project.',
    text: 'We answer it with you in {name}, with the citation.',
  },
};

export default { de, en };
