/**
 * Copy of the privacy policy, both locales. `{name}` is the brand name, filled by
 * `withName`. `{legalEntity}`, `{street}`, `{postalCode}`, `{city}` are filled from
 * identity, and `{email}` and `{dsb}` become links, all by the view. Text and labels only.
 */
const de = {
  meta: {
    title: 'Datenschutz',
    description: 'Datenschutzerklärung von {name}: Verantwortliche, Verarbeitungen, Empfänger und Ihre Rechte.',
  },
  hero: {
    title: 'Datenschutz.',
    text: 'Wie wir personenbezogene Daten auf dieser Website und in {name} verarbeiten. Stand: 30.10.2026.',
  },
  notice: '',
  responsible: {
    title: 'Verantwortlich.',
    rows: [
      { key: 'Verantwortlicher', value: '{legalEntity}, {street}, {postalCode} {city}, Österreich' },
      { key: 'Kontakt Datenschutz', value: '{email}' },
    ],
  },
  website: {
    title: 'Website.',
    rows: [
      {
        key: 'Aufruf der Website',
        value:
          'Beim Aufruf speichert unser Hosting-Anbieter technische Daten: IP-Adresse, Datum und Uhrzeit, aufgerufene Seite, Browser und Betriebssystem. Zweck: sicherer und stabiler Betrieb. Rechtsgrundlage: berechtigtes Interesse, Art. 6 Abs. 1 lit. f DSGVO. Löschung nach [14 Tagen].',
      },
      {
        key: 'Notwendige Cookies',
        value:
          'Für die Anmeldung setzen wir technisch notwendige Cookies. Rechtsgrundlage: § 165 Abs. 3 TKG 2021 und Art. 6 Abs. 1 lit. b DSGVO.',
      },
      {
        key: 'Anmeldestatus',
        value:
          'Solange Sie in {name} angemeldet sind, setzt die Anwendung den Cookie „signed_in“ für die ganze Domain. Er enthält nur den Wert „1“, keine Kennung. Die Website wertet ihn nur in Ihrem Browser aus, um statt „Login“ die Schaltfläche „App öffnen“ zu zeigen; für die Reichweitenmessung wird er nicht verwendet. Bei der Abmeldung oder wenn die Sitzung abläuft, wird er gelöscht. Rechtsgrundlage: § 165 Abs. 3 TKG 2021.',
      },
      {
        key: 'Produktanalyse',
        value:
          'Mit PostHog werten wir aus, wie Website und Software genutzt werden, nur wenn Sie zustimmen. Rechtsgrundlage: Einwilligung, Art. 6 Abs. 1 lit. a DSGVO und § 165 Abs. 3 TKG 2021. Die Einwilligung können Sie jederzeit in den [Cookie-Einstellungen] widerrufen. Speicherort: [EU].',
      },
      {
        key: 'Kontakt- und Demoanfragen',
        value:
          'Name, E-Mail-Adresse, Büro, Funktion, Bürogröße, Land und Nachricht verwenden wir, um Ihre Anfrage zu beantworten. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (vorvertragliche Maßnahmen) bzw. lit. f. Löschung, wenn die Anfrage erledigt ist, spätestens nach [24 Monaten], sofern kein Vertrag zustande kommt.',
      },
      {
        key: 'Newsletter',
        value:
          'Wenn Sie es bei der Demo-Anfrage ankreuzen, schicken wir Ihnen Neuigkeiten zu {name} per E-Mail. Rechtsgrundlage: Einwilligung, Art. 6 Abs. 1 lit. a DSGVO und § 174 TKG 2021. Abmeldung jederzeit über den Link in jeder E-Mail oder an {email}.',
      },
      {
        key: 'LinkedIn',
        value:
          'Wir verlinken auf unser LinkedIn-Profil. Daten werden erst übertragen, wenn Sie den Link anklicken. Dann gilt die Datenschutzerklärung von LinkedIn.',
      },
    ],
  },
  software: {
    title: 'Software {name}.',
    rows: [
      {
        key: 'Konto und Anmeldung',
        value:
          'Für Konten verarbeiten wir Name, E-Mail-Adresse, Büro, Rolle und Anmeldezeitpunkte. Die Anmeldung läuft über einen spezialisierten Anmeldedienst. Rechtsgrundlage: Vertrag, Art. 6 Abs. 1 lit. b DSGVO. Löschung nach Vertragsende, soweit keine gesetzlichen Aufbewahrungspflichten bestehen.',
      },
      {
        key: 'Projektdaten der Büros',
        value:
          'Pläne, Modelle, Unterlagen und Fragen an {name} verarbeiten wir im Auftrag des Büros nach Art. 28 DSGVO. Verantwortlich für diese Daten ist das Büro. Welche Unterauftragsverarbeiter wir dafür einsetzen, regelt der Auftragsverarbeitungsvertrag mit dem Büro. Wir trainieren keine KI-Modelle mit den Daten Ihres Büros.',
      },
    ],
  },
  recipients: {
    title: 'Empfänger.',
    rows: [
      {
        key: 'Auftragsverarbeiter',
        value:
          'Für Website, Anfragen und Konten setzen wir Dienstleister ein: Hosting-Anbieter, Anmeldedienst, Produktanalyse und E-Mail-Dienst. Alle sind vertraglich nach Art. 28 DSGVO gebunden.',
      },
      {
        key: 'Drittländer',
        value:
          'Übermittlungen in die USA stützen sich auf den Angemessenheitsbeschluss zum EU-US Data Privacy Framework (Art. 45 DSGVO), sofern der Empfänger zertifiziert ist, sonst auf Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO).',
      },
      {
        key: 'Keine Weitergabe',
        value: 'Wir verkaufen keine Daten und geben sie nicht zu Werbezwecken weiter.',
      },
    ],
  },
  rights: {
    title: 'Ihre Rechte.',
    rows: [
      {
        key: 'Rechte',
        value:
          'Sie haben das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO). Eine Einwilligung können Sie jederzeit mit Wirkung für die Zukunft widerrufen (Art. 7 Abs. 3).',
      },
      {
        key: 'Anfragen',
        value: 'Schreiben Sie an {email}. Wir antworten innerhalb eines Monats.',
      },
      {
        key: 'Beschwerde',
        value:
          'Sie können sich bei der Österreichischen Datenschutzbehörde beschweren: Barichgasse 40–42, 1030 Wien, {dsb}.',
      },
      {
        key: 'Weitere Hinweise',
        value:
          'Sie sind nicht verpflichtet, uns Daten bereitzustellen. Ohne Angaben können wir Anfragen aber nicht beantworten und kein Konto anlegen. Eine automatisierte Entscheidungsfindung nach Art. 22 DSGVO findet nicht statt.',
      },
    ],
  },
};

