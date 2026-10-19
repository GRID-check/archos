import { describe, expect, test } from 'vitest'
import { splitForMiddleTruncation } from '@/lib/text/middle-truncate'
import { projectNameTail } from './project-name'

describe('projectNameTail', () => {
  test('keeps whole trailing words, so the distinguishing end is readable', () => {
    const name = 'Hotel Semmering — Neubau Gästetrakt'
    expect(splitForMiddleTruncation(name, projectNameTail(name)).tail).toBe('Neubau Gästetrakt')
  })

  test('does not open the tail on a dash', () => {
    const name = 'Wohnhausanlage Linz-Urfahr, Bauteil B — Dachausbau'
    const { tail } = splitForMiddleTruncation(name, projectNameTail(name))
    expect(tail.startsWith('—')).toBe(false)
    expect(tail.endsWith('Dachausbau')).toBe(true)
  })

  test('falls back to a fixed tail for one long word', () => {
    expect(projectNameTail('Wohnhausanlagenerweiterungsprojekt')).toBe(14)
  })
})
