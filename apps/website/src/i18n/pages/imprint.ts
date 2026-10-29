/**
 * Copy of the imprint, both locales. `{name}` is the brand name, filled by
 * `withName`; `{legalEntity}`, `{street}`, `{postalCode}`, `{city}` and
 * `{email}` are filled from identity by the view. Text and labels only.
 */
const de = {
  meta: {
    title: 'Impressum',
    description: 'Impressum von {name}: Unternehmensangaben und Offenlegung.',
  },
  hero: {
    title: 'Impressum.',
    text: 'Angaben nach § 5 E-Commerce-Gesetz und § 14 Unternehmensgesetzbuch, Offenlegung nach § 25 Mediengesetz.',
  },
  notice: '',
  company: {
    title: 'Unternehmen.',
    company: 'Firma',
    legalForm: 'Rechtsform',
    legalFormValue: 'Flexible Kapitalgesellschaft (FlexCo), in Gründung',
    seat: 'Sitz',
    address: 'Anschrift',
    addressValue: '{street}, {postalCode} {city}, Österreich',
    register: 'Firmenbuch',
    registerValue:
      'Noch nicht eingetragen. Firmenbuchnummer, Firmenbuchgericht und UID-Nummer ergänzen wir nach der Eintragung.',
    purpose: 'Unternehmensgegenstand',
    purposeValue: 'Entwicklung und Betrieb von Software für Architektur- und Planungsbüros.',
  },
  contact: {
    title: 'Kontakt.',
    email: 'E-Mail',
  },
  management: {
    title: 'Geschäftsführung.',
    label: 'Geschäftsführer',
    value: 'Jonathan Uhlemann, Ferdinand Rubenbauer, Matthias Bigl',
  },
  disclosure: {
    title: 'Offenlegung.',
    owner: 'Medieninhaber',
    ownerValue: '{legalEntity}, {city}',
    direction: 'Grundlegende Richtung',
    directionValue: 'Information über die Software {name} sowie Beiträge zu Planung, Baurecht und Technologie.',
  },
  notes: {
    title: 'Hinweise.',
    content: 'Inhalte',
    contentValue:
      'Wir erstellen die Inhalte dieser Website mit Sorgfalt, übernehmen aber keine Gewähr für Vollständigkeit und Aktualität. Für Inhalte verlinkter Websites sind deren Betreiber verantwortlich.',
    images: 'Bilder',
    imagesValue: 'Einzelne Bilder sind mit KI erzeugt und mit „AI“ gekennzeichnet.',
    funding: 'Förderung',
    fundingValue: '{name} wird gefördert von der aws – Austria Wirtschaftsservice.',
  },
};

const en: typeof de = {
  meta: {
    title: 'Imprint',
    description: 'Imprint of {name}: company details and disclosure.',
  },
  hero: {
    title: 'Imprint.',
    text: 'Information pursuant to § 5 of the Austrian E-Commerce Act (ECG) and § 14 of the Austrian Companies Act (UGB), disclosure pursuant to § 25 of the Austrian Media Act (MedienG).',
  },
  notice: 'This translation is provided for convenience; the German version is legally binding.',
  company: {
    title: 'Company.',
    company: 'Company name',
    legalForm: 'Legal form',
    legalFormValue: 'Flexible company (FlexCo), in formation',
    seat: 'Registered seat',
    address: 'Address',
    addressValue: '{street}, {postalCode} {city}, Austria',
    register: 'Company register',
    registerValue:
      'Not yet registered. We will add the company register number, the competent company register court and the VAT ID number (UID) after registration.',
    purpose: 'Business purpose',
    purposeValue: 'Development and operation of software for architecture and planning firms.',
  },
  contact: {
    title: 'Contact.',
    email: 'E-Mail',
  },
  management: {
    title: 'Management.',
    label: 'Managing directors',
    value: 'Jonathan Uhlemann, Ferdinand Rubenbauer, Matthias Bigl',
  },
  disclosure: {
    title: 'Disclosure.',
    owner: 'Media owner',
    ownerValue: '{legalEntity}, {city}',
    direction: 'Editorial direction',
    directionValue: 'Information about the software {name} and articles on planning, building law and technology.',
  },
  notes: {
    title: 'Notes.',
    content: 'Content',
    contentValue:
      'We prepare the content of this website with care, but accept no liability for its completeness or accuracy. The operators of linked websites are responsible for the content of those sites.',
    images: 'Images',
    imagesValue: 'Some images are generated with AI and marked “AI”.',
    funding: 'Funding',
    fundingValue: '{name} is funded by aws – Austria Wirtschaftsservice.',
  },
};

export default { de, en };
