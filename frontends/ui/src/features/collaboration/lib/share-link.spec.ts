import { describe, expect, test, vi } from 'vitest'
import { canShareNatively, conversationLink, passOnLink } from './share-link'

const here = { origin: 'https://piloti.example' }

describe('conversationLink', () => {
  test('is the project chat with the thread selected', () => {
    expect(
      conversationLink('conversation', 'c1', { ...here, pathname: '/app/projects/p1/chat' }),
    ).toBe('https://piloti.example/app/projects/p1/chat?session=c1')
  })

  test('works outside a project, where the chat route resolves the thread from history', () => {
    expect(conversationLink('conversation', 'c1', { ...here, pathname: '/app/chat' })).toBe(
      'https://piloti.example/app/chat?session=c1',
    )
  })

  test('offers no link from a page that is not a chat, rather than a wrong one', () => {
    expect(
      conversationLink('conversation', 'c1', { ...here, pathname: '/app/projects/p1/files' }),
    ).toBeNull()
  })

  test('offers none for a resource type with no address of its own here', () => {
    expect(
      conversationLink('document', 'd1', { ...here, pathname: '/app/projects/p1/chat' }),
    ).toBeNull()
  })
})

describe('canShareNatively', () => {
  test('is a feature test, never an assumption', () => {
    expect(canShareNatively(undefined)).toBe(false)
    expect(canShareNatively({} as Pick<Navigator, 'share'>)).toBe(false)
    expect(canShareNatively({ share: vi.fn() })).toBe(true)
  })
})

describe('passOnLink', () => {
  const nav = (parts: Partial<Navigator>): Navigator => parts as Navigator

  test('hands the link to the share sheet where there is one', async () => {
    const share = vi.fn(async () => {})
    const writeText = vi.fn(async () => {})
    const result = await passOnLink('https://x/y', 'Chat', nav({ share, clipboard: { writeText } as unknown as Clipboard }))
    expect(result).toBe('shared')
    expect(share).toHaveBeenCalledWith({ title: 'Chat', url: 'https://x/y' })
    expect(writeText).not.toHaveBeenCalled()
  })

  test('copies where there is no share sheet', async () => {
    const writeText = vi.fn(async () => {})
    const result = await passOnLink('https://x/y', 'Chat', nav({ clipboard: { writeText } as unknown as Clipboard }))
    expect(result).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('https://x/y')
  })

  test('a dismissed share sheet is an answer, not a reason to copy behind the reader’s back', async () => {
    const share = vi.fn(async () => {
      throw new DOMException('dismissed', 'AbortError')
    })
    const writeText = vi.fn(async () => {})
    const result = await passOnLink('https://x/y', 'Chat', nav({ share, clipboard: { writeText } as unknown as Clipboard }))
    expect(result).toBe('cancelled')
    expect(writeText).not.toHaveBeenCalled()
  })

  test('falls back to the clipboard when the sheet refuses', async () => {
    const share = vi.fn(async () => {
      throw new DOMException('not allowed', 'NotAllowedError')
    })
    const writeText = vi.fn(async () => {})
    const result = await passOnLink('https://x/y', 'Chat', nav({ share, clipboard: { writeText } as unknown as Clipboard }))
    expect(result).toBe('copied')
  })

  test('says so when neither works', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('insecure context')
    })
    const result = await passOnLink('https://x/y', 'Chat', nav({ clipboard: { writeText } as unknown as Clipboard }))
    expect(result).toBe('failed')
  })
})
