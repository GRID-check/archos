/**
 * Copy of the home page, both locales. `{name}` is the brand name, filled by
 * `withName`. Text, alt text and labels only: images, video sources and the
 * page's structure live in `src/views/HomeView.astro`.
 */
const de = {
  hero: {
    title: 'Der Workspace für Architekturbüros.',
    text: '{name} bringt KI in den Planungsprozess. Für Teams, die neue Standards setzen.',
    alt: '{name}: Planänderungen seit Rev. C – drei Änderungen mit Quellen, daneben der Grundriss mit markierten Stellen',
  },
  workload: {
    title: 'Jede Planungsrunde erzeugt Arbeit. {name} reduziert sie.',
    lead: 'Planungsprozesse werden sich grundlegend verändern.',
    text: '{name} schafft die Plattform dafür: Projektwissen, Unterlagen, Pläne und Modelle kommen in einem Workspace zusammen. Darauf aufbauend übernimmt {name} Schritt für Schritt Aufgaben und ganze Abläufe im Planungsprozess.',
  },
  gallery: {
    label: 'Was {name} übernimmt: Baurecht durchsuchen, Unterlagen vergleichen, Modelle prüfen',
    items: [
      {
        title: 'Eine Frage. Das ganze Projekt als Kontext.',
        text: 'Belegt aus Fachwissen, Projekt und Büro.',
        alt: '{name}-Herleitung: eine Frage zum Termin mit dem Küchenplaner, darunter zehn Quellen aus Fachwissen, Projektwissen und Büroablage',
      },
      {
        title: 'Planstand und Anforderungen. Direkt abgeglichen.',
        text: 'Abweichungen werden sofort sichtbar.',
        alt: '{name}-Prüfung: Raumhöhe 10 cm zu niedrig, mit Quellen aus Raumprogramm und Schnitt, daneben der markierte Schnitt',
      },
      {
        title: 'Komplexe Modelle. Klar im Blick.',
        text: '3D-Modell prüfen und auswerten.',
        alt: '{name}-Modellprüfung: 3D-Modell mit markiertem Modul, daneben Geschoße und Prüfergebnis',
      },
    ],
  },
  knowledge: {
    title: 'Das Wissen Ihres Büros wird nutzbar.',
    text: 'Jedes Projekt erzeugt Wissen: Pläne, Modelle, Protokolle, E-Mails, Details, Entscheidungen. Heute liegt es verteilt in Ordnern, Servern, Systemen und Köpfen. {name} führt es zusammen und macht es für das ganze Team nutzbar.',
    videoLabel: 'Animation: Jedes Projekt erzeugt Wissen. Wer es braucht, muss suchen. Ihr Wissen arbeitet für Sie.',
    intelligence: {
      title: 'Vom Projektwissen zur Projektintelligenz.',
      text: 'Neue Kolleg:innen finden sich schneller ein, gelöste Fragen müssen nicht neu gelöst werden, und jede Antwort zeigt, woher sie kommt. {name} ist das Rückgrat, an dem die Systeme des Büros andocken.',
    },
  },
  statement: {
    title: '{name} automatisiert Prozesse. Nicht Architektur.',
    duo: [
      {
        title: 'Planer:innen entwerfen.',
        text: 'Entwurf, Haltung und Innovation bleiben beim Menschen.',
      },
      {
        title: 'KI sucht, vergleicht und prüft.',
        text: 'Was sich automatisieren lässt, übernimmt {name}. So wird schneller und sicherer gebaut.',
      },
    ],
  },
  built: {
    title: 'Gebaut für Architektur- & Planungsbüros. Für das ganze Projekt.',
    imageAlt: '{name} im Grundriss: Rückfrage von Tobias Kern, Aufgabe für Lena Hofer und eine Frage an {name} zum Fluchtweg, die Plan und Brandschutzkonzept liest',
    features: [
      {
        title: 'Gemeinsam am Projekt arbeiten',
        text: 'Kolleg:innen können sich einbinden, markieren und im selben Kontext weiterarbeiten.',
      },
      {
        title: 'Versteht Pläne und Modelle',
        text: '{name} baut auf visuellen Daten auf: auf Plänen und 3D-Modellen, nicht nur auf Text.',
      },
      {
        title: 'Arbeit direkt am Plan erledigen',
        text: 'Direkt im Plan oder im Modell fragen, prüfen und weiterarbeiten.',
      },
    ],
  },
  roadmap: {
    title: 'Fortschritt, der im Büroalltag ankommt.',
    steps: [
      {
        when: 'Heute',
        text: 'Pläne, Modelle, Unterlagen und Bürowissen in einem Workspace. {name} durchsucht Projekte, vergleicht Planstände und prüft Modelle gegen Vorgaben und Baurecht.',
      },
      {
        when: 'Als Nächstes',
        text: '{name} übernimmt ganze Abläufe. Neue Planstände werden automatisch auf Risiken, Anforderungen und Wünsche der Bauherrschaft geprüft.',
      },
      {
        when: 'Langfristig',
        text: 'Eine neue Art zu planen. Planer:innen geben Richtung und Entscheidungen vor. {name} übernimmt den Rest. Projekt, Team und künstliche Intelligenz wachsen zusammen.',
      },
    ],
  },
  quote: {
    text: 'Der USP von Architektinnen und Architekten ist die Haltung, weniger die Produktion. Die Informationsflut zu bewältigen, das kann KI.',
    name: 'Ralph Reisinger',
    role: 'Architekt & Projektleiter',
    portraitAlt: 'Vier Männer im Gespräch vor einer hellen Ziegelfassade',
  },
  founders: {
    title: 'Das Planungsbüro der Zukunft entsteht heute.',
    caption: 'Wir übersetzen KI-Fortschritt in Planungsfortschritt.',
    people: [
      {
        name: 'Jonathan Uhlemann',
        role: 'Architektur und Produkt',
        portrait: '/media/jonathan-uhlemann.webp',
        portraitAlt: 'Portrait von Jonathan Uhlemann',
      },
      {
        name: 'Matthias Bigl',
        role: 'Software und KI',
        portrait: '/media/matthias-bigl.webp',
        portraitAlt: 'Portrait von Matthias Bigl',
      },
      {
        name: 'Ferdinand Rubenbauer',
        role: 'Business und Vertrieb',
        portrait: '/media/ferdinand-rubenbauer.webp',
        portraitAlt: 'Portrait von Ferdinand Rubenbauer',
      },
    ],
    lead: 'Wir zeigen Ihnen {name} an einem echten Projekt und beantworten Ihre Fragen.',
  },
};

