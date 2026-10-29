import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ConnectAgentCard } from './connect-agent-card'
import { CONNECT_AGENT_FIXTURES as F } from './fixtures'

const GUIDE = 'https://example.test/guide'
const URL_OK = F.ready.url

describe('ConnectAgentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('ready: shows the address, the client tabs and the guide link', () => {
    render(<ConnectAgentCard state={F.ready} guideHref={GUIDE} />)

    expect(screen.getByText(URL_OK)).toBeInTheDocument()
    for (const name of ['Claude', 'Claude Code', 'Cursor', 'ChatGPT', 'Other clients']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: /full guide/i })).toHaveAttribute('href', GUIDE)
    expect(screen.queryByTestId('connect-agent-notice')).not.toBeInTheDocument()
  })

  test('ready: copy button writes the address to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<ConnectAgentCard state={F.ready} guideHref={GUIDE} />)

    const urlBlock = screen.getByText(URL_OK).closest('div.rounded-surface') as HTMLElement
    await userEvent.click(within(urlBlock).getByRole('button'))

    expect(writeText).toHaveBeenCalledWith(URL_OK)
  })

  test('ready: each client tab shows its own snippet built from the address', async () => {
    render(<ConnectAgentCard state={F.ready} guideHref={GUIDE} />)

    await userEvent.click(screen.getByRole('tab', { name: 'Claude Code' }))
    expect(screen.getByText(`claude mcp add --transport http piloti ${URL_OK}`)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Cursor' }))
    expect(screen.getByText(/"mcpServers"/)).toHaveTextContent(`"url": "${URL_OK}"`)
  })

  test('org disabled: a calm notice, no address, member is pointed to an administrator', () => {
    render(<ConnectAgentCard state={F.orgDisabledMember} guideHref={GUIDE} />)

    expect(screen.getByTestId('connect-agent-notice')).toHaveTextContent('Not switched on for your organization yet')
    expect(screen.getByText(/Ask an administrator/)).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText(/api\/mcp/)).not.toBeInTheDocument()
  })

  test('org disabled: an administrator is told what switching it on means', () => {
    render(<ConnectAgentCard state={F.orgDisabledAdmin} guideHref={GUIDE} />)

    expect(screen.getByText(/lets every member connect their own assistant/)).toBeInTheDocument()
    expect(screen.queryByText(/Ask an administrator/)).not.toBeInTheDocument()
  })

  test('not configured: says so, names no environment variable', () => {
    render(<ConnectAgentCard state={F.notConfigured} guideHref={GUIDE} />)

    const notice = screen.getByTestId('connect-agent-notice')
    expect(notice).toHaveTextContent('Not available on this installation')
    expect(notice).not.toHaveTextContent(/WORKOS|AUTHKIT/i)
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  test('every state keeps the explanation, what the agent can do and what stays with the person', () => {
    for (const state of Object.values(F)) {
      const { unmount } = render(<ConnectAgentCard state={state} guideHref={GUIDE} />)
      expect(screen.getByText('What your agent can do')).toBeInTheDocument()
      expect(screen.getByText('What stays with you')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /full guide/i })).toBeInTheDocument()
      unmount()
    }
  })
})
