'use client'

import type { JSX } from 'react'
import { MentionText } from '@/features/collaboration/components/MentionText'
import type { MarkMention } from '@/lib/annotations/types'
import { cn } from '@/lib/utils'

/**
 * What a mark or a reply says, its mentions drawn as the chat's own chips
 * (`MentionText`): the name, never the id, and a mention of the reader
 * (`viewerId`, the review's `me`) louder than one of a colleague. Only
 * the mentions the server kept become chips, so a name typed by hand stays the
 * text it is, the same rule that decided who was told. The thread card, the
 * list, the inline peek and the summary read the same component, so a mark
 * reads alike wherever it shows.
 *
 * `clamped`: the text sits in a line clamp (the list, the peek, the summary),
 * where its line breaks would cut the lines it has into blanks; there it runs
 * as one paragraph. The thread card keeps them.
 */
export function MarkBody({
  text,
  mentions,
  viewerId,
  clamped = false,
}: {
  text: string
  mentions?: readonly MarkMention[]
  viewerId: string | null
  clamped?: boolean
}): JSX.Element {
  return (
    <MentionText
      content={text}
      mentions={mentions}
      currentUserId={viewerId}
      className={cn(clamped && 'whitespace-normal')}
    />
  )
}
