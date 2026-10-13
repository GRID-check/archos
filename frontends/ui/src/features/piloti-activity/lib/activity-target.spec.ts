import { describe, expect, test } from 'vitest'
import { reviewFilesHref } from '@/features/documents/lib/open-review'
import type { ActivityTarget } from '@/lib/piloti-activity/types'
import { activityCounts, waitingCount } from './activity-counts'
import { activityTargetHref } from './activity-target'
import { pilotiActivityFixture } from '@/app/dev/_fixtures/piloti-activity'

describe('activityTargetHref', () => {
  test('a mark leads to its Prüfansicht, by the helper the inbox and the chat card use', () => {
    const target: ActivityTarget = { kind: 'review', documentId: 'd 1', annotationId: 'm1' }
    expect(activityTargetHref('p1', target)).toBe(
      reviewFilesHref('p1', { documentId: 'd 1', annotationId: 'm1' })
    )
    expect(activityTargetHref('p1', target)).toBe('/app/projects/p1/files?doc=d+1&review=1&mark=m1')
  })

  test('a document without a mark opens its review at the start', () => {
    const href = activityTargetHref('p1', { kind: 'review', documentId: 'd1', annotationId: null })
    expect(href).toBe('/app/projects/p1/files?doc=d1&review=1')
  })

  test('a turn is the thread at its message, the conversation deep link', () => {
    expect(activityTargetHref('p1', { kind: 'turn', conversationId: 'c1', messageId: 'm9' })).toBe(
      '/app/projects/p1/chat?session=c1#message-m9'
    )
  })

  test('a turn without a message is the thread alone', () => {
    expect(activityTargetHref('p1', { kind: 'turn', conversationId: 'c1', messageId: null })).toBe(
      '/app/projects/p1/chat?session=c1'
    )
  })

  test('a run is its block in its thread, the shape of the inbox run link', () => {
    expect(
      activityTargetHref('p1', { kind: 'run', conversationId: 'c1', messageId: 'm2', runId: 'r3' })
    ).toBe('/app/projects/p1/chat?session=c1&run=r3#message-m2')
  })

  test('a task is its drawer in Automation', () => {
    expect(activityTargetHref('p1', { kind: 'task', taskId: 't4' })).toBe(
      '/app/projects/p1/automation?tab=tasks&task=t4'
    )
  })

  test('the project chat is the chat of the project', () => {
    expect(activityTargetHref('p1', { kind: 'project_chat' })).toBe('/app/projects/p1/chat')
  })

  test('ids are encoded, so an id cannot add a parameter', () => {
    expect(
      activityTargetHref('p/1', { kind: 'turn', conversationId: 'a&b=c', messageId: 'x#y' })
    ).toBe('/app/projects/p%2F1/chat?session=a%26b%3Dc#message-x%23y')
  })
})

describe('activity counts', () => {
  const now = new Date('2026-10-13T12:00:00Z')

  test('a proposed-marks row stands for every mark it holds, a proposal for one', () => {
    const { waiting } = pilotiActivityFixture('full', now)
    // 3 proposals, one group of 5 marks and one of 1.
    expect(waitingCount(waiting.items)).toBe(3 + 5 + 1)
  })

  test('counts what is in the response and passes the cut-off flags through', () => {
    const activity = pilotiActivityFixture('full', now)
    const truncated = {
      ...activity,
      running: { ...activity.running, truncated: true },
    }
    expect(activityCounts(truncated)).toEqual({
      running: activity.running.items.length,
      runningTruncated: true,
      waiting: 9,
      waitingTruncated: false,
    })
  })
})
