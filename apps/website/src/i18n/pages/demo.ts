/**
 * Copy of the demo page, both locales. `{name}` is the brand name, filled by
 * `withName`. Text, labels and option values only: the form's field names, the
 * mailto target and the page's structure live in `src/views/DemoView.astro`.
 * The option values are what the sales inbox reads, so they follow the locale.
 */
const de = {
  title: 'Demo anfragen',
  description: 'Sehen Sie, wie Planungsbüros mit {name} arbeiten.',
  heading: 'Sehen Sie, wie Planungsbüros mit {name} arbeiten.',
  lead: 'Wir zeigen Ihnen {name} an einem echten Projekt und beantworten Ihre Fragen.',
  form: {
    firstName: 'Vorname *',
    firstNamePlaceholder: 'Vorname',
    lastName: 'Nachname *',
    lastNamePlaceholder: 'Nachname',
    email: 'Geschäftliche E-Mail *',
    emailPlaceholder: 'name@buero.at',
    office: 'Büro *',
    officePlaceholder: 'Name des Planungsbüros',
    role: 'Funktion *',
    rolePlaceholder: 'z. B. Projektleitung',
    officeSize: 'Bürogröße *',
    officeSizes: ['1–5 Mitarbeitende', '6–20 Mitarbeitende', '21–50 Mitarbeitende', '51–200 Mitarbeitende', 'Über 200 Mitarbeitende'],
    country: 'Land *',
    countries: ['Österreich', 'Deutschland', 'Schweiz', 'Anderes Land'],
    selectPlaceholder: 'Auswählen …',
    newsletter: 'Ja, ich möchte Neuigkeiten zu {name} per E-Mail erhalten. Abmeldung jederzeit möglich.',
    submit: 'Demo anfragen',
  },
  privacyNote: {
    before: 'Wie wir Ihre Angaben verarbeiten, steht in der ',
    link: 'Datenschutzerklärung',
    after: '.',
  },
  backToWebsite: 'Zur Website',
};

const en: typeof de = {
  title: 'Request a demo',
  description: 'See how planning offices work with {name}.',
  heading: 'See how planning offices work with {name}.',
  lead: 'We will show you {name} on a real project and answer your questions.',
  form: {
    firstName: 'First name *',
    firstNamePlaceholder: 'First name',
    lastName: 'Last name *',
    lastNamePlaceholder: 'Last name',
    email: 'Business email *',
    emailPlaceholder: 'name@office.com',
    office: 'Office *',
    officePlaceholder: 'Name of the planning office',
    role: 'Role *',
    rolePlaceholder: 'e.g. project lead',
    officeSize: 'Office size *',
    officeSizes: ['1–5 employees', '6–20 employees', '21–50 employees', '51–200 employees', 'More than 200 employees'],
    country: 'Country *',
    countries: ['Austria', 'Germany', 'Switzerland', 'Other country'],
    selectPlaceholder: 'Select …',
    newsletter: 'Yes, I would like to receive news about {name} by email. You can unsubscribe at any time.',
    submit: 'Request a demo',
  },
  privacyNote: {
    before: 'How we process your details is set out in our ',
    link: 'privacy policy',
    after: '.',
  },
  backToWebsite: 'Back to website',
};

export default { de, en };
