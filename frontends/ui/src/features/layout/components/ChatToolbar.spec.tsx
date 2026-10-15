import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import type { ResourceSharingState } from '@/lib/sharing/types'
import { ChatToolbar } from './ChatToolbar'
import { useShellOverlays } from '@/components/shell/shell-overlays'
import type { ChatMessage } from '@/features/chat/types'
import { emptyRunLedger, setRunStatus } from '@/lib/runs/run-ledger'
import {
  markConversationMinted,
  markConversationOnServer,
  resetConversationsOnServer,
} from '@/features/chat/lib/conversation-on-server'

// Sharing data hooks are stubbed: this spec is about what the toolbar shows and
// gates, not about the (separately tested) fetching. The default state is "nothing
// loaded", which is exactly what a collaboration-disabled org looks like — so the
// pre-existing tests below are unaffected by the sharing surfaces.
let mockSharingState: ResourceSharingState | null = null
const mockUseSharing = vi.fn()

vi.mock('@/features/collaboration/hooks/use-sharing', () => ({
  useSharing: (...args: unknown[]) => {
    mockUseSharing(...args)
    return {
      state: mockSharingState,
      loading: false,
      loadError: false,
      failure: null,
      dismissFailure: vi.fn(),
      saving: false,
      refresh: vi.fn(),
      setVisibility: vi.fn(async () => true),
      grant: vi.fn(async () => true),
      changeRole: vi.fn(async () => true),
      revoke: vi.fn(async () => true),
      escalate: vi.fn(async () => true),
    }
  },
  useShareCandidates: () => ({ candidates: [], loading: false, error: false, reload: vi.fn() }),
}))

// Mock the layout store. The toolbar reads one thing off it — the sessions
// overlay. It held the mobile nav drawer too (the hamburger, now the phone tab
// bar's "Mehr") and the research panel until a run became a message in its own
// thread (ADR-0062).
const mockToggleSessionsPanel = vi.fn()

function getLayoutState() {
  return {
    toggleSessionsPanel: mockToggleSessionsPanel,
  }
}

vi.mock('../store', () => ({
  useLayoutStore: vi.fn((selector?: (s: ReturnType<typeof getLayoutState>) => unknown) => {
    const state = getLayoutState()
    return selector ? selector(state) : state
  }),
}))

// The phone shell's connection line asks `useIsMobile`; the context row itself is
// CSS (`md:hidden`), so jsdom renders it either way.
let mockIsMobile = false
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => mockIsMobile }))
vi.mock('@/shared/hooks/use-connection-presence', () => ({
  useConnectionPresence: () => 'connected',
}))

let mockIsAuthenticated = true

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: mockIsAuthenticated })),
}))

let mockIsDeepResearchStreaming = false
let mockCurrentSessionId: string | null = 'session-1'
const mockUpdateConversationTitle = vi.fn()

vi.mock('@/features/chat', () => ({
  useChatStore: (
    selector: (state: {
      currentConversation: { id: string; messages: ChatMessage[] } | null
      updateConversationTitle: (id: string, title: string) => void
    }) => unknown
  ) =>
    selector({
      // A run going in the thread is a message whose stored ledger says so.
      currentConversation: mockCurrentSessionId
        ? {
            id: mockCurrentSessionId,
            messages: mockIsDeepResearchStreaming
              ? [
                  {
                    id: 'run-1',
                    role: 'assistant',
                    content: '',
                    messageType: 'agent_response',
                    timestamp: new Date('2026-01-01T00:00:00Z'),
                    runLedger: setRunStatus(emptyRunLedger('run-1'), 'laeuft'),
                  },
                ]
              : [],
          }
        : null,
      updateConversationTitle: mockUpdateConversationTitle,
    }),
}))

/**
 * Open the thread menu — the one place every non-primary header action lives.
 * The header shows only what is TRUE about the thread plus New chat; share and
 * rename are behind this trigger by design, so most action tests start here.
 */
async function openThreadMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('thread-menu'))
  await screen.findByRole('menu')
}

/**
 * Pick an item out of the open thread menu.
 *
 * The hover is load-bearing, not decoration: a menu item is selected while it is
 * the *focused* item, and it becomes focused on pointer movement. `user.click`
 * dispatches no `pointermove`, so clicking an item that was never hovered fires
 * `onSelect` only sometimes — which showed up as a rename test that failed about
 * one run in four.
 */
