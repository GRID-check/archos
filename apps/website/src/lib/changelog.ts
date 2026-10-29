import changelog from '../data/changelog.json';
import type { Locale } from '../i18n/paths';

/**
 * The changelog shown at /changelog/ and /en/changelog/.
 *
 * `src/data/changelog.json` is GENERATED: `scripts/release_notes.py publish` reads the reno notes in
 * `releasenotes/notes/`, translates new sentences into German once, and the release-notes workflow
 * commits the result on every merge to `develop`. Nothing here reads git or calls a translator at build
 * time, which keeps the web image build hermetic. Never edit the JSON by hand; write a reno note.
 * See docs/contributing/release-notes.md.
 */

/** One string in both site languages. */
export interface Bilingual {
  en: string;
  de: string;
}

export interface ChangelogSection {
  /** Section key from releasenotes/config.yaml: `features`, `improvements`, `fixes`, ... */
  key: string;
  notes: Bilingual[];
}

export interface ChangelogRelease {
  /** A tag (`1.2.0`) or, while nothing is tagged, the ISO week the notes shipped in (`2026-W39`). */
  id: string;
  kind: 'version' | 'week';
  version: string | null;
  /** A week's Monday, or a version's ship date. Null only in a local preview of unmerged notes. */
  date: string | null;
  /** A week's Sunday; null for a version. */
  dateEnd: string | null;
  /** The editorial summary of the week (releasenotes/summaries.yaml), shown above its notes. */
  summary: Bilingual | null;
  sections: ChangelogSection[];
}

export interface ChangelogData {
  sectionTitles: Record<string, Bilingual>;
  releases: ChangelogRelease[];
}

const data = changelog as ChangelogData;

/** Every release, newest first, as the publisher wrote them. */
export function getReleases(source: ChangelogData = data): ChangelogRelease[] {
  return source.releases;
}

/** The display title of a section, e.g. `features` is "Neue Funktionen". Unknown keys show as written. */
export function sectionTitle(key: string, locale: Locale, source: ChangelogData = data): string {
  return source.sectionTitles[key]?.[locale] ?? key;
}

/**
 * The heading of one release: its version when the repository tagged one, otherwise the week the
 * notes shipped in as a date range ("26. Oktober – 1. November 2026"). A release without a date
 * exists only in a local preview; the caller passes the label for it.
 */
export function releaseTitle(release: ChangelogRelease, locale: Locale, unreleasedLabel: string): string {
  if (release.kind === 'version' && release.version) return release.version;
  if (!release.date) return unreleasedLabel;
  const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'de-AT', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const start = new Date(`${release.date}T00:00:00Z`);
  if (!release.dateEnd) return format.format(start);
  return format.formatRange(start, new Date(`${release.dateEnd}T00:00:00Z`));
}

/** The anchor a release is linked by (`#r-2026-W44`); the old site used the same, so old links still land. */
export const releaseAnchor = (release: ChangelogRelease): string => `r-${release.id}`;
