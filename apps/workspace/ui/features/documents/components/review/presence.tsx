'use client'

/**
 * Who is in a document's room, as faces: the review's header and the file
 * preview's chrome (the one presence component of a page, slice 1 of
 * `docs/roadmap/working-on-a-plan.md`). The faces are the kit's
 * {@link AvatarStack}, the stack a conversation's roster draws too
 * (`ParticipantStrip`); what is the room's own here is Piloti at the front and
 * a face being the way to follow that person.
 */

import type { JSX } from 'react'
import { AvatarStack } from '@/components/ui/avatar-stack'
import { identityInk } from '@/components/ui/avatar-identity'
import { AgentGlyph } from '@/components/ui/agent-glyph'
import { PRODUCT_NAME } from '@/lib/brand'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { presenceCopy } from '@/i18n/namespaces/presence'
import { cn } from '@/lib/utils'
import { sameValue } from '@/lib/utils/same-value'
import type { DocumentReview as ReviewState } from '../../hooks/use-document-review'
import { useRoomSelector, type DocumentRoom, type RoomPeerState } from '../../hooks/use-document-room'
import { isAgentPeer } from './review-page-layer'

/** The people in the room, one face per person however many tabs they have open. Piloti is not one of them. */
export function people(peers: readonly RoomPeerState[]): RoomPeerState[] {
  const byUser = new Map<string, RoomPeerState>()
  for (const state of peers) {
    if (!isAgentPeer(state) && !byUser.has(state.peer.userId)) byUser.set(state.peer.userId, state)
  }
  return [...byUser.values()]
}

/** The page a person is on: where their pointer is, else where they are scrolled to. */
export const pageOf = (state: RoomPeerState): number | null => state.cursor?.page ?? state.viewport?.page ?? null

/**
 * Who is in the room, as the header tells it: the people, one per person, and
 * the page each is on; and Piloti, what it is doing and for whom. Equal by
 * value from one pointer frame to the next, so the faces, the header and the
 * file preview that read it re-render when somebody comes, goes or turns a
 * page, not when a pointer moves.
 */
export interface RoomCompany {
  people: Array<{ peerId: string; userId: string; name: string; page: number | null }>
  agent: { forName: string | null; working: boolean; label: string | null } | null
}

export function roomCompanyOf(peers: readonly RoomPeerState[]): RoomCompany {
  const agent = peers.find(isAgentPeer) ?? null
  return {
    people: people(peers).map((state) => ({
      peerId: state.peer.peerId,
      userId: state.peer.userId,
      name: state.peer.name,
      page: pageOf(state),
    })),
    agent: agent
      ? { forName: agent.peer.forName ?? null, working: Boolean(agent.activity), label: agent.activity?.label ?? null }
      : null,
  }
}

/** The room's company, re-rendering only when it changed: see {@link RoomCompany}. */
export const useRoomCompany = (room: Pick<DocumentRoom, 'peers'>): RoomCompany =>
  useRoomSelector(room, roomCompanyOf, sameValue)

/**
 * Who else is here, as faces in their colour. A face is also the way to follow
 * them: the view goes where theirs goes until the reader moves on their own.
 * Without `onFollow` (the file preview's header) the faces only tell, and the
 * caller says in words who they are.
 */
export function Presence({
  review,
  following = null,
  onFollow,
}: {
  review: ReviewState
  following?: string | null
  onFollow?: (peerId: string | null) => void
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const tPresence = useTranslations(presenceCopy)
  const { people: others, agent } = useRoomCompany(review.room)
  // Piloti in the room as itself: a peer the server publishes while it works on
  // the document, naming whose request it works on (ADR-0105). The full name
  // here, where there is room; the cursor tag carries the first name.
  const forName = agent?.forName
  const onBehalf = forName ? tPresence('agent.onBehalfOf', { name: forName }) : null
  if (others.length === 0 && !agent) return null
  const glyph = agent && (
    <span data-testid="review-presence-agent" className="ring-background rounded-full ring-2">
      <AgentGlyph size="md" working={agent.working} label={onBehalf ?? PRODUCT_NAME} />
    </span>
  )
  // Everyone in the room is drawn, no `+N`: each face is the way to follow that person.
  const faces = (
    <AvatarStack
      people={others.map((person) => ({ userId: person.userId, name: person.name, profilePictureUrl: null }))}
      max={Math.max(1, others.length)}
      size="sm"
      renderPerson={
        onFollow
          ? (_person, face, index) => {
              const person = others[index]
              const on = following === person.peerId
              const label = on ? t('review.unfollow', { name: person.name }) : t('review.follow', { name: person.name })
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-testid="review-peer"
                      aria-pressed={on}
                      aria-label={label}
                      onClick={() => onFollow(on ? null : person.peerId)}
                      className="relative rounded-full outline-none focus-visible:ring-2"
                    >
                      {face}
                      <span
                        aria-hidden
                        className={cn('absolute -inset-[3px] rounded-full border-2', on ? 'opacity-100' : 'opacity-0')}
                        style={{ borderColor: identityInk(person.userId) }}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="block">{label}</span>
                    {person.page && <span className="block">{t('review.onPage', { name: person.name, page: person.page })}</span>}
                  </TooltipContent>
                </Tooltip>
              )
            }
          : undefined
      }
    />
  )
  if (!onFollow) {
    return (
      <span aria-hidden className="flex items-center -space-x-1" data-testid="review-presence">
        {glyph}
        {faces}
      </span>
    )
  }
  return (
    <div className="flex items-center -space-x-1" data-testid="review-presence">
      {glyph && (
        <Tooltip>
          <TooltipTrigger asChild>{glyph}</TooltipTrigger>
          <TooltipContent>
            {onBehalf ? (
              <>
                <span className="block">{onBehalf}</span>
                {agent?.label && <span className="block">{agent.label}</span>}
              </>
            ) : (
              agent?.label || t('review.agentWorking')
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {faces}
    </div>
  )
}