const en: typeof de = {
  meta: {
    title: 'Privacy',
    description: 'Privacy policy of {name}: controllers, processing, recipients and your rights.',
  },
  hero: {
    title: 'Privacy.',
    text: 'How we process personal data on this website and in {name}. Last updated: 30 October 2026.',
  },
  notice: 'This translation is provided for convenience; the German version is legally binding.',
  responsible: {
    title: 'Controller.',
    rows: [
      { key: 'Controller', value: '{legalEntity}, {street}, {postalCode} {city}, Austria' },
      { key: 'Privacy contact', value: '{email}' },
    ],
  },
  website: {
    title: 'Website.',
    rows: [
      {
        key: 'Visiting the website',
        value:
          'When the website is visited, our hosting provider stores technical data: IP address, date and time, page accessed, browser and operating system. Purpose: secure and stable operation. Legal basis: legitimate interest, Art. 6(1)(f) GDPR. Deletion after [14 days].',
      },
      {
        key: 'Necessary cookies',
        value:
          'To sign in, we set cookies that are technically necessary. Legal basis: § 165(3) TKG 2021 and Art. 6(1)(b) GDPR.',
      },
      {
        key: 'Sign-in status',
        value:
          'While you are signed in to {name}, the application sets the cookie “signed_in” for the whole domain. It holds only the value “1”, no identifier. The website evaluates it only in your browser, to show the button “Open app” instead of “Login”; it is not used to measure reach. It is deleted when you sign out or the session ends. Legal basis: § 165(3) TKG 2021.',
      },
      {
        key: 'Product analytics',
        value:
          'We use PostHog to analyse how the website and software are used, but only if you consent. Legal basis: consent, Art. 6(1)(a) GDPR and § 165(3) TKG 2021. You can withdraw your consent at any time in the [cookie settings]. Storage location: [EU].',
      },
      {
        key: 'Contact and demo requests',
        value:
          'We use your name, e-mail address, office, function, office size, country and message to answer your enquiry. Legal basis: Art. 6(1)(b) GDPR (pre-contractual measures) or Art. 6(1)(f) GDPR. We delete the data once the enquiry has been dealt with, at the latest after [24 months], unless a contract comes into being.',
      },
      {
        key: 'Newsletter',
        value:
          'If you tick the box in the demo request, we will send you news about {name} by e-mail. Legal basis: consent, Art. 6(1)(a) GDPR and § 174 TKG 2021. You can unsubscribe at any time via the link in every e-mail or at {email}.',
      },
      {
        key: 'LinkedIn',
        value:
          'We link to our LinkedIn profile. Data is transmitted only once you click the link. LinkedIn’s privacy policy then applies.',
      },
    ],
  },
  software: {
    title: 'Software {name}.',
    rows: [
      {
        key: 'Account and sign-in',
        value:
          'For accounts we process name, e-mail address, office, role and sign-in times. Sign-in runs through a specialised authentication service. Legal basis: contract, Art. 6(1)(b) GDPR. We delete the data after the end of the contract, unless statutory retention obligations apply.',
      },
      {
        key: 'Project data of the offices',
        value:
          'We process plans, models, documents and questions to {name} on behalf of the office under Art. 28 GDPR. The office is the controller for this data. Which sub-processors we use for this is set out in the data processing agreement with the office. We do not train AI models on your office’s data.',
      },
    ],
  },
  recipients: {
    title: 'Recipients.',
    rows: [
      {
        key: 'Processors',
        value:
          'For the website, enquiries and accounts we use service providers: a hosting provider, an authentication service, a product analytics service and an e-mail service. All of them are bound by contract under Art. 28 GDPR.',
      },
      {
        key: 'Third countries',
        value:
          'Transfers to the USA rely on the adequacy decision for the EU-US Data Privacy Framework (Art. 45 GDPR) where the recipient is certified, and otherwise on standard contractual clauses (Art. 46(2)(c) GDPR).',
      },
      {
        key: 'No disclosure',
        value: 'We do not sell data and do not pass it on for advertising purposes.',
      },
    ],
  },
  rights: {
    title: 'Your rights.',
    rows: [
      {
        key: 'Rights',
        value:
          'You have the right of access (Art. 15 GDPR), rectification (Art. 16), erasure (Art. 17), restriction of processing (Art. 18), data portability (Art. 20) and objection (Art. 21). You can withdraw a consent at any time with effect for the future (Art. 7(3) GDPR).',
      },
      {
        key: 'Requests',
        value: 'Write to {email}. We reply within one month.',
      },
      {
        key: 'Complaints',
        value:
          'You can lodge a complaint with the Austrian Data Protection Authority: Barichgasse 40–42, 1030 Vienna, {dsb}.',
      },
      {
        key: 'Further information',
        value:
          'You are not obliged to provide us with data. Without these details, however, we cannot answer enquiries or create an account. No automated decision-making within the meaning of Art. 22 GDPR takes place.',
      },
    ],
  },
};

export default { de, en };
