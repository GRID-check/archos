import { render, screen, waitFor } from '@/test-utils'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The link an inbox row about a team reply carries (`feedbackThreadHref`):
// `?feedback=<report id>` on any page of the shell opens that thread.
let search = ''
const replace = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/projects',
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace }),
}))

const REPORT_ID = '7b6a2c1e-0000-4000-8000-000000000001'

vi.mock('@/lib/product-feedback/client', () => ({
  fetchOwnFeedback: vi.fn(async () => ({ reports: [], updatedCount: 0, live: true, nextCursor: null })),
  fetchOfficeFeedback: vi.fn(async () => ({ reports: [], live: true, nextCursor: null })),
  fetchOwnFeedbackThread: vi.fn(async () => ({
    report: {
      id: REPORT_ID,
      kind: 'bug',
      excerpt: 'Der Upload bleibt bei 99 % stehen.',
      createdAt: '2026-10-22T08:00:00.000Z',
      status: 'open',
      hasUpdate: false,
      canReply: true,
    },
    messages: [
      { id: REPORT_ID, author: 'me', authorName: null, content: 'Der Upload bleibt bei 99 % stehen.', createdAt: '2026-10-22T08:00:00.000Z' },
      { id: 'm-2', author: 'team', authorName: 'Lena', content: 'Danke, ist behoben.', createdAt: '2026-10-22T09:00:00.000Z' },
    ],
    live: true,
  })),
  replyToOwnFeedback: vi.fn(),
  submitProductFeedback: vi.fn(),
  captureFeedbackContext: vi.fn(() => ({ pagePath: null, context: {} })),
}))

import { fetchOwnFeedbackThread } from '@/lib/product-feedback/client'
import { FeedbackProvider } from './feedback-provider'

beforeEach(() => {
  search = ''
  vi.clearAllMocks()
})

describe('FeedbackProvider — a thread named in the address', () => {
  test('opens Mein Feedback on that thread and takes the parameter off the address', async () => {
    search = `feedback=${REPORT_ID}&tab=files`
    render(<FeedbackProvider>page</FeedbackProvider>)

    await waitFor(() => expect(fetchOwnFeedbackThread).toHaveBeenCalledWith(REPORT_ID))
    expect(await screen.findByText('Danke, ist behoben.')).toBeInTheDocument()
    expect(replace).toHaveBeenCalledWith('/app/projects?tab=files', { scroll: false })
  })

  test('opens nothing without the parameter', () => {
    render(<FeedbackProvider>page</FeedbackProvider>)
    expect(screen.queryByTestId('feedback-threads')).not.toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })
})