async function selectMenuItem(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
): Promise<void> {
  const item = screen.getByTestId(testId)
  await user.hover(item)
  await user.click(item)
}

describe('ChatToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthenticated = true
    mockIsDeepResearchStreaming = false
    mockCurrentSessionId = 'session-1'
    mockSharingState = null
  })

  describe('research status', () => {
    test('a live run is STATUS in the header, and the header offers nothing else', async () => {
      mockIsDeepResearchStreaming = true
      mockSharingState = SHARED_STATE
      const user = userEvent.setup()

      render(<ChatToolbar conversationId="session-1" isCollaborationEnabled />)

      // The one piece of research the header carries in the open: the thread's own
      // banner scrolls away, so this is the persistent "still working" signal. It
      // states, and there is nothing left for it to act WITH — a run is read in
      // the thread that commissioned it (ADR-0062), so the menu holds no way out
      // to a side panel.
      const running = screen.getAllByTestId('research-running')[0]!
      expect(running).toBeInTheDocument()
      expect(running.querySelector('button')).toBeNull()

      await openThreadMenu(user)
      expect(screen.queryByTestId('research-panel-toggle')).not.toBeInTheDocument()
    })

    test('says nothing about research when nothing is running', () => {
      mockIsDeepResearchStreaming = false
      mockSharingState = SHARED_STATE

      render(<ChatToolbar conversationId="session-1" isCollaborationEnabled />)

      expect(screen.queryByTestId('research-running')).not.toBeInTheDocument()
    })

    test('a run alone puts no menu on the thread', () => {
      mockIsDeepResearchStreaming = true
      mockCurrentSessionId = null // …and nothing else to put in the menu either

      render(<ChatToolbar />)

      // With no rename and no sharing there is nothing occasional to disclose,
      // so the trigger itself is gone. Research used to keep it alive on its own.
      expect(screen.queryByTestId('thread-menu')).not.toBeInTheDocument()
    })
  })

  describe('phone context row', () => {
    beforeEach(() => {
      useShellOverlays.setState({ paletteOpen: false, projectSheetOpen: false })
      mockIsMobile = false
    })

    test('names the project and opens the switcher sheet — the chat route has no phone header', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" projectName="Wohnbau Favoriten" />)

      const row = screen.getByTestId('chat-project-context')
      const pill = within(row).getByTestId('project-pill')
      expect(pill).toHaveTextContent('Wohnbau Favoriten')
      await user.click(pill)

      expect(useShellOverlays.getState().projectSheetOpen).toBe(true)
    })

    test('carries the search that opens the command palette', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" projectName="Wohnbau Favoriten" />)

      await user.click(within(screen.getByTestId('chat-project-context')).getByTestId('shell-search'))

      expect(useShellOverlays.getState().paletteOpen).toBe(true)
    })

    test('is there on a chat that has not started, where the reader most needs a way out', () => {
      render(<ChatToolbar projectName="Wohnbau Favoriten" isChatStarted={false} />)

      expect(screen.getByTestId('project-pill')).toBeInTheDocument()
      expect(screen.getByTestId('shell-search')).toBeInTheDocument()
    })

    test('the connection line is mounted on the phone shell only', () => {
      const { unmount } = render(<ChatToolbar projectName="Wohnbau Favoriten" />)
      expect(document.querySelector('[data-slot="connection-band"]')).toBeNull()
      unmount()

      mockIsMobile = true
      render(<ChatToolbar projectName="Wohnbau Favoriten" />)
      expect(document.querySelector('[data-slot="connection-band"]')).not.toBeNull()
    })

    test('reports its height so the transcript can start below it', () => {
      const onHeightChange = vi.fn()
      const rect = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ height: 163 } as DOMRect)
      render(<ChatToolbar projectName="Wohnbau Favoriten" onHeightChange={onHeightChange} />)
      rect.mockRestore()

      expect(onHeightChange).toHaveBeenCalledWith(163)
    })
  })

  describe('chat-started gating', () => {
    test('hides New chat, the thread menu and the breadcrumb before a chat has started', () => {
      render(
        <ChatToolbar
          sessionTitle="My Session"
          projectName="Wohnbau Favoriten"
          isChatStarted={false}
        />
      )

      // The quiet navigation affordances stay available on the empty start screen.
      expect(screen.getByRole('button', { name: 'Chat history' })).toBeInTheDocument()

      // The actions + thread identity are withheld until a chat starts.
      expect(screen.queryByTestId('thread-menu')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Create new session' })
      ).not.toBeInTheDocument()
      expect(screen.queryByText('My Session')).not.toBeInTheDocument()
    })

    test('shows New chat, the thread menu and the breadcrumb once a chat has started', async () => {
      const user = userEvent.setup()
      render(
        <ChatToolbar
          sessionTitle="My Session"
          projectName="Wohnbau Favoriten"
          isChatStarted
        />
      )

      expect(screen.getByRole('button', { name: 'Create new session' })).toBeInTheDocument()
      expect(screen.getByText('My Session')).toBeInTheDocument()

      await openThreadMenu(user)
      expect(screen.getByTestId('rename-session')).toBeInTheDocument()
    })
  })

  describe('new session button', () => {
    test('invokes onNewSession when enabled', async () => {
      const onNewSession = vi.fn()
      const user = userEvent.setup()

      render(<ChatToolbar onNewSession={onNewSession} />)

      await user.click(screen.getByRole('button', { name: 'Create new session' }))

      expect(onNewSession).toHaveBeenCalledOnce()
    })

    test('is disabled while a session is active', () => {
      render(<ChatToolbar isNewSessionDisabled />)

      expect(screen.getByRole('button', { name: 'Create new session' })).toBeDisabled()
    })
  })

  // The data-sources toggle was removed from the toolbar: the composer's
  // Datengrundlage chip already owns opening that panel, so the navbar no
  // longer duplicates it.
  describe('sessions toggle', () => {
    test('toggles the sessions panel', async () => {
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByRole('button', { name: 'Chat history' }))

      expect(mockToggleSessionsPanel).toHaveBeenCalledOnce()
    })
  })

  describe('phone layout', () => {
    // The thread's name is what the row is for. At 393px it was cut to eight
    // characters, because a hamburger (now the tab bar's "Mehr"), the history
    // door, the title and two actions shared 361px under a 64% cap.
    test('has no hamburger: the phone tab bar owns the drawer', () => {
      render(<ChatToolbar sessionTitle="Fluchtwegbreiten Treppenhaus 2" />)

      expect(screen.queryByRole('button', { name: 'Open navigation' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Chat history' })).toBeInTheDocument()
    })

    test('the title takes the leftover width and may use two lines', () => {
      render(<ChatToolbar sessionTitle="Fluchtwegbreiten Treppenhaus 2" />)

      const title = screen.getByText('Fluchtwegbreiten Treppenhaus 2')
      expect(title.className).toContain('line-clamp-2')
      // No percentage cap on the pill that holds it.
      expect(title.closest('div[class*="max-sm:flex-1"]')).not.toBeNull()
      expect(title.closest('div[class*="max-w-[64%]"]')).toBeNull()
    })

    test('a running research is on the phone too, under the title, not behind `hidden sm:flex`', () => {
      mockIsDeepResearchStreaming = true

      render(<ChatToolbar sessionTitle="Brandschutz" />)

      const phone = document.querySelector('[data-status-surface="phone"]')
      expect(phone).not.toBeNull()
      expect(phone).toHaveTextContent('Researching')
      // Shown below `sm`, gone at `sm` where the right pill carries it.
      expect(phone?.className).toContain('sm:hidden')
      expect(phone?.className).not.toContain('hidden sm:')
    })

    test('a running research with no title yet still has its status line', () => {
      mockIsDeepResearchStreaming = true

      render(<ChatToolbar sessionTitle="" />)

      expect(document.querySelector('[data-status-surface="phone"]')).not.toBeNull()
    })

    test('who can read the thread is on the phone too', () => {
      mockSharingState = { ...SHARED_STATE, visibility: 'project' }

      render(
        <ChatToolbar
          sessionTitle="My Session"
          isCollaborationEnabled
          conversationId="session-1"
          currentUserId="u-me"
        />,
      )

      const phone = document.querySelector('[data-status-surface="phone"]')
      expect(phone?.querySelector('[data-testid="access-chip"]')).not.toBeNull()
    })

    test('New chat is a 44px square on a phone, like the menu beside it', () => {
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByRole('button', { name: 'Create new session' }).className).toContain(
        'size-11',
      )
    })
  })

  describe('breadcrumb + inline rename', () => {
    test('renders the current session title', () => {
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('does not repeat the project name in the breadcrumb — the context row above it carries it', () => {
      render(<ChatToolbar sessionTitle="My Session" projectName="Wohnbau Favoriten" />)

      const breadcrumb = screen.getByRole('navigation')
      expect(within(breadcrumb).queryByText('Wohnbau Favoriten')).not.toBeInTheDocument()
      expect(within(breadcrumb).getByText('My Session')).toBeInTheDocument()
    })

    test('clicking the title opens the editor — the shortcut, alongside the menu', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      // Two ways in, on purpose: the menu entry is how anyone DISCOVERS renaming,
      // this is the fast path once you know it. Unlike the menu route it needs no
      // deferral — no menu is closing, so nothing is about to reclaim focus.
      await user.click(screen.getByRole('button', { name: /rename session/i }))

      expect(screen.getByRole('textbox', { name: /session title/i })).toHaveValue('My Session')
    })

    test('the title cannot be renamed without an active session', () => {
      mockCurrentSessionId = null
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByRole('button', { name: /rename session/i })).toBeDisabled()
    })

    test('the menu opens the inline editor; Enter commits via the store rename action', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')

      const input = await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      expect(input).toHaveValue('My Session')

      await user.clear(input)
      await user.type(input, 'Fluchtweg OG2{Enter}')

      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('session-1', 'Fluchtweg OG2')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    test('Escape cancels the edit without renaming', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')
      const input = await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      await user.clear(input)
      await user.type(input, 'discarded{Escape}')

      expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('blur commits the edit', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')
      const input = await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      await user.clear(input)
      await user.type(input, 'Renamed on blur')
      await user.tab()

      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('session-1', 'Renamed on blur')
    })

    test('committing an unchanged or empty title does not rename', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')
      await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      await user.keyboard('{Enter}')

      expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
    })

    test('rename is not offered without an active session', async () => {
      mockCurrentSessionId = null
      mockSharingState = SHARED_STATE // keep the menu itself around
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" conversationId="session-1" isCollaborationEnabled />)

      await openThreadMenu(user)

      // An action that cannot run is not listed. A disabled row here would only
      // pose a question the reader cannot answer from the menu.
      expect(screen.queryByTestId('rename-session')).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Sharing surfaces (spec SH-17/SH-18). Everything here is gated twice: the org's
// collaboration flag AND a reachable, started conversation.
// ---------------------------------------------------------------------------

const SHARED_STATE: ResourceSharingState = {
  resourceType: 'conversation',
  resourceId: 'session-1',
  visibility: 'private',
  allowedVisibilities: ['private', 'project'],
  myRole: 'owner',
  canManage: true,
  canEscalate: false,
  shared: true,
  entries: [
    {
      person: { userId: 'u-me', name: 'Matthias Bigl', email: null, profilePictureUrl: null },
      role: 'owner',
      reason: 'creator',
      grantedBy: null,
    },
    {
      person: { userId: 'u-anna', name: 'Anna Weber', email: null, profilePictureUrl: null },
      role: 'collaborator',
      reason: 'grant',
      grantedBy: 'u-me',
    },
  ],
}

describe('ChatToolbar — sharing surfaces', () => {
  // This block used to inherit whatever the previous test happened to leave in the
  // module-level mocks — the reset lives in the other describe's beforeEach, which
  // does not reach here. Reset explicitly so each case states its own preconditions.
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthenticated = true
    mockIsDeepResearchStreaming = false
    mockCurrentSessionId = 'session-1'
    mockSharingState = null
  })

  test('shows nothing collaboration-related when the feature is off (default-deny)', () => {
    render(<ChatToolbar sessionTitle="My Session" conversationId="session-1" />)

    expect(mockUseSharing).toHaveBeenCalledWith('conversation', 'session-1', false)
    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('share-button')).not.toBeInTheDocument()
  })

  test('does not even ask the server without a conversation, or before the chat starts', () => {
    render(<ChatToolbar isCollaborationEnabled conversationId={null} />)
    expect(mockUseSharing).toHaveBeenLastCalledWith('conversation', null, false)

    render(<ChatToolbar isCollaborationEnabled conversationId="session-1" isChatStarted={false} />)
    expect(mockUseSharing).toHaveBeenLastCalledWith('conversation', 'session-1', false)
  })

  test('asks for sharing state once the feature is on and the thread is reachable', () => {
    mockSharingState = SHARED_STATE
    render(<ChatToolbar sessionTitle="My Session" isCollaborationEnabled conversationId="session-1" />)

    expect(mockUseSharing).toHaveBeenCalledWith('conversation', 'session-1', true)
  })

  test('a chat minted here is not asked about until the server has created it', () => {
    // The header appears with the first message, and the server row with that
    // message's store: asking in between was a 404 on every new chat.
    resetConversationsOnServer()
    markConversationMinted('session-new')
    const { rerender } = render(
      <ChatToolbar sessionTitle="Neu" isCollaborationEnabled conversationId="session-new" />
    )
    expect(mockUseSharing).toHaveBeenLastCalledWith('conversation', 'session-new', false)

    act(() => markConversationOnServer('session-new'))
    rerender(<ChatToolbar sessionTitle="Neu" isCollaborationEnabled conversationId="session-new" />)
    expect(mockUseSharing).toHaveBeenLastCalledWith('conversation', 'session-new', true)
  })

  test('states who-can-see-this ONCE — the faces, not the faces plus a chip saying the same', () => {
    mockSharingState = SHARED_STATE
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    expect(screen.getAllByTestId('participant-strip').length).toBeGreaterThan(0)
    // The chip would read "Shared with 1" — the same sentence the two faces
    // already are, and the widest element in a row that has to hold the thread's
    // own title. Under `private` the roster IS the audience, so the faces say it.
    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
  })

  test('the faces are STATUS — they say who is here, they do not act', () => {
    mockSharingState = SHARED_STATE
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    // The header's rule: information is not clickable, controls look like
    // controls. An avatar stack that silently opened a dialog was the clearest
    // case of the two being mixed — and it made sharing's ONE door into three.
    for (const strip of screen.getAllByTestId('participant-strip')) {
      expect(strip.tagName).not.toBe('BUTTON')
    }
  })

  test('a blanket rule REPLACES the faces — the rule is the audience, not the roster', () => {
    mockSharingState = { ...SHARED_STATE, visibility: 'project' }
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    expect(screen.getAllByTestId('access-chip')[0]).toHaveTextContent('Project')
    // Not both. Under a blanket rule the roster is not a summary of the audience
    // but a partial sample of it — two faces beside "Projekt" read as "these two
    // can see it" when the truth is "everyone in the project can". The named
    // exceptions belong where there is room to explain them: the sharing surface.
    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
  })

  test('a solo private thread carries no collaboration furniture at all', async () => {
    mockSharingState = { ...SHARED_STATE, entries: [SHARED_STATE.entries[0]] }
    const user = userEvent.setup()
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    // Neither faces nor a "Private" chip: the default state of the overwhelmingly
    // common thread needs no announcement…
    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
    // …but sharing is still reachable, which is how a thread stops being solo.
    await openThreadMenu(user)
    expect(screen.getByTestId('share-button')).toBeInTheDocument()
  })

  test('sharing has exactly ONE door in the header (SH-17), and it is the menu', async () => {
    mockSharingState = SHARED_STATE
    const user = userEvent.setup()
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    // Nothing in the open row opens it — not the faces, not a second button.
    expect(screen.queryByTestId('share-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('share-button')).not.toBeInTheDocument()

    await openThreadMenu(user)
    await selectMenuItem(user, 'share-button')

    expect(await screen.findByTestId('share-dialog')).toBeInTheDocument()
  })

  test('nothing is claimed about access before the server has answered', async () => {
    mockSharingState = null
    const user = userEvent.setup()
    render(<ChatToolbar sessionTitle="My Session" isCollaborationEnabled conversationId="session-1" />)

    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
    await openThreadMenu(user)
    expect(screen.queryByTestId('share-button')).not.toBeInTheDocument()
  })
})
