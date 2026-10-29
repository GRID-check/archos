/**
 * Copy of the data security page, both locales. `{name}` is the brand name, filled by
 * `withName`. Text only: the page's structure lives in `src/views/SecurityView.astro`.
 */
const de = {
  title: 'Datensicherheit',
  hero: {
    title: 'Ihre Daten bleiben Ihre.',
    text: 'Pläne, Verträge und Bürowissen sind vertraulich. {name} ist so gebaut, dass Ihr Büro jederzeit die Kontrolle behält.',
  },
  intro: {
    title: 'So schützen wir Ihre Daten.',
  },
  items: [
    {
      title: 'Volle Kontrolle über Ihre Daten',
      text: 'Ihr Büro entscheidet, welche Daten in {name} kommen, wie lange sie gespeichert bleiben, und kann sie jederzeit löschen.',
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
      title: 'Sie bestimmen, was {name} sieht',
      text: 'Über eine Ausschlussliste legt Ihr Büro selbst fest, welche Projekte, Ordner oder Dateien nicht auf die Plattform gelangen.',
    },
    {
      title: 'Zugriff nach Rollen',
      text: 'Mit Rollen und Rechten geben Sie Projekte und Inhalte gezielt frei: für einzelne Personen, Teams oder das ganze Büro.',
    },
  ],
  faqTitle: 'Häufige Fragen.',
  faq: [
    {
      q: 'Was bedeutet Zero Data Retention genau?',
      a: 'Wenn Sie eine Frage stellen, sucht {name} die passenden Stellen in Ihren Unterlagen heraus und schickt nur diese Ausschnitte zusammen mit der Frage an ein Sprachmodell. Der Anbieter des Modells verarbeitet die Anfrage ausschließlich, um die Antwort zu erzeugen. Danach bleibt bei ihm nichts zurück: keine Kopie der Anfrage, keine Antwort, keine Nutzung für Training. Ihre vollständigen Unterlagen verlassen dabei nie das Rechenzentrum in Wien.',
    },
    {
      q: 'Können andere Büros unsere Unterlagen sehen?',
      a: 'Nein. Jedes Büro hat einen eigenen, abgetrennten Bereich. {name} sucht nur in Ihren Unterlagen.',
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
      q: 'Was passiert mit unseren Daten, wenn wir {name} nicht mehr nutzen?',
      a: 'Vorher können Sie Dokumente und Antworten exportieren. Nach Vertragsende löschen wir Ihre Daten.',
    },
  ],
  cta: {
    title: 'Noch Fragen zur Datensicherheit?',
    text: 'Wir gehen sie gern mit Ihnen durch, auch mit Ihrer IT.',
  },
};

const en: typeof de = {
  title: 'Data security',
  hero: {
    title: 'Your data stays yours.',
    text: 'Plans, contracts and office knowledge are confidential. {name} is built so that your office keeps control at all times.',
  },
  intro: {
    title: 'How we protect your data.',
  },
  items: [
    {
      title: 'Full control over your data',
      text: 'Your office decides which data enters {name}, how long it is kept, and can delete it at any time.',
    },
    {
      title: 'No training on your data',
      text: 'Your data stays yours. Neither questions, answers nor uploaded documents are used to train AI models.',
    },
    {
      title: 'Zero Data Retention',
      text: 'Zero Data Retention applies to all AI requests: the providers of the language models store neither your questions nor the answers.',
    },
    {
      title: 'Hosting in Vienna',
      text: 'Your project data is stored in a data centre of IPAX in Vienna. Austrian operator, European law.',
    },
    {
      title: 'You decide what {name} sees',
      text: 'Using an exclusion list, your office itself determines which projects, folders or files do not reach the platform.',
    },
    {
      title: 'Access by role',
      text: 'With roles and rights, you release projects and content in a targeted way: to individual people, teams or the whole office.',
    },
  ],
  faqTitle: 'Frequently asked questions.',
  faq: [
    {
      q: 'What exactly does Zero Data Retention mean?',
      a: 'When you ask a question, {name} finds the relevant passages in your documents and sends only these excerpts to a language model, together with the question. The provider of the model processes the request solely to generate the answer. Afterwards nothing remains with it: no copy of the request, no answer, no use for training. Your complete documents never leave the data centre in Vienna.',
    },
    {
      q: 'Can other offices see our documents?',
      a: 'No. Each office has its own separate area. {name} only searches your documents.',
    },
    {
      q: 'How do our staff sign in?',
      a: 'With your office’s Microsoft or Google account, or through a sign-in link sent to the business e-mail address.',
    },
    {
      q: 'Is there a data processing agreement?',
      a: 'Yes. We conclude a data processing agreement with every office. It sets out how we process your data and which service providers are involved.',
    },
    {
      q: 'What happens to our data if we stop using {name}?',
      a: 'Before that, you can export documents and answers. After the end of the contract, we delete your data.',
    },
  ],
  cta: {
    title: 'Still questions about data security?',
    text: 'We are happy to go through them with you, including with your IT.',
  },
};

export default { de, en };
