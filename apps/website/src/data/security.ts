import identity from '../lib/identity';
import type { NavLink } from '../lib/nav';

const brand = identity.name;

/** Copy for /datensicherheit. Brand name comes from identity.json, never typed. */
export const securityHero = {
  title: 'Ihre Daten bleiben Ihre.',
  text: `Pläne, Verträge und Bürowissen sind vertraulich. ${brand} ist so gebaut, dass Ihr Büro jederzeit die Kontrolle behält.`,
};

export const securityIntro = {
  title: 'So schützen wir Ihre Daten.',
};

export const securityItems: { title: string; text: string }[] = [
  {
    title: 'Volle Kontrolle über Ihre Daten',
    text: 'Ihr Büro entscheidet, welche Daten in ' + brand + ' kommen, wie lange sie gespeichert bleiben, und kann sie jederzeit löschen.',
  },
  {
    title: 'Kein Training mit Ihren Daten',
    text: 'Ihre Daten bleiben Ihre. Weder Fragen noch Antworten oder hochgeladene Unterlagen werden genutzt, um KI-Modelle zu trainieren.',
  },
  {
    title: 'Zero Data Retention',
    text: 'Für alle KI-Anfragen gilt Zero Data Retention: Die Anbieter der Sprachmodelle speichern weder Ihre Fragen noch die Antworten.',
  },
  {
    title: 'Hosting in Wien',
    text: 'Ihre Projektdaten liegen in einem Rechenzentrum von IPAX in Wien. Österreichischer Betreiber, europäisches Recht.',
  },
  {
    title: 'Sie bestimmen, was ' + brand + ' sieht',
    text: 'Über eine Ausschlussliste legt Ihr Büro selbst fest, welche Projekte, Ordner oder Dateien nicht auf die Plattform gelangen.',
  },
  {
    title: 'Zugriff nach Rollen',
    text: 'Mit Rollen und Rechten geben Sie Projekte und Inhalte gezielt frei: für einzelne Personen, Teams oder das ganze Büro.',
  },
];

export const securityFaqTitle = 'Häufige Fragen.';

export const securityFaq: { q: string; a: string }[] = [
  {
    q: 'Was bedeutet Zero Data Retention genau?',
    a: 'Wenn Sie eine Frage stellen, sucht ' + brand + ' die passenden Stellen in Ihren Unterlagen heraus und schickt nur diese Ausschnitte zusammen mit der Frage an ein Sprachmodell. Der Anbieter des Modells verarbeitet die Anfrage ausschließlich, um die Antwort zu erzeugen. Danach bleibt bei ihm nichts zurück: keine Kopie der Anfrage, keine Antwort, keine Nutzung für Training. Ihre vollständigen Unterlagen verlassen dabei nie das Rechenzentrum in Wien.',
  },
  {
    q: 'Können andere Büros unsere Unterlagen sehen?',
    a: 'Nein. Jedes Büro hat einen eigenen, abgetrennten Bereich. ' + brand + ' sucht nur in Ihren Unterlagen.',
  },
  {
    q: 'Wie melden sich unsere Mitarbeitenden an?',
    a: 'Über das Microsoft- oder Google-Konto Ihres Büros oder per Anmeldelink an die geschäftliche E-Mail-Adresse.',
  },
  {
    q: 'Gibt es einen Auftragsverarbeitungsvertrag?',
    a: 'Ja. Mit jedem Büro schließen wir einen Auftragsverarbeitungsvertrag ab. Darin ist geregelt, wie wir Ihre Daten verarbeiten und welche Dienstleister beteiligt sind.',
  },
  {
    q: 'Was passiert mit unseren Daten, wenn wir ' + brand + ' nicht mehr nutzen?',
    a: 'Vorher können Sie Dokumente und Antworten exportieren. Nach Vertragsende löschen wir Ihre Daten.',
  },
];

export const securityCta = {
  title: 'Noch Fragen zur Datensicherheit?',
  text: 'Wir gehen sie gern mit Ihnen durch, auch mit Ihrer IT.',
};

export const contactAction: NavLink = { label: 'Kontakt', href: '/kontakt' };
