/**
 * @vitest-environment node
 */
/** `roundKind` (ADR-0132): a round that only listed folders is no „Kein Treffer“. */
import { describe, expect, test } from 'vitest'
import { translatorFor } from '@/i18n/namespace'
import { chatCopy } from '@/i18n/namespaces/chat'
import { roundKind } from './flow/round-kind'

const t = translatorFor(chatCopy, 'de')

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

  test('the filesystem verbs read as the names they replaced (ADR-0133 slice 6), and old turns still do', () => {
    expect(roundKind(false, 0, ['ls'], t, true)).toBe('Ordner öffnen')
    expect(roundKind(false, 0, ['ls', 'glob'], t, true)).toBe('Ordner öffnen')
    expect(roundKind(false, 0, ['grep'], t, true)).toBe('Kein Treffer')
    expect(roundKind(false, 2, ['read_file', 'read_file'], t, true)).toBe(roundKind(false, 2, ['read_passage'], t, true))
    expect(roundKind(false, 2, ['read_file'], t, true)).not.toBe(roundKind(false, 2, ['grep'], t, true))
  })
})
