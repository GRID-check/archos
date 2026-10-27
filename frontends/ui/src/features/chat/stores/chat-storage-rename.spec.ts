// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { moveStoredChat } from './chat-storage-rename'

const OLD = 'aiq-chat-store'
const NEW = 'chat-store'

const keys = (): string[] =>
  Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).sort()

afterEach(() => localStorage.clear())

describe('moveStoredChat', () => {
  it('moves the index and every conversation under the new name and drops the old keys', () => {
    localStorage.setItem(`${OLD}:index`, '{"state":{}}')
    localStorage.setItem(`${OLD}:messages:s_1`, '[1]')
    localStorage.setItem(`${OLD}-spec`, 'not ours')

    moveStoredChat(OLD, NEW)

    expect(keys()).toEqual([`${OLD}-spec`, `${NEW}:index`, `${NEW}:messages:s_1`])
    expect(localStorage.getItem(`${NEW}:index`)).toBe('{"state":{}}')
    expect(localStorage.getItem(`${NEW}:messages:s_1`)).toBe('[1]')
  })

  it('keeps what the new name already holds and only drops the old keys', () => {
    localStorage.setItem(`${NEW}:index`, 'new')
    localStorage.setItem(`${OLD}:index`, 'old')
    localStorage.setItem(`${OLD}:messages:s_1`, '[1]')

    moveStoredChat(OLD, NEW)

    expect(keys()).toEqual([`${NEW}:index`])
    expect(localStorage.getItem(`${NEW}:index`)).toBe('new')
  })

  it('does nothing when there is nothing under the old name', () => {
    localStorage.setItem(`${NEW}:index`, 'new')

    moveStoredChat(OLD, NEW)

    expect(keys()).toEqual([`${NEW}:index`])
  })
})
