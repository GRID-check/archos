import { getReleases, type ChangelogRelease } from '../../lib/changelog'
import type { Locale } from '../../i18n/ui'

/**
 * The notes the week 41 launch page shows. A note is never typed out here: each
 * pick is the start of the note's English text, and the page reads the note from
 * src/data/changelog.json in its own locale, exactly as written there.
 *
 * A start that matches no note, or more than one, fails the build. That is on
 * purpose: after the release data changes, the page must not quietly show other
 * notes under the headings it has.
 *
 * A row is one feature. Its second text, when there is one, is the note that
 * qualifies it (the dictation row carries the note on the external provider).
 */
const RELEASE_ID = '2026-W41'

export const THEMES = [
  {
    id: 'projects',
    rows: [
      ['You can now close a finished project in its settings.'],
      ['When you close a project, Piloti now proposes which files'],
      ['You can now pause a project that is waiting'],
      ['Each project now has a Steckbrief in its settings'],
    ],
  },
  {
    id: 'knowledge',
    rows: [
      ['A project now has a page of similar past projects'],
      ["Piloti now looks into the office's past projects on its own"],
      ['A source from another project is now labelled as a precedent'],
      ['Piloti now remembers what authorities demanded in your past Bescheide'],
    ],
  },
  {
    id: 'access',
    rows: [
      ['Your office can now build its own roles in Piloti'],
      ["A folder's own access list now names people instead of roles"],
      ['Organisation admins can now see who downloaded which document'],
      ['A chat whose answers drew on a folder not everyone may read'],
    ],
  },
  {
    id: 'review',
    rows: [
      ['You can request release of a file in quarantine'],
      ['Your office now decides what must not be uploaded'],
      ['The terms and number checks your office sets now also cover what you type into the chat'],
      ['You can now dictate a question', 'When your office checks chat messages for sensitive data'],
    ],
  },
  {
    id: 'files',
    rows: [
      ['The Archiv now has folders'],
      ['A document is now one entry'],
      ['You can import an Outlook archive'],
      ['Two revisions can be compared side by side'],
    ],
  },
  {
    id: 'chat',
    rows: [
      ['An answer now appears calmly where you are reading'],
      ['You can write your next question while Piloti is still answering'],
      ['After you mark an answer as not helpful'],
      ['The effort slider now warns when it is set to Maximum'],
    ],
  },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

function release(): ChangelogRelease {
  const found = getReleases().find((r) => r.id === RELEASE_ID)
  if (!found) throw new Error(`launch: ${RELEASE_ID} is not in src/data/changelog.json`)
  return found
}

function noteText(r: ChangelogRelease, start: string, locale: Locale): string {
  const hits = r.sections.flatMap((s) => s.notes).filter((n) => n.en.startsWith(start))
  if (hits.length !== 1) {
    throw new Error(`launch: ${hits.length} notes in ${RELEASE_ID} start with "${start}", expected one`)
  }
  const text = hits[0][locale]
  if (!text) throw new Error(`launch: the ${locale} text of "${start}" is empty in ${RELEASE_ID}`)
  return text
}

export function launchThemes(locale: Locale): { id: ThemeId; rows: string[][] }[] {
  const r = release()
  return THEMES.map(({ id, rows }) => ({
    id,
    rows: rows.map((row) => row.map((start) => noteText(r, start, locale))),
  }))
}

/** Every upgrade note of the week, in the locale: the section the release data files them under. */
export function launchUpgradeNotes(locale: Locale): string[] {
  const section = release().sections.find((s) => s.key === 'upgrade')
  if (!section?.notes.length) throw new Error(`launch: ${RELEASE_ID} has no upgrade notes`)
  return section.notes.map((n) => {
    if (!n[locale]) throw new Error(`launch: an upgrade note of ${RELEASE_ID} has no ${locale} text`)
    return n[locale]
  })
}
