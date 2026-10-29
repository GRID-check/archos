import type { DuoItem } from '../components/DuoCards.astro';
import identity from '../lib/identity';

// Copy of the home page. Brand name comes from identity, never typed here.
const name = identity.name;
const nbsp = ' ';

export const hero = {
  title: 'Der Workspace für Architekturbüros.',
  text: `${name} bringt KI in den Planungsprozess. Für Teams, die neue Standards setzen.`,
  image: '/media/product-plan-revision-changes.webp',
  alt: `${name}: Planänderungen seit Rev. C – drei Änderungen mit Quellen, daneben der Grundriss mit markierten Stellen`,
};

export const workload = {
  title: `Jede Planungsrunde erzeugt Arbeit.${nbsp}${name} reduziert sie.`,
  lead: 'Planungsprozesse werden sich grundlegend verändern.',
  text: `${name} schafft die Plattform dafür: Projektwissen, Unterlagen, Pläne und Modelle kommen in einem Workspace zusammen. Darauf aufbauend übernimmt ${name} Schritt für Schritt Aufgaben und ganze Abläufe im Planungsprozess.`,
};

export const gallery = {
  label: `Was ${name} übernimmt: Baurecht durchsuchen, Unterlagen vergleichen, Modelle prüfen`,
  items: [
    {
      title: 'Eine Frage. Das ganze Projekt als Kontext.',
      text: 'Belegt aus Fachwissen, Projekt und Büro.',
      image: '/media/product-search-derivation.webp',
      alt: `${name}-Herleitung: eine Frage zum Termin mit dem Küchenplaner, darunter zehn Quellen aus Fachwissen, Projektwissen und Büroablage`,
    },
    {
      title: 'Planstand und Anforderungen. Direkt abgeglichen.',
      text: 'Abweichungen werden sofort sichtbar.',
      image: '/media/product-compare-clearance.webp',
      alt: `${name}-Prüfung: Raumhöhe 10 cm zu niedrig, mit Quellen aus Raumprogramm und Schnitt, daneben der markierte Schnitt`,
    },
    {
      title: 'Komplexe Modelle. Klar im Blick.',
      text: '3D-Modell prüfen und auswerten.',
      image: '/media/product-model-check.webp',
      alt: `${name}-Modellprüfung: 3D-Modell mit markiertem Modul, daneben Geschoße und Prüfergebnis`,
    },
  ],
};

export const knowledge = {
  title: `Das Wissen Ihres Büros${nbsp}wird nutzbar.`,
  text: `Jedes Projekt erzeugt Wissen: Pläne, Modelle, Protokolle, E-Mails, Details, Entscheidungen. Heute liegt es verteilt in Ordnern, Servern, Systemen und Köpfen. ${name} führt es zusammen und macht es für das ganze Team nutzbar.`,
  video: {
    label: 'Animation: Jedes Projekt erzeugt Wissen. Wer es braucht, muss suchen. Ihr Wissen arbeitet für Sie.',
    poster: '/media/knowledge-video-poster.webp',
    sources: [
      { src: '/media/knowledge-video.webm', type: 'video/webm' },
      { src: '/media/knowledge-video.mp4', type: 'video/mp4' },
    ],
  },
  intelligence: {
    title: `Vom Projektwissen${nbsp}zur Projektintelligenz.`,
    text: `Neue Kolleg:innen finden sich schneller ein, gelöste Fragen müssen nicht neu gelöst werden, und jede Antwort zeigt, woher sie kommt. ${name} ist das Rückgrat, an dem die Systeme des Büros andocken.`,
  },
};

