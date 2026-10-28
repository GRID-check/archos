/**
 * The note on an answer whose search found nothing (ADR-0125).
 *
 * `lookup_found_nothing` on the terminal frame → `lookupFoundNothing` on the
 * message → `AgentResponse`, which says, under the prose and outside the
 * details, that the answer rests on general knowledge. It used to be a canned
 * „nothing retrieved" message INSTEAD of the answer.
 *
 * Rendered for BOTH variants, because the prop is passed twice.
 */

import { render, screen } from '@/test-utils'
import { chatCopy } from '@/i18n/namespaces/chat'
import { vi, describe, test, expect } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '../store'

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      currentConversation: null,
      patchConversationMessage: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
}))

vi.mock('@/adapters/api', () => ({ cancelJob: vi.fn() }))
vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ accessToken: null }) }))
vi.mock('@/adapters/api/skills-client', () => ({
  listInvocableSkills: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}))

const note = chatCopy.messages.en.answerSources.lookupFoundNothing

describe.each(['default', 'inline'] as const)('the %s answer variant', (variant) => {
  test('an answer whose search found nothing says what it rests on, without opening anything', () => {
    render(
      <AgentResponse
        content="Hochhäuser regelt die OIB-RL 2.3."
        variant={variant}
        lookupFoundNothing
      />
    )

    const line = screen.getByText(note)
    expect(line).toHaveAttribute('role', 'note')
    expect(screen.getByText('Hochhäuser regelt die OIB-RL 2.3.')).toBeInTheDocument()
  })

  test('any other answer carries no such note', () => {
    render(<AgentResponse content="Antwort." variant={variant} />)
    expect(screen.queryByText(note)).not.toBeInTheDocument()
  })
})

test('both locales carry their own sentence', () => {
  expect(chatCopy.messages.de.answerSources.lookupFoundNothing).not.toBe(
    chatCopy.messages.en.answerSources.lookupFoundNothing
  )
  for (const text of [
    chatCopy.messages.de.answerSources.lookupFoundNothing,
    chatCopy.messages.en.answerSources.lookupFoundNothing,
  ]) {
    expect(text.trim().length).toBeGreaterThan(20)
    expect(text).not.toContain('{')
  }
})
