import { describe, expect, test } from 'bun:test';
import { getReleases, releaseAnchor, releaseTitle, sectionTitle, type ChangelogData, type ChangelogRelease } from './changelog';

const week: ChangelogRelease = {
  id: '2026-W44',
  kind: 'week',
  version: null,
  date: '2026-10-26',
  dateEnd: '2026-11-01',
  summary: null,
  sections: [{ key: 'features', notes: [{ en: 'A note.', de: 'Eine Notiz.' }] }],
};

describe('changelog', () => {
  test('a week is titled by its date range, in the reader’s language', () => {
    expect(releaseTitle(week, 'de', 'In Kürze')).toBe('26. Oktober – 1. November 2026');
    expect(releaseTitle(week, 'en', 'Coming up')).toBe('26 October – 1 November 2026');
  });

  test('a tagged version is titled by its version, an undated release by the given label', () => {
    expect(releaseTitle({ ...week, kind: 'version', version: '1.2.0', dateEnd: null }, 'de', 'x')).toBe('1.2.0');
    expect(releaseTitle({ ...week, date: null, dateEnd: null }, 'en', 'Coming up')).toBe('Coming up');
  });

  test('sections show the publisher’s title, unknown keys as written', () => {
    const data: ChangelogData = { sectionTitles: { fixes: { en: 'Fixes', de: 'Fehlerbehebungen' } }, releases: [week] };
    expect(sectionTitle('fixes', 'de', data)).toBe('Fehlerbehebungen');
    expect(sectionTitle('other', 'en', data)).toBe('other');
  });

  test('anchors keep the old site’s form, so shared links still land', () => {
    expect(releaseAnchor(week)).toBe('r-2026-W44');
  });

  test('the committed data has releases, newest first, each note in both languages', () => {
    const releases = getReleases();
    expect(releases.length).toBeGreaterThan(0);
    const dates = releases.map((r) => r.date ?? '9999');
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const release of releases)
      for (const section of release.sections)
        for (const note of section.notes) {
          expect(note.de.length).toBeGreaterThan(0);
          expect(note.en.length).toBeGreaterThan(0);
        }
  });
});