const en: typeof de = {
  hero: {
    title: 'The workspace for architecture firms.',
    text: '{name} brings AI into the planning process. For teams that set new standards.',
    alt: '{name}: plan changes since Rev. C, three changes with sources, beside the floor plan with the marked spots',
  },
  workload: {
    title: 'Every planning round creates work. {name} reduces it.',
    lead: 'Planning processes are about to change fundamentally.',
    text: '{name} provides the platform: project knowledge, documents, plans and models come together in one workspace. Building on that, {name} takes over tasks and entire workflows in the planning process, step by step.',
  },
  gallery: {
    label: 'What {name} takes over: searching building law, comparing documents, checking models',
    items: [
      {
        title: 'One question. The whole project as context.',
        text: 'Backed by specialist knowledge, project and office.',
        alt: '{name} derivation: one question about an appointment with the kitchen planner, below it ten sources from specialist knowledge, project knowledge and office files',
      },
      {
        title: 'Plan status and requirements. Compared directly.',
        text: 'Deviations show up immediately.',
        alt: '{name} check: ceiling height 10 cm too low, with sources from the room schedule and the section, beside the marked section',
      },
      {
        title: 'Complex models. Clearly in view.',
        text: 'Check and evaluate 3D models.',
        alt: '{name} model check: 3D model with a marked module, beside it the storeys and the check result',
      },
    ],
  },
  knowledge: {
    title: 'The knowledge of your office becomes usable.',
    text: 'Every project creates knowledge: plans, models, minutes, emails, details, decisions. Today it is spread across folders, servers, systems and people’s heads. {name} brings it together and makes it usable for the whole team.',
    videoLabel: 'Animation: every project creates knowledge. Whoever needs it has to search. Your knowledge works for you.',
    intelligence: {
      title: 'From project knowledge to project intelligence.',
      text: 'New colleagues get up to speed faster, solved questions do not have to be solved again, and every answer shows where it comes from. {name} is the backbone the office’s systems connect to.',
    },
  },
  statement: {
    title: '{name} automates processes. Not architecture.',
    duo: [
      {
        title: 'Planners design.',
        text: 'Design, stance and innovation stay with people.',
      },
      {
        title: 'AI searches, compares and checks.',
        text: 'What can be automated, {name} takes over. That way, building gets faster and safer.',
      },
    ],
  },
  built: {
    title: 'Built for architecture and planning firms. For the whole project.',
    imageAlt: '{name} on the floor plan: a query from Tobias Kern, a task for Lena Hofer and a question to {name} about the escape route, which reads the plan and the fire safety concept',
    features: [
      {
        title: 'Work on the project together',
        text: 'Colleagues can join in, mark things up and keep working in the same context.',
      },
      {
        title: 'Understands plans and models',
        text: '{name} works on visual data: on plans and 3D models, not only on text.',
      },
      {
        title: 'Get the work done on the plan',
        text: 'Ask, check and keep working directly in the plan or the model.',
      },
    ],
  },
  roadmap: {
    title: 'Progress that reaches the office day to day.',
    steps: [
      {
        when: 'Today',
        text: 'Plans, models, documents and office knowledge in one workspace. {name} searches projects, compares plan states and checks models against requirements and building law.',
      },
      {
        when: 'Next',
        text: '{name} takes over entire workflows. New plan states are checked automatically for risks, requirements and the wishes of the client.',
      },
      {
        when: 'Long term',
        text: 'A new way to plan. Planners set the direction and make the decisions. {name} takes care of the rest. Project, team and artificial intelligence grow together.',
      },
    ],
  },
  quote: {
    text: 'The strength of architects is their stance, less their output. Handling the flood of information is something AI can do.',
    name: 'Ralph Reisinger',
    role: 'Architect & project lead',
    portraitAlt: 'Four men in conversation in front of a light brick facade',
  },
  founders: {
    title: 'The planning firm of the future starts today.',
    caption: 'We turn AI progress into progress in planning.',
    people: [
      {
        name: 'Jonathan Uhlemann',
        role: 'Architecture and product',
        portrait: '/media/jonathan-uhlemann.webp',
        portraitAlt: 'Portrait of Jonathan Uhlemann',
      },
      {
        name: 'Matthias Bigl',
        role: 'Software and AI',
        portrait: '/media/matthias-bigl.webp',
        portraitAlt: 'Portrait of Matthias Bigl',
      },
      {
        name: 'Ferdinand Rubenbauer',
        role: 'Business and sales',
        portrait: '/media/ferdinand-rubenbauer.webp',
        portraitAlt: 'Portrait of Ferdinand Rubenbauer',
      },
    ],
    lead: 'We will show you {name} on a real project and answer your questions.',
  },
};

export default { de, en };
