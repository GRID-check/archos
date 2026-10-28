/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { exclusionReason } from './default-exclusions'

describe('exclusionReason', () => {
  it.each([
    ['_alt', 'old'],
    ['00_ALT', 'old'],
    ['Pläne alt', 'old'],
    ['old', 'old'],
    ['Veraltet', 'old'],
    ['überholt', 'old'],
    ['Backup', 'backup'],
    ['Backups 2019', 'backup'],
    ['Sicherung', 'backup'],
    ['Datensicherung', 'backup'],
    ['Tagessicherung_2024-03', 'backup'],
    ['Projekt.bak', 'backup'],
    ['temp', 'temp'],
    ['TMP', 'temp'],
    ['_Cache', 'temp'],
    ['__MACOSX', 'system'],
    ['$RECYCLE.BIN', 'system'],
    ['#recycle', 'system'],
    ['@eaDir', 'system'],
    ['.git', 'system'],
    ['.idea', 'system'],
    ['~Entwurf', 'system'],
    ['Papierkorb', 'system'],
  ] as const)('proposes to leave out „%s" (%s)', (name, reason) => {
    expect(exclusionReason(name)).toBe(reason)
  })

  it.each([
    '01_Grundlagen',
    'Altbau',
    'Altstadt Sanierung',
    'Alte Post',
    'Versicherung',
    'Kfz-Versicherungen',
    'Brandschutz Absicherung',
    'Qualitätssicherung',
    'Templates',
    'Temperaturmessung',
    'Bestand',
    'Behörde und Bescheide',
    '',
    '   ',
  ])('keeps „%s"', (name) => {
    expect(exclusionReason(name)).toBeNull()
  })
})
