/**
 * What the inbox preview (`/dev/inbox`) adds to its rows: the project each is
 * about, and who its reply composer may mention.
 */

import type { InboxItemView } from '@/lib/inbox/types'

/**
 * The project each row is about, as the server names it (`projectName`): the
 * Schnitt rows in a second project, so the preview shows that the line tells
 * two projects apart. Org, platform and redacted rows carry none.
 */
export function withProjects(items: readonly InboxItemView[]): InboxItemView[] {
  return items.map((item) =>
    item.href?.includes('/projects/p1') && item.state !== 'inert'
      ? item.resourceId === 'd-schnitt'
        ? { ...item, projectId: 'p2', projectName: 'Volksschule Am Hang' }
        : { ...item, projectId: 'p1', projectName: 'Wohnanlage Linzer Straße' }
      : item,
  )
}

/** Who may open the fixtures' documents: the rows the reply composer's „@" picker offers. */
export const MENTIONABLE = [
  { userId: 'u-anna', name: 'Anna Weber', email: 'anna@buero.at', profilePictureUrl: null },
  { userId: 'u-jakob', name: 'Jakob Huber', email: 'jakob@buero.at', profilePictureUrl: null },
  { userId: 'u-markus', name: 'Markus Lehner', email: 'markus@buero.at', profilePictureUrl: null },
]
