/**
 * Copy of the privacy policy, both locales. `{name}` is the brand name, filled by
 * `withName`. `{legalEntity}`, `{street}`, `{postalCode}`, `{city}` are filled from
 * identity, and `{email}` and `{dsb}` become links, all by the view. Text and labels only.
 *
 * The analytics rows describe exactly what `runtime/web-analytics.mjs` configures
 * (PostHog EU, cookieless until consent, `opt_in_capturing` on "Accept", replay
 * with every input and text masked, Do Not Track honoured) and what the PostHog
 * project is set to (read 2026-10-29: IP addresses discarded, replay kept 30
 * days and recorded only on its triggers, cookieless server hash mode to be
 * "stateful"). The storage keys are the ones posthog-js writes (README,
 * "Analytics"). Change them together.
 *
 * "(vormals Piloti)" / "(formerly Piloti)" is deliberate (owner decision D23):
 * the former name, once, for legal continuity. It is the one place it may stay.
 *
 * A row with `when: 'linkedin'` is shown only while a LinkedIn URL is set
 * (`src/lib/social.ts`).
 *
 * TODO(owner): three values could not be read from configuration and are worded
 * without a number until legal review fills them in:
 * 1. Server log retention ("Aufruf der Website"): deploy/ configures no access-log
 *    retention for the website; confirm what the hosting provider and the cluster
 *    keep, and for how long.
 * 2. Analytics retention ("Reichweitenmessung"): the PostHog plan's retention
 *    for events is not readable without billing access. The app's own notice
 *    says 12 months for its events; confirm and align both.
 * 3. Enquiries ("Kontakt- und Demoanfragen"): no deletion period is defined
 *    for the sales inbox.
 * Also for legal review: legitimate interest as the basis for the cookieless
 * counting before a choice.
 */
