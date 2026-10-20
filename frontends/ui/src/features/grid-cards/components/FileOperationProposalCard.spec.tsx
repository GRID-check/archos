/**
 * The `file_operation_proposal` card WITHOUT a `proposal_id`: an answer older
 * than server proposals, or a proposal the agent could not store.
 *
 * Nothing in the browser executes a proposal any more (ADR-0105), so this
 * file holds the card to three things:
 *
 * 1. **It reads.** Every row of every verb is drawn in the verb's own words.
 * 2. **It offers nothing it could not stand behind.** An undecided card has no
 *    Apply and no Discard, says why, and calls no route: a click here would
 *    write from the browser what no server ever recorded.
 * 3. **A decision recorded before server proposals is replayed**, so a file
 *    that was moved stays moved in the transcript.
 *
 * The card WITH a `proposal_id` is held in `FileOperationProposalCard.live.spec.tsx`.
 *
 * Rendered without an `I18nProvider`, so the dictionary falls back to `en`.
 */
import { render, screen } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardInteractions } from '../card-decision'
import { FileOperationProposalCard } from './FileOperationProposalCard'

let mockCardInteractions: CardInteractions | undefined
const setCardDecision = vi.fn()

const mockStoreState = () => ({
  projectId: 'proj-1',
  currentConversation: {
    id: 'conv-1',
    messages: [{ id: 'msg-1', cardInteractions: mockCardInteractions }],
  },
  conversations: [],
  setCardDecision,
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: ReturnType<typeof mockStoreState>) => unknown) =>
    selector(mockStoreState())
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

const fetchMock = vi.fn()

const moveCard = {
  title: 'Move two files',
  operation: 'move' as const,
  operations: [
    {
      document: 'Grundriss EG.pdf',
      source: 'project' as const,
      current: 'Nachweise',
      target_folder: 'Einreichung/Pläne',
    },
    {
      document: 'Grundriss OG.pdf',
      source: 'project' as const,
      current: '',
      target_folder: 'Einreichung/Pläne',
    },
  ],
}

beforeEach(() => {
  mockCardInteractions = undefined
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FileOperationProposalCard without a proposal_id — what it shows', () => {
  it('renders every proposed operation', () => {
    render(<FileOperationProposalCard {...moveCard} cardKey="file_operation_proposal-0" />)

    expect(screen.getByText('Grundriss EG.pdf')).toBeInTheDocument()
    expect(screen.getByText('Grundriss OG.pdf')).toBeInTheDocument()
    // The current folder is on the row, because a move the reader cannot place
    // is a move they cannot judge. An empty `current` is the project root.
    expect(screen.getByText(/Nachweise/)).toBeInTheDocument()
    expect(screen.getByText(/Top level/)).toBeInTheDocument()
  })

  it.each([
    ['rename', { document: 'a.pdf', source: 'project' as const, new_display_name: 'Grundriss Erdgeschoss' }, 'Grundriss Erdgeschoss'],
    ['create_folder', { folder_name: 'Fotos', parent_folder: 'Einreichung' }, 'Fotos'],
    ['assign', { document: 'a.pdf', source: 'project' as const, member: 'Anna Berger' }, 'Anna Berger'],
  ])('renders the %s operation in its own words', (operation, item, expected) => {
    render(
      <FileOperationProposalCard
        title="Proposal"
        operation={operation as 'rename'}
        operations={[item]}
        cardKey="file_operation_proposal-0"
      />,
    )
    expect(screen.getByText(expected)).toBeInTheDocument()
  })
})

describe('FileOperationProposalCard without a proposal_id — read-only', () => {
  it('offers nothing, says it could not be created as a proposal, and calls no route', () => {
    render(<FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />)

    expect(screen.getByTestId('file-operation-unavailable')).toHaveTextContent('Could not be created as a proposal')
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setCardDecision).not.toHaveBeenCalled()
  })
})

describe('FileOperationProposalCard without a proposal_id — a decision recorded before server proposals', () => {
  it('shows an accepted card after a reload, without re-offering the write', () => {
    mockCardInteractions = {
      'file_operation_proposal-0': { decision: 'accepted', decidedAt: '2026-09-10T09:00:00Z' },
    }
    render(<FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />)

    expect(screen.getByText('2 files moved.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('says only what it still knows after a reload of a partial accept', () => {
    mockCardInteractions = {
      'file_operation_proposal-0': { decision: 'partiallyApplied', decidedAt: '2026-09-10T09:00:00Z' },
    }
    render(<FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />)

    expect(screen.getByText(/Applied in part/)).toBeInTheDocument()
  })

  it('shows a discarded card as discarded', () => {
    mockCardInteractions = {
      'file_operation_proposal-0': { decision: 'rejected', decidedAt: '2026-09-10T09:00:00Z' },
    }
    render(<FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />)

    expect(screen.getByText('Discarded. Nothing was changed.')).toBeInTheDocument()
  })
})
