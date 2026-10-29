/**
 * Copy of the contact page, both locales. `{name}` is the brand name, filled by
 * `withName`; `{street}`, `{postalCode}` and `{city}` are filled from identity
 * by the view. Labels and text only: the form and the address block live in
 * `src/views/ContactView.astro`.
 */
const de = {
  meta: {
    title: 'Kontakt',
    description: 'Kontakt zu {name}: E-Mail, Adresse und Nachrichtenformular.',
  },
  hero: {
    title: 'Kontakt.',
    text: 'Fragen zu {name}, zu einem Pilotprojekt oder zur Zusammenarbeit? Schreiben Sie uns.',
  },
  info: {
    email: 'E-Mail',
    address: 'Adresse',
    addressValue: '{street}, {postalCode} {city}, Österreich',
    linkedin: 'LinkedIn',
    linkedinValue: '{name} auf LinkedIn',
    demoLead: 'Sie möchten {name} in Ihrem Büro sehen?',
  },
  form: {
    name: 'Name *',
    email: 'E-Mail *',
    emailPlaceholder: 'name@buero.at',
    office: 'Büro',
    officePlaceholder: 'Name des Planungsbüros',
    message: 'Nachricht *',
    noteBefore:
      'Pflichtfelder sind mit * markiert. Beim Absenden öffnet sich Ihr E-Mail-Programm mit einer vorbereiteten Nachricht an uns. Wir verwenden Ihre Angaben nur, um Ihre Anfrage zu beantworten. Mehr dazu in der',
    noteLink: 'Datenschutzerklärung',
    noteAfter: '.',
    submit: 'Nachricht senden',
    subject: 'Kontaktanfrage über die Website: {office}',
    sent: {
      title: 'Ihre Nachricht liegt in Ihrem E-Mail-Programm bereit.',
      text: 'Wir haben Ihre Angaben in eine E-Mail an uns übernommen. Senden Sie sie dort ab, dann antworten wir Ihnen.',
      fallback: 'Hat sich kein E-Mail-Programm geöffnet? Schreiben Sie uns direkt an',
      edit: 'Angaben bearbeiten',
    },
  },
};

const en: typeof de = {
  meta: {
    title: 'Contact',
    description: 'Contact {name}: e-mail, address and message form.',
  },
  hero: {
    title: 'Contact.',
    text: 'Questions about {name}, a pilot project or working together? Write to us.',
  },
  info: {
    email: 'E-Mail',
    address: 'Address',
    addressValue: '{street}, {postalCode} {city}, Austria',
    linkedin: 'LinkedIn',
    linkedinValue: '{name} on LinkedIn',
    demoLead: 'Would you like to see {name} in your office?',
  },
  form: {
    name: 'Name *',
    email: 'E-Mail *',
    emailPlaceholder: 'name@office.at',
    office: 'Office',
    officePlaceholder: 'Name of the planning firm',
    message: 'Message *',
    noteBefore:
      'Required fields are marked with *. Sending opens your e-mail program with a prepared message to us. We use your details only to answer your enquiry. More on this in the',
    noteLink: 'privacy policy',
    noteAfter: '.',
    submit: 'Send message',
    subject: 'Enquiry via the website: {office}',
    sent: {
      title: 'Your message is ready in your e-mail program.',
      text: 'We have put your details into an e-mail to us. Send it from there, and we will reply.',
      fallback: 'No e-mail program opened? Write to us directly at',
      edit: 'Edit details',
    },
  },
};

export default { de, en };
