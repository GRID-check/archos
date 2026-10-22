/** `roundKind` (ADR-0132): a round that only listed folders is no „Kein Treffer“. */
import { describe, expect, test } from 'vitest'
import { createTranslator } from '@/i18n/translate'
import { de } from '@/i18n/dictionaries/de'
import { roundKind } from './ReasoningFlow'

const t = createTranslator(de, 'chat')

describe('roundKind', () => {
  test('a list_files-only round is a folder opened, even when the ledger accounts for it', () => {
    expect(roundKind(false, 0, ['list_files'], t, true)).toBe('Ordner öffnen')
  })

  test('a workspace or model round is no miss either', () => {
    expect(roundKind(false, 0, ['call'], t, true)).not.toBe('Kein Treffer')
    expect(roundKind(false, 0, ['ifc_query'], t, true)).not.toBe('Kein Treffer')
  })

  test('a search that came back empty still is', () => {
    expect(roundKind(false, 0, ['knowledge_search'], t, true)).toBe('Kein Treffer')
    expect(roundKind(false, 0, ['list_files', 'knowledge_search'], t, true)).toBe('Kein Treffer')
    expect(roundKind(false, 0, [], t, true)).toBe('Kein Treffer')
  })
})
