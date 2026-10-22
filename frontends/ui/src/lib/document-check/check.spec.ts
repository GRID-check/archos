import { describe, expect, it } from 'vitest'
import { checkExcerpt, checkInstruction, checkMessage, documentCheckConversationId, documentCheckId } from './check'

describe('document check ids', () => {
  it('derive one id per document version, and a conversation id in the app shape', () => {
    expect(documentCheckId('d', 'v1')).toBe(documentCheckId('d', 'v1'))
    expect(documentCheckId('d', 'v1')).not.toBe(documentCheckId('d', 'v2'))
    expect(documentCheckConversationId(documentCheckId('d', 'v1'))).toMatch(/^s_[0-9a-f_]{36}$/)
  })
})

describe('checkInstruction', () => {
  const text = checkInstruction({ id: 'd-1', name: 'Brandschutzkonzept.pdf' })

  it('is English and names the tools, the cap, the silence and that nobody answers', () => {
    expect(text).toContain('Brandschutzkonzept.pdf')
    expect(text).toContain('2 to 4 load-bearing facts')
    expect(text).toContain('knowledge_search')
    expect(text).toContain('read_passage')
    expect(text).toContain('canvas__mark')
    expect(text).toContain('"Agrees"')
    expect(text).toContain('do not ask anything')
    expect(text).not.toMatch(/[äöüß]/i)
  })

  it('never calls a file a plan', () => {
    expect(text.toLowerCase()).not.toMatch(/\bplan\b/)
  })
})

describe('checkMessage', () => {
  it('says what was checked, lists the findings and that it is no check against regulations', () => {
    const message = checkMessage({ documentName: 'Konzept.pdf', marks: [{ page: 3, body: 'elf gegen zehn' }] })

    expect(message).toContain('Eine Stelle ist')
    expect(message).toContain('1. S. 3: elf gegen zehn')
    expect(message).toContain('keine Prüfung gegen Vorschriften')
    expect(checkExcerpt([{ page: 3, body: 'elf gegen zehn' }])).toBe('S. 3: elf gegen zehn')
    expect(checkExcerpt([])).toBeNull()
  })
})
