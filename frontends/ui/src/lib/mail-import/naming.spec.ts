import { describe, expect, it } from 'vitest'
import {
  archiveFolderName,
  attachmentFilename,
  mailFolderName,
  archiveThreadName,
  mailTimestamp,
  numbered,
  numberedFilename,
  outlookFolderName,
  outlookFolderPath,
} from './naming'

describe('mail names', () => {
  it('stamps a mail in Vienna time, with dots so the name is a path segment', () => {
    // 08:15 UTC on 30 September is 10:15 in Vienna (summer time).
    expect(mailTimestamp('2026-09-30T08:15:00+00:00')).toBe('2026-09-30 10.15')
    expect(mailTimestamp('2026-01-15T08:15:00+00:00')).toBe('2026-01-15 09.15')
    expect(mailTimestamp(null)).toBe('ohne Datum')
    expect(mailTimestamp('not a date')).toBe('ohne Datum')
  })

  it('names a mail folder by date and sender, never by subject', () => {
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: 'Anna Berger', address: 'anna@buero.at' })).toBe(
      '2026-09-30 10.15 – Anna Berger',
    )
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: '', address: 'anna@buero.at' })).toBe(
      '2026-09-30 10.15 – anna@buero.at',
    )
    expect(mailFolderName(null, null)).toBe('ohne Datum – Unbekannt')
  })

  it('keeps a sender name with a slash from becoming a nested folder', () => {
    expect(mailFolderName('2026-09-30T08:15:00Z', { name: 'Bau/Amt Wien', address: '' })).toBe(
      '2026-09-30 10.15 – Bau-Amt Wien',
    )
  })

  it('keeps a numbered folder name within the 120-character limit', () => {
    const long = 'x'.repeat(120)
    expect(numbered(long, 2)).toHaveLength(120)
    expect(numbered(long, 2).endsWith(' (2)')).toBe(true)
  })

  it('folds an Outlook tree deeper than folder creation takes into its last level', () => {
    const deep = Array.from({ length: 14 }, (_, i) => `E${i + 1}`)
    const path = outlookFolderPath(deep).split('/')
    expect(path).toHaveLength(12)
    expect(path.at(-1)).toBe('E12 – E13 – E14')
    expect(outlookFolderPath(['Posteingang', 'Behörde'])).toBe('Posteingang/Behörde')
  })

  it('numbers a taken name, before the extension for a file', () => {
    expect(numbered('Posteingang', 1)).toBe('Posteingang')
    expect(numbered('Posteingang', 3)).toBe('Posteingang (3)')
    expect(numberedFilename('Plan.pdf', 2)).toBe('Plan (2).pdf')
    expect(numberedFilename('README', 2)).toBe('README (2)')
    const longest = `${'x'.repeat(236)}.pdf`
    expect(numberedFilename(longest, 50)).toHaveLength(240)
    expect(numberedFilename(longest, 50).endsWith(' (50).pdf')).toBe(true)
  })

  it('prefixes an attachment with its mail, and bounds a long name keeping the extension', () => {
    const folder = '2026-09-30 10.15 – Anna Berger'
    expect(attachmentFilename(folder, 'Plan.pdf')).toBe(`${folder} – Plan.pdf`)
    const long = attachmentFilename(folder, `${'x'.repeat(400)}.pdf`)
    expect(long.length).toBeLessThanOrEqual(240)
    expect(long.endsWith('.pdf')).toBe(true)
  })

  it('makes Outlook folder names safe project folder names', () => {
    expect(outlookFolderName('Posteingang')).toBe('Posteingang')
    expect(outlookFolderName('  ')).toBe('Ordner')
    expect(outlookFolderName('CON')).toBe('CON_')
    expect(outlookFolderName('..')).toBe('.._')
    expect(archiveFolderName('Büro 2019.PST')).toBe('Büro 2019')
  })
})

describe('archiveThreadName', () => {
  const at = new Date('2025-03-12T23:30:00Z')

  it('names an archive Verlauf by its other party and the day, Vienna, never by subject (D33)', () => {
    // 23:30 UTC is already the 13th in Vienna (UTC+1).
    expect(archiveThreadName({ name: 'Statik Huber', address: 'office@statik-huber.at' }, at, 'Unbekannt')).toBe(
      'Statik Huber 2025-03-13',
    )
  })

  it('falls back to the address, then to the locale’s word for an unknown party', () => {
    expect(archiveThreadName({ name: '', address: 'post@ma37.wien.gv.at' }, at, 'Unknown')).toBe('post@ma37.wien.gv.at 2025-03-13')
    expect(archiveThreadName(null, at, 'Unknown')).toBe('Unknown 2025-03-13')
  })

  it('keeps a party name with a slash or a line break one segment, and bounds it', () => {
    expect(archiveThreadName({ name: 'Bau/Amt\n## Frist', address: '' }, at, 'Unbekannt')).toBe('Bau-Amt## Frist 2025-03-13')
    const long = archiveThreadName({ name: 'A'.repeat(400), address: '' }, at, 'Unbekannt')
    expect(long).toBe(`${'A'.repeat(120)} 2025-03-13`)
  })
})
