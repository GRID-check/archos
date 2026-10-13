/**
 * Where a „Was Piloti tut" row leads, as an href.
 *
 * The server sends a structured {@link ActivityTarget} (`lib/piloti-activity/types`)
 * and never a URL, so each link keeps its one owner: a mark is
 * `reviewFilesHref`'s, a thread is the conversation deep link of
 * `lib/sharing/registry.ts`, a run's block is `runDeepLink`'s in
 * `lib/inbox/targets.ts`. Those two are `server-only` and cannot be imported
 * here, so their SHAPES are written out below and `activity-target.spec.ts`
 * pins each one; change a shape there and here together.
 *
 * Pure: no router, no store, no fetch.
 */

import { reviewFilesHref } from '@/features/documents/lib/open-review'
import type { ActivityTarget } from '@/lib/piloti-activity/types'

const projectPath = (projectId: string): string => `/app/projects/${encodeURIComponent(projectId)}`

/** The href a target stands for, inside `projectId`. */
export function activityTargetHref(projectId: string, target: ActivityTarget): string {
  switch (target.kind) {
    case 'review':
      return reviewFilesHref(projectId, {
        documentId: target.documentId,
        annotationId: target.annotationId,
      })
    case 'turn': {
      const anchor = target.messageId ? `#message-${encodeURIComponent(target.messageId)}` : ''
      return `${projectPath(projectId)}/chat?session=${encodeURIComponent(target.conversationId)}${anchor}`
    }
    case 'run': {
      const session = encodeURIComponent(target.conversationId)
      const run = encodeURIComponent(target.runId)
      return `${projectPath(projectId)}/chat?session=${session}&run=${run}#message-${encodeURIComponent(target.messageId)}`
    }
    case 'task':
      return `${projectPath(projectId)}/automation?tab=tasks&task=${encodeURIComponent(target.taskId)}`
    case 'project_chat':
      return `${projectPath(projectId)}/chat`
  }
}
