/**
 * What an imported mail's folder, its files and its E-Mail-Verlauf are called
 * (ADR-0085, DECISION D33). Pure.
 *
 * **No subject in a name.** A folder name and a filename become storage keys,
 * audit targets and search titles, and a subject is the one header that carries
 * content ("Kündigung Frau M.", "Befund Statik"). So names carry only the date
 * and a party, as the project mail inbox (#831) decided; the subject is
 * inside the Verlauf, which is a document like any other and goes where
 * documents go. A Verlauf the import opens is named after the conversation's
 * other party and its day, `{Gegenüber} {yyyy-mm-dd}`: no person confirmed a
 * subject, so ADR-0085 §6 forbids it here, where an address's Verlauf may take
 * the subject a person confirmed (D11).
 *
 * **Names are unique per project, not per folder.** A document is identified by
 * its filename across the whole project (`uniq_documents_live_name_per_collection`),
 * so two mails' `Rechnung.pdf` would be one document with two versions. Every
 * file of a mail is therefore prefixed with the mail's own folder name, and the
 * filer numbers whatever still collides.
 */

import { normalizeFolderName } from '@/lib/projects/folders'

const VIENNA = 'Europe/Vienna'
const MAX_FOLDER_NAME = 120
const MAX_FILENAME = 240

export interface MailAddress {
  name: string
  address: string
}

/** `2026-09-30 10.15`, Vienna time. Dots, not a colon: the name is also a path segment. */
export function mailTimestamp(iso: string | null): string {
  if (!iso) return 'ohne Datum'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'ohne Datum'
  const parts = new Intl.DateTimeFormat('de-AT', {
    timeZone: VIENNA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}.${part('minute')}`
}

/** The mail's folder: `<date time> – <sender>`. */
export function mailFolderName(when: string | null, sender: MailAddress | null): string {
  const stamp = mailTimestamp(when)
  const who = cleanSegment(sender?.name || sender?.address || '') || 'Unbekannt'
  return `${stamp} – ${who}`.slice(0, MAX_FOLDER_NAME).trim()
}

/**
 * `name`, `name (2)`, `name (3)`: the n-th candidate for a folder name that may
 * be taken, still within the folder-name limit once the number is on it.
 */
export function numbered(name: string, n: number): string {
  if (n <= 1) return name
  const suffix = ` (${n})`
  return `${name.slice(0, MAX_FOLDER_NAME - suffix.length).trim()}${suffix}`
}

/**
 * As {@link numbered}, with the number before the extension (`Plan (2).pdf`),
 * and still within the filename bound once the number is on it.
 */
export function numberedFilename(filename: string, n: number): string {
  if (n <= 1) return filename
  const suffix = ` (${n})`
  const dot = filename.lastIndexOf('.')
  const extension = dot > 0 && filename.length - dot <= 12 ? filename.slice(dot) : ''
  const stem = extension ? filename.slice(0, dot) : filename
  return `${stem.slice(0, MAX_FILENAME - suffix.length - extension.length).trim()}${suffix}${extension}`
}

/** Names `validateFolderName` refuses (the old DOS devices), which an Outlook folder may still carry. */
const RESERVED = new Set(['con', 'prn', 'aux', 'nul'])

/**
 * Outlook folder levels mirrored as project folders. Folder creation takes paths
 * of at most twelve segments (`MAX_ENSURE_DEPTH`); anything deeper is folded
 * into the last one, `Projekte – 2019 – Nord`, so a deep tree still files.
 */
const MAX_OUTLOOK_DEPTH = 12

/** The project folder path that mirrors an Outlook folder path. */
export function outlookFolderPath(segments: readonly string[]): string {
  const names = segments.map(outlookFolderName)
  if (names.length <= MAX_OUTLOOK_DEPTH) return names.join('/')
  const kept = names.slice(0, MAX_OUTLOOK_DEPTH - 1)
  const folded = outlookFolderName(names.slice(MAX_OUTLOOK_DEPTH - 1).join(' – '))
  return [...kept, folded].join('/')
}

/** An Outlook folder's name as a project folder name. */
export function outlookFolderName(raw: string): string {
  const name = cleanSegment(raw).slice(0, MAX_FOLDER_NAME).trim() || 'Ordner'
  return RESERVED.has(name.toLowerCase()) || /^\.+$/.test(name) ? `${name}_` : name
}

/** An attachment's filename: the mail's folder name, then the file's own name. */
export function attachmentFilename(mailFolder: string, original: string): string {
  const name = cleanSegment(original) || 'Anhang'
  const full = `${mailFolder} – ${name}`
  if (full.length <= MAX_FILENAME) return full
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
  return `${full.slice(0, MAX_FILENAME - extension.length).trim()}${extension}`
}

/** The archive's own name, without its extension, as the import's top folder. */
export function archiveFolderName(filename: string): string {
  const stem = filename.replace(/\.(pst|ost)$/i, '')
  return outlookFolderName(stem) || 'Outlook-Archiv'
}

/** The longest party name a Verlauf's name carries; the date and a number follow it. */
const MAX_PARTY_NAME = 120

/**
 * An E-Mail-Verlauf the archive import opens (D33): `{Gegenüber} {yyyy-mm-dd}`,
 * the conversation's other party, by name, else by address, else `unknown` (the
 * thread's locale's word), and the day of the mail that opened it, Vienna. The
 * caller makes it a filename (`threadDocumentFilename`) and numbers it when the
 * project already holds that name.
 */
export function archiveThreadName(party: MailAddress | null, at: Date, unknown: string): string {
  const who = cleanSegment(party?.name || party?.address || '').slice(0, MAX_PARTY_NAME).trim() || unknown
  const stamp = mailTimestamp(at.toISOString())
  const day = stamp === 'ohne Datum' ? '' : stamp.slice(0, 10)
  return day ? `${who} ${day}` : who
}

/**
 * Runs of white space as one space. The separators JavaScript's `\s` misses but
 * Python's `splitlines()` ends a line at (`\x1c`–`\x1e`, `\x85`) count too:
 * a name is printed into a Verlauf's rendition, which the chunker reads with
 * Python, so a name that is one line here must be one line there.
 */
function oneLine(value: string): string {
  return value.replace(/[\s\x1c-\x1f\x85]+/g, ' ').trim()
}

/** One name segment: no separators, no control characters, one Unicode form. */
function cleanSegment(raw: string): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\]/g, '-')
  return normalizeFolderName(oneLine(flat))
}
