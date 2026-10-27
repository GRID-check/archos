import { describe, expect, it } from 'vitest'
import { humanizeKey } from './operation-input'

describe('humanizeKey', () => {
  it.each([
    ['folderId', 'Folder ID'],
    ['id', 'ID'],
    ['memoryScope', 'Memory scope'],
    ['target_folder', 'Target folder'],
    ['if-match', 'If match'],
    ['name', 'Name'],
    ['', ''],
  ])('%s reads as "%s"', (key, words) => {
    expect(humanizeKey(key)).toBe(words)
  })
})
