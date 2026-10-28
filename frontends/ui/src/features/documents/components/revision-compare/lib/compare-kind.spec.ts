/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { compareKindOf } from './compare-kind'

describe('compareKindOf', () => {
  it.each([
    ['Grundriss_B.pdf', 'pdf'],
    ['GRUNDRISS.PDF', 'pdf'],
    ['foto.PNG', 'image'],
    ['skizze.jpeg', 'image'],
    ['detail.webp', 'image'],
    ['Bericht.docx', 'office'],
    ['Kosten.xlsx', 'office'],
    ['Praesentation.pptx', 'office'],
    ['modell.ifc', 'unsupported'],
    ['scan.tiff', 'unsupported'],
    ['ohne-endung', 'unsupported'],
  ])('%s is %s', (filename, kind) => {
    expect(compareKindOf(filename)).toBe(kind)
  })
})
