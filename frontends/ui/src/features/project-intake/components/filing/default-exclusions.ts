/**
 * Which folders of a project folder Piloti proposes to leave out before the
 * upload: backups, old states, temporary and system folders (ticket 26, step
 * „Ablage"). Every pilot office asked for „eine überschaubare, aber reichliche
 * Datenmenge statt Komplett-Upload"; their project folders hold „_alt",
 * „Backup" and „Sicherung" beside the real work, and reading those costs time
 * and confuses the reading with superseded values.
 *
 * A proposal only: the person switches any folder back in. So the rules are
 * narrow, read off folder names offices actually use, and they never match a
 * word that merely contains one (`Altbau`, `Altstadt`, `Versicherung`,
 * `Absicherung`, `Templates`).
 *
 * Pure and client-side; it decides nothing about sensitive data, which is the
 * office's list (ADR-0086), shown beside it.
 */

/** Why a folder is proposed to stay out. */
export type ExclusionReason = 'backup' | 'old' | 'temp' | 'system'

/** Whole folder names a machine leaves behind, folded to lower case. */
const SYSTEM_NAMES = new Set([
  '__macosx',
  '$recycle.bin',
  '#recycle',
  '@eadir',
  '.trash',
  '.trashes',
  '.git',
  '.svn',
  'papierkorb',
  'recycle bin',
  'system volume information',
  '.spotlight-v100',
  '.fseventsd',
  '.temporaryitems',
])

/** Words (whole tokens of the name) that say a folder holds superseded states. */
const OLD_TOKENS = new Set(['alt', 'old', 'veraltet', 'ueberholt', 'obsolet', 'obsolete', 'superseded'])
/** Words that say a folder holds copies kept for safety. */
const BACKUP_TOKENS = new Set(['backup', 'backups', 'bak', 'bkp', 'sicherung', 'sicherungen', 'datensicherung'])
/** Words that say a folder holds working leftovers. */
const TEMP_TOKENS = new Set(['temp', 'tmp', 'temporaer', 'cache'])

/** Compounds ending in „…sicherung" that are not a backup. */
const NOT_A_BACKUP = ['absicherung', 'versicherung', 'qualitaetssicherung', 'qualitatssicherung', 'beweissicherung']

const UMLAUTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/ß/g, 'ss'],
]

function fold(name: string): string {
  let folded = name.normalize('NFC').toLocaleLowerCase('de').trim()
  for (const [pattern, replacement] of UMLAUTS) folded = folded.replace(pattern, replacement)
  return folded
}

/** The words of a folder name: `03_Pläne_alt (2019)` → `03`, `plaene`, `alt`, `2019`. */
function tokens(folded: string): string[] {
  return folded.split(/[^a-z0-9]+/).filter(Boolean)
}

function isBackupWord(token: string): boolean {
  if (BACKUP_TOKENS.has(token)) return true
  const compound = token.endsWith('sicherung') || token.endsWith('sicherungen')
  return compound && !NOT_A_BACKUP.some((word) => token.endsWith(word) || token.endsWith(`${word}en`))
}

/**
 * Why Piloti proposes to leave a folder out, or null when it belongs in. Reads
 * the folder's own name only; a folder inside a left-out one is left out with
 * it, and the caller does not ask about it.
 */
export function exclusionReason(folderName: string): ExclusionReason | null {
  const folded = fold(folderName)
  if (!folded) return null
  if (SYSTEM_NAMES.has(folded)) return 'system'
  // A hidden folder (`.cache`, `.idea`) or one an editor left (`~Entwurf`).
  if (folded.startsWith('.') || folded.startsWith('~')) return 'system'
  const words = tokens(folded)
  if (folded.endsWith('.bak') || words.some(isBackupWord)) return 'backup'
  if (words.some((word) => TEMP_TOKENS.has(word))) return 'temp'
  if (words.some((word) => OLD_TOKENS.has(word))) return 'old'
  return null
}
