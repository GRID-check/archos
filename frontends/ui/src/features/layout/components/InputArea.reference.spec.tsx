/**
 * The `#` picker, through the real composer: typing `#` and a word searches
 * the workspace for documents (`useDocumentReference`), a pick writes the name
 * into the message and makes the document its subject, the same subject
 * „Piloti fragen" on a file sets. The pure half is
 * `features/search/lib/document-reference.spec.ts`.
 */

import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { vi, describe, test, expect, beforeEach } from 'vitest'

import { server } from '@/mocks/server'
import { useChatStore } from '@/features/chat'
import { SEARCH_FIXTURE_RESPONSE } from '@/app/dev/_fixtures/search'
import type { SearchBody } from '@/lib/search/search-wire'
import { InputArea } from './InputArea'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))

vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

vi.mock('@/features/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/chat')>()
  return {
    ...actual,
    useWebSocketChat: () => ({
      sendMessage: vi.fn(() => true),
      isLoading: false,
      respondToInteraction: vi.fn(),
      pendingInteraction: null,
      noteSendIntent: vi.fn(),
    }),
  }
})

const DOCUMENTS = { ...SEARCH_FIXTURE_RESPONSE, sections: { document: SEARCH_FIXTURE_RESPONSE.sections.document } }
const asked: SearchBody[] = []

beforeEach(() => {
  asked.length = 0
  useChatStore.getState().setComposerSubject(null)
  server.use(
    http.post('/api/search', async ({ request }) => {
      asked.push((await request.json()) as SearchBody)
      return HttpResponse.json(DOCUMENTS)
    })
  )
})

const composer = () => screen.getByRole('textbox')
/** The whole composer mounts per test; under a loaded runner its first answer takes seconds. */
const SLOW = { timeout: 8000 }

describe('the composer’s # reference', () => {
  test('a pick writes the document’s name and makes it the message’s subject', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)

    await user.type(composer(), 'Was steht in #Flucht')
    expect(await screen.findByTestId('composer-search-picker', {}, SLOW)).toBeInTheDocument()
    // A slow runner can ask on a pause mid-word; the last question is the one typed.
    await waitFor(() => expect(asked.at(-1)).toMatchObject({ text: 'Flucht', kinds: ['document'] }), SLOW)

    const hit = DOCUMENTS.sections.document!.hits[0]
    await screen.findByTestId(`palette-search-hit-document-${hit.id}`, {}, SLOW)
    await user.keyboard('{Enter}')

    await waitFor(() => expect(composer()).toHaveValue(`Was steht in „${hit.title ?? hit.name}“ `), SLOW)
    expect(useChatStore.getState().composerSubject).toMatchObject({ resourceType: 'document', resourceId: hit.id, filename: hit.filename, shelf: hit.shelf })
    expect(screen.queryByTestId('composer-search-picker')).not.toBeInTheDocument()
  }, 20_000)

  test('stays shut for a # inside a word', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated connectionMode="sse" />)
    await user.type(composer(), 'Raum Nr.#3')
    expect(screen.queryByTestId('composer-search-picker')).not.toBeInTheDocument()
  })
})
