import { render } from '@/test-utils'
import { describe, expect, it } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'
import { bindWords } from './bind-words'

const N = ' '

describe('bindWords', () => {
  it.each([
    ['sind 40 m von', `sind 40${N}m von`],
    ['1.200 m² und 62 % sowie 20 °C.', `1.200${N}m² und 62${N}% sowie 20${N}°C.`],
    ['nach § 108 und §§ 12 ff.', `nach §${N}108 und §§${N}12 ff.`],
    ['gemäß Abs. 2, Tabelle 1b, S. 12', `gemäß Abs.${N}2, Tabelle${N}1b, S.${N}12`],
    ['Feuerwiderstand REI 90 oder R 60', `Feuerwiderstand REI${N}90 oder R${N}60`],
    ['im 2. Obergeschoß', `im 2.${N}Obergeschoß`],
    ['Brandschutzkonzept, Stand 3, Index C', `Brandschutzkonzept, Stand${N}3, Index C`],
  ])('binds %s', (text, expected) => {
    expect(bindWords(text)).toBe(expected)
  })

  it('leaves ordinary words, and a unit that is the front of a word, alone', () => {
    const plain = 'Es gibt 3 Meter Reserve, 5 Stufen und 40 Mitarbeiter im Haus R der Anlage.'
    expect(bindWords(plain)).toBe(plain)
  })
})

describe('in the rendered answer', () => {
  it('binds the words of a paragraph, and nothing in a table, a list or code', () => {
    const { container } = render(
      <MarkdownRenderer
        content={['Zulässig sind 40 m nach § 108.', '', '- Länge 38 m', '', '| Wert |', '| --- |', '| 38 m |', '', '`38 m`'].join('\n')}
      />
    )
    expect(container.querySelector('p')?.textContent).toBe(`Zulässig sind 40${N}m nach §${N}108.`)
    expect(container.querySelector('li')?.textContent).toBe('Länge 38 m')
    expect(container.querySelector('td')?.textContent).toBe('38 m')
    expect(container.querySelector('code')?.textContent).toBe('38 m')
  })
})
