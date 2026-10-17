'use client'

import type { JSX } from 'react'
import { useChatStore } from '@/features/chat'
import { MentionText } from '@/features/collaboration/components/MentionText'
import type { MarkMention } from '@/lib/annotations/types'

/**
 * What a mark or a reply says, its mentions drawn as the chat's own chips
 * (`MentionText`): the name, never the id, and a mention of the reader louder
 * than one of a colleague. Only the mentions the server kept become chips, so
 * a name typed by hand stays the text it is, the same rule that decided who
 * was told. The thread card, the list, the inline peek and the summary read
 * the same component, so a mark reads alike wherever it shows.
 */
export function MarkBody({
  text,
  mentions,
  className,
}: {
  text: string
  mentions?: readonly MarkMention[]
  className?: string
}): JSX.Element {
  const currentUserId = useChatStore((state) => state.currentUserId)
  return <MentionText content={text} mentions={mentions} currentUserId={currentUserId} className={className} />
}