const de = {
  meta: {
    title: 'Datenschutz',
    description: 'Datenschutzerklärung von {name}: Verantwortliche, Verarbeitungen, Empfänger und Ihre Rechte.',
  },
  hero: {
    title: 'Datenschutz.',
    text: 'Wie wir personenbezogene Daten auf dieser Website und in {name} (vormals Piloti) verarbeiten. Stand: 30.10.2026.',
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
          'Beim Aufruf werden technische Daten verarbeitet: IP-Adresse, Datum und Uhrzeit, aufgerufene Seite, Browser und Betriebssystem. Zweck: sicherer und stabiler Betrieb. Rechtsgrundlage: berechtigtes Interesse, Art. 6 Abs. 1 lit. f DSGVO. Wir speichern diese Daten nur so lange, wie es für diesen Zweck nötig ist.',
      },
      {
        key: 'Reichweitenmessung ohne Cookies',
        value:
          'Mit PostHog messen wir, wie die Website genutzt wird: aufgerufene Seiten, Verweildauer und Scrolltiefe, Klicks und ihre Position auf der Seite, abgeschickte Formulare und gestartete Videos, Ladezeiten und technische Fehler, die verweisende Seite und Kampagnenangaben in der Adresse, Gerätetyp und Browser. Was Sie in Formularfelder eingeben, erfassen wir nicht. Solange Sie nicht zugestimmt haben, geschieht das ohne Cookies und ohne Speicher in Ihrem Browser: Um Besuche zu zählen, bildet PostHog aus IP-Adresse, Browserangaben und einem täglich wechselnden Zufallswert eine Kennung. Die IP-Adresse selbst wird nicht gespeichert, und wir verknüpfen die Daten nicht mit Ihrer Person. Sendet Ihr Browser „Do Not Track“, messen wir nichts. Rechtsgrundlage: berechtigtes Interesse an einer verständlichen und gut funktionierenden Website, Art. 6 Abs. 1 lit. f DSGVO. Anbieter: PostHog, Inc., Speicherort: EU. Wir speichern die Daten nur so lange, wie wir sie für die Auswertung brauchen.',
      },
      {
        key: 'Mit Ihrer Zustimmung',
        value:
          'Stimmen Sie im Hinweis zu Cookies zu, setzt PostHog das Cookie „ph_<Projektschlüssel>_posthog“ für die ganze Domain und legt denselben Eintrag im lokalen Speicher ab, gültig 365 Tage; für die laufende Sitzung kommen zwei Einträge im Sitzungsspeicher hinzu („ph_<Projektschlüssel>_posthog“, „ph_<Projektschlüssel>_window_id“). Es enthält eine zufällige Kennung, sodass wir Ihre Besuche über mehrere Tage als einen erkennen. Bei Fehlern oder wiederholten, ins Leere gehenden Klicks kann PostHog dann die Sitzung aufzeichnen; dabei sind alle Eingaben und alle Texte der Seite unkenntlich gemacht. Aufzeichnungen löschen wir nach 30 Tagen. Rechtsgrundlage: Einwilligung, Art. 6 Abs. 1 lit. a DSGVO und § 165 Abs. 3 TKG 2021. Sie können die Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen, über „Cookie-Einstellungen“ am Ende jeder Seite.',
      },
      {
        key: 'Ihre Wahl',
        value:
          'Damit wir nicht bei jedem Besuch erneut fragen, speichert PostHog Ihre Wahl („Akzeptieren“ oder „Ablehnen“) im lokalen Speicher Ihres Browsers unter „__ph_opt_in_out_<Projektschlüssel>“. Der Eintrag enthält nur diese Wahl. Rechtsgrundlage: § 165 Abs. 3 TKG 2021, weil er für den Dienst nötig ist, den Sie mit Ihrer Wahl anfordern.',
      },
      {
        key: 'Anmeldestatus',
        value:
          'Solange Sie in {name} angemeldet sind, setzt die Anwendung das Cookie „signed_in“ für die ganze Domain. Es enthält nur den Wert „1“, keine Kennung. Die Website wertet es nur in Ihrem Browser aus, um statt „Login“ die Schaltfläche „App öffnen“ zu zeigen; für die Reichweitenmessung wird es nicht verwendet. Bei der Abmeldung oder wenn die Sitzung abläuft, wird es gelöscht. Rechtsgrundlage: § 165 Abs. 3 TKG 2021.',
      },
      {
        key: 'Kontakt- und Demoanfragen',
        value:
          'Die Formulare senden nichts an uns: Beim Absenden öffnet sich Ihr E-Mail-Programm mit einer vorbereiteten Nachricht, die Sie selbst abschicken. Was Sie uns so schreiben (Name, E-Mail-Adresse, Büro, Funktion, Bürogröße, Land, Nachricht), verwenden wir, um Ihre Anfrage zu beantworten. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (vorvertragliche Maßnahmen) bzw. lit. f. Kommt kein Vertrag zustande, löschen wir die Angaben, wenn die Anfrage erledigt ist und keine Aufbewahrungspflicht besteht.',
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
        when: 'linkedin' as const,
      },
    ],
  },
  software: {
    title: 'Software {name}.',
    rows: [
      {
        key: 'Konto und Anmeldung',
        value:
          'Für Konten verarbeiten wir Name, E-Mail-Adresse, Büro, Rolle und Anmeldezeitpunkte. Die Anmeldung läuft über einen spezialisierten Anmeldedienst und setzt technisch notwendige Cookies. Rechtsgrundlage: Vertrag, Art. 6 Abs. 1 lit. b DSGVO, für die Cookies § 165 Abs. 3 TKG 2021. Löschung nach Vertragsende, soweit keine gesetzlichen Aufbewahrungspflichten bestehen.',
      },
      {
        key: 'Produktanalyse in {name}',
        value:
          'In der Anwendung selbst setzen wir PostHog anders ein als auf dieser Website. Was dort erfasst wird und wie Sie es abschalten, steht in den Datenschutzhinweisen in {name}.',
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
    text: 'How we process personal data on this website and in {name} (formerly Piloti). Last updated: 30 October 2026.',
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
          'When the website is visited, technical data is processed: IP address, date and time, page accessed, browser and operating system. Purpose: secure and stable operation. Legal basis: legitimate interest, Art. 6(1)(f) GDPR. We keep this data only as long as this purpose requires.',
      },
      {
        key: 'Audience measurement without cookies',
        value:
          'We use PostHog to measure how the website is used: pages viewed, time on page and scroll depth, clicks and where on the page they land, forms sent and videos started, loading times and technical errors, the referring page and campaign details in the address, device type and browser. We do not record what you type into form fields. As long as you have not consented, this happens without cookies and without storage in your browser: to count visits, PostHog derives an identifier from the IP address, browser details and a random value that changes every day. The IP address itself is not stored, and we do not link the data to you as a person. If your browser sends “Do Not Track”, we measure nothing. Legal basis: legitimate interest in a clear and well-functioning website, Art. 6(1)(f) GDPR. Provider: PostHog, Inc., storage location: EU. We keep the data only as long as we need it for the analysis.',
      },
      {
        key: 'With your consent',
        value:
          'If you accept in the cookie note, PostHog sets the cookie “ph_<project key>_posthog” for the whole domain and stores the same entry in local storage, valid for 365 days; for the current session two entries are added to session storage (“ph_<project key>_posthog”, “ph_<project key>_window_id”). It holds a random identifier, so that we recognise your visits across several days as one. On errors or repeated clicks that lead nowhere, PostHog may then record the session; every input and every text on the page is masked. We delete recordings after 30 days. Legal basis: consent, Art. 6(1)(a) GDPR and § 165(3) TKG 2021. You can withdraw your consent at any time with effect for the future, through “Cookie settings” at the bottom of every page.',
      },
      {
        key: 'Your choice',
        value:
          'So that we do not ask again on every visit, PostHog stores your choice (“Accept” or “Decline”) in your browser’s local storage under “__ph_opt_in_out_<project key>”. The entry holds only that choice. Legal basis: § 165(3) TKG 2021, because it is needed for the service you request with your choice.',
      },
      {
        key: 'Sign-in status',
        value:
          'While you are signed in to {name}, the application sets the cookie “signed_in” for the whole domain. It holds only the value “1”, no identifier. The website evaluates it only in your browser, to show the button “Open app” instead of “Login”; it is not used to measure reach. It is deleted when you sign out or the session ends. Legal basis: § 165(3) TKG 2021.',
      },
      {
        key: 'Contact and demo requests',
        value:
          'The forms send nothing to us: sending opens your e-mail program with a prepared message that you send yourself. We use what you write to us this way (name, e-mail address, office, function, office size, country, message) to answer your enquiry. Legal basis: Art. 6(1)(b) GDPR (pre-contractual measures) or Art. 6(1)(f) GDPR. If no contract comes into being, we delete the details once the enquiry has been dealt with and no retention obligation applies.',
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
        when: 'linkedin' as const,
      },
    ],
  },
  software: {
    title: 'Software {name}.',
    rows: [
      {
        key: 'Account and sign-in',
        value:
          'For accounts we process name, e-mail address, office, role and sign-in times. Sign-in runs through a specialised authentication service and sets cookies that are technically necessary. Legal basis: contract, Art. 6(1)(b) GDPR, and § 165(3) TKG 2021 for the cookies. We delete the data after the end of the contract, unless statutory retention obligations apply.',
      },
      {
        key: 'Product analytics in {name}',
        value:
          'Inside the application we use PostHog differently from this website. What is recorded there and how to switch it off is set out in the privacy notice in {name}.',
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
