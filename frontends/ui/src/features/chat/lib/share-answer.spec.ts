/**
 * @vitest-environment node
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { answerShareUrl, shareAnswer } from './share-answer'
import {
  markConversationMinted,
  resetConversationsOnServer,
} from './conversation-on-server'

const payload = { title: 'Antwort von Piloti', text: 'Die Fluchtweglänge beträgt 40 m.' }

describe('shareAnswer', () => {
  test('hands the answer to the share sheet', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const copy = vi.fn()

    const outcome = await shareAnswer(payload, copy, { share })

    expect(outcome).toBe('shared')
    expect(share).toHaveBeenCalledWith({ title: payload.title, text: payload.text })
    expect(copy).not.toHaveBeenCalled()
  })

  test('carries the thread address when there is one', async () => {
    const share = vi.fn().mockResolvedValue(undefined)

    await shareAnswer({ ...payload, url: 'https://piloti.example/app/chat?session=c1' }, vi.fn(), {
      share,
    })

    expect(share).toHaveBeenCalledWith({
      ...payload,
      url: 'https://piloti.example/app/chat?session=c1',
    })
  })

  test('copies the answer, and the link, when the browser has no share sheet', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)

    const outcome = await shareAnswer({ ...payload, url: 'https://x.test/chat?session=c1' }, copy, {})

    expect(outcome).toBe('copied')
    expect(copy).toHaveBeenCalledWith(`${payload.text}\n\nhttps://x.test/chat?session=c1`)
  })

  test('copies when the sheet refuses (Safari outside a user gesture)', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('no gesture', 'NotAllowedError'))
    const copy = vi.fn().mockResolvedValue(undefined)

    expect(await shareAnswer(payload, copy, { share })).toBe('copied')
    expect(copy).toHaveBeenCalledWith(payload.text)
  })

  test('closing the sheet is an answer, not a failure: nothing is copied', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError'))
    const copy = vi.fn()

    expect(await shareAnswer(payload, copy, { share })).toBe('cancelled')
    expect(copy).not.toHaveBeenCalled()
  })

  test('reports a failure when neither the sheet nor the clipboard works', async () => {
    const copy = vi.fn().mockRejectedValue(new Error('denied'))

    expect(await shareAnswer(payload, copy, {})).toBe('failed')
  })
})

describe('answerShareUrl', () => {
  const chat = { origin: 'https://piloti.example', pathname: '/app/projects/p1/chat' }

  beforeEach(() => resetConversationsOnServer())

  test('is the thread address on the chat page', () => {
    expect(answerShareUrl('c1', chat)).toBe(
      'https://piloti.example/app/projects/p1/chat?session=c1',
    )
  })

  test('is nothing for a chat the server has not stored yet', () => {
    markConversationMinted('c-new')

    expect(answerShareUrl('c-new', chat)).toBeUndefined()
  })

  test('is nothing without a conversation, or off the chat page', () => {
    expect(answerShareUrl(null, chat)).toBeUndefined()
    expect(answerShareUrl('c1', { ...chat, pathname: '/app/projects/p1/files' })).toBeUndefined()
  })
})
