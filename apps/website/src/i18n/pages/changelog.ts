/**
 * Copy of the changelog page, both locales. The notes themselves are product data from
 * src/data/changelog.json (generated, see src/lib/changelog.ts); this is the frame around them.
 * `{name}` is the brand name, filled by `withName`;
 */
const de = {
  meta: {
    title: 'Neuerungen',
    description:
      'Was sich in {name} geändert hat: neue Funktionen, Verbesserungen und behobene Fehler, Woche für Woche.',
  },
  hero: {
    title: 'Neuerungen.',
    text: 'Was sich in {name} geändert hat, Woche für Woche.',
  },
  formerName: 'Einträge aus der Zeit vor der Umbenennung nennen {name} bei seinem früheren Namen.',
  unreleased: 'In Kürze',
  empty: 'Noch keine Einträge. Die erste Änderung erscheint hier, sobald sie ausgeliefert ist.',
};

const en: typeof de = {
  meta: {
    title: 'What’s new',
    description: 'What changed in {name}: new features, improvements and fixes, week by week.',
  },
  hero: {
    title: 'What’s new.',
    text: 'What changed in {name}, week by week.',
  },
  formerName: 'Entries from before the rename call {name} by its former name.',
  unreleased: 'Coming up',
  empty: 'No entries yet. The first change appears here as soon as it ships.',
};

export default { de, en };