export const statement: { title: string; duo: [DuoItem, DuoItem] } = {
  title: `${name} automatisiert Prozesse. Nicht Architektur.`,
  duo: [
    {
      title: 'Planer:innen entwerfen.',
      text: 'Entwurf, Haltung und Innovation bleiben beim Menschen.',
      photo: '/media/planner-design-photo.webp',
      photoStyle:
        'object-position: 60% 100%; transform: translateX(-50%); filter: sepia(0.16) saturate(1.05) contrast(0.92) brightness(0.82);',
      onPhoto: true,
      ai: true,
    },
    {
      title: 'KI sucht, vergleicht und prüft.',
      text: `Was sich automatisieren lässt, übernimmt ${name}. So wird schneller und sicherer gebaut.`,
      photo: '/media/ai-search-compare-photo.webp',
      photoStyle:
        'object-position: 50% 70%; filter: grayscale(1) sepia(0.15) hue-rotate(175deg) saturate(0.9) brightness(0.6) contrast(1.1);',
      ai: true,
    },
  ],
};

export const built = {
  title: `Gebaut für Architektur- & Planungsbüros. Für das ganze Projekt.`,
  image: {
    src: '/media/product-floor-plan-query.webp',
    alt: `${name} im Grundriss: Rückfrage von Tobias Kern, Aufgabe für Lena Hofer und eine Frage an ${name} zum Fluchtweg, die Plan und Brandschutzkonzept liest`,
  },
  features: [
    {
      title: 'Gemeinsam am Projekt arbeiten',
      text: 'Kolleg:innen können sich einbinden, markieren und im selben Kontext weiterarbeiten.',
    },
    {
      title: 'Versteht Pläne und Modelle',
      text: `${name} baut auf visuellen Daten auf: auf Plänen und 3D-Modellen, nicht nur auf Text.`,
    },
    {
      title: 'Arbeit direkt am Plan erledigen',
      text: 'Direkt im Plan oder im Modell fragen, prüfen und weiterarbeiten.',
    },
  ],
};

export const roadmap = {
  title: 'Fortschritt, der im Büroalltag ankommt.',
  steps: [
    {
      when: 'Heute',
      text: `Pläne, Modelle, Unterlagen und Bürowissen in einem Workspace. ${name} durchsucht Projekte, vergleicht Planstände und prüft Modelle gegen Vorgaben und Baurecht.`,
    },
    {
      when: 'Als Nächstes',
      text: `${name} übernimmt ganze Abläufe. Neue Planstände werden automatisch auf Risiken, Anforderungen und Wünsche der Bauherrschaft geprüft.`,
    },
    {
      when: 'Langfristig',
      text: `Eine neue Art zu planen. Planer:innen geben Richtung und Entscheidungen vor. ${name} übernimmt den Rest. Projekt, Team und künstliche Intelligenz wachsen zusammen.`,
    },
  ],
};

export const quote = {
  quote:
    'Der USP von Architektinnen und Architekten ist die Haltung, weniger die Produktion. Die Informationsflut zu bewältigen, das kann KI.',
  name: 'Ralph Reisinger',
  role: 'Architekt & Projektleiter',
  office: 'feld72',
  portrait: '/media/team-conversation-photo.jpg',
  portraitAlt: 'Vier Männer im Gespräch vor einer hellen Ziegelfassade',
};

export const pilotOffices = [
  { src: '/media/pilot-office-gerner-gerner-plus.svg', alt: 'Gerner Gerner Plus', height: 56 },
  { src: '/media/pilot-office-zz-architecture.svg', alt: 'Z/Z architecture', height: 52 },
  { src: '/media/pilot-office-feld72.svg', alt: 'feld72', height: 44 },
  { src: '/media/pilot-office-bewe-emp.svg', alt: 'bewe em.p', height: 60 },
];

export const founders = {
  title: 'Das Planungsbüro der Zukunft entsteht heute.',
  image: {
    src: '/media/founders-photo.jpg',
    alt: `Das Gründerteam von ${name}: zwei Männer sitzen vor einer hellen Wand`,
  },
  caption: 'Wir übersetzen KI-Fortschritt in Planungsfortschritt.',
  founders: [
    { name: 'Ferdinand Rubenbauer', role: 'Strategie' },
    { name: 'Matthias Bigl', role: 'Technologie' },
    { name: 'Jonathan Uhlemann', role: 'Produkt' },
  ],
  lead: `Wir zeigen Ihnen ${name} an einem echten Projekt und beantworten Ihre Fragen.`,
};
