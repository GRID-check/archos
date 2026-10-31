import { describe, expect, it } from 'vitest'

import type { InboxItemView } from '@/lib/inbox/types'
import { isAtHref, isOpenRequest, newsOf, queueOrder, urgencyOf, waitingGroups } from './inbox-queue'

const TODAY = '2026-10-29'

const row = (id: string, overrides: Partial<InboxItemView> = {}): InboxItemView => ({
  id,
  type: 'annotation.assigned_to_you',
  state: 'unread',
  archived: false,
  read: false,
  actionable: true,
  resourceType: 'document',
  resourceId: 'doc-eg',
  anchorId: `mark-${id}`,
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: '/app/projects/p1/files?doc=doc-eg',
  subject: 'Grundriss EG',
  related: '4',
  excerpt: 'Türbreite prüfen',
  mentions: [],
  variant: null,
  answerIn: 'row',
  createdAt: '2026-10-29T08:00:00Z',
  updatedAt: '2026-10-29T08:00:00Z',
  ...overrides,
})

describe('isOpenRequest', () => {
  it('is an actionable row nobody has answered, that the reader can still reach and has not put away', () => {
    expect(isOpenRequest(row('a'))).toBe(true)
    expect(isOpenRequest(row('a', { actionable: false }))).toBe(false)
    expect(isOpenRequest(row('a', { state: 'resolved' }))).toBe(false)
    expect(isOpenRequest(row('a', { state: 'inert' }))).toBe(false)
    expect(isOpenRequest(row('a', { archived: true }))).toBe(false)
  })
})

describe('urgencyOf', () => {
  it('puts a passed date first, a near one next, any date after, and no date last', () => {
    expect(urgencyOf(row('a', { variant: 'overdue', dueOn: '2026-10-15' }), TODAY)).toBe(0)
    expect(urgencyOf(row('a', { variant: 'due_soon', dueOn: '2026-10-30' }), TODAY)).toBe(1)
    expect(urgencyOf(row('a', { dueOn: '2026-11-20' }), TODAY)).toBe(2)
    expect(urgencyOf(row('a'), TODAY)).toBe(3)
  })

  it('counts a date that passed since the last reminder as late', () => {
    expect(urgencyOf(row('a', { dueOn: '2026-10-28' }), TODAY)).toBe(0)
  })
})

describe('waitingGroups', () => {
  it('gathers the waiting rows by document, the group standing where its most urgent row would', () => {
    const groups = waitingGroups(
      [
        row('eg-new', { updatedAt: '2026-10-29T10:00:00Z' }),
        row('chat', { resourceType: 'conversation', resourceId: 'c1', subject: 'Atrium', type: 'mention.requested', updatedAt: '2026-10-29T09:00:00Z' }),
        row('schnitt-late', { resourceId: 'doc-s', subject: 'Schnitt A-A', variant: 'overdue', dueOn: '2026-10-15', updatedAt: '2026-10-28T08:00:00Z' }),
        row('eg-soon', { variant: 'due_soon', dueOn: '2026-10-30' }),
      ],
      TODAY,
    )
    expect(groups.map((group) => [group.subject, group.items.map((item) => item.id)])).toEqual([
      ['Schnitt A-A', ['schnitt-late']],
      ['Grundriss EG', ['eg-soon', 'eg-new']],
      ['Atrium', ['chat']],
    ])
    expect(groups[2].chat).toBe(true)
  })

  it('leaves out what does not wait on the reader', () => {
    expect(waitingGroups([row('a', { actionable: false }), row('b', { state: 'resolved' })], TODAY)).toEqual([])
  })

  it('lets a row that names no document or chat stand alone', () => {
    const groups = waitingGroups(
      [row('p1', { resourceType: 'project', resourceId: 'p1', subject: null }), row('p2', { resourceType: 'project', resourceId: 'p1', subject: null })],
      TODAY,
    )
    expect(groups.map((group) => [group.key, group.subject])).toEqual([
      ['item:p1', null],
      ['item:p2', null],
    ])
  })
})

describe('newsOf and queueOrder', () => {
  it('news is what is unread and asks nothing; j/k walks the queue, then the news', () => {
    const news = row('news', { actionable: false, type: 'annotation.activity' })
    const read = row('read', { actionable: false, state: 'read', read: true })
    const waiting = row('waiting')
    expect(newsOf([waiting, news, read]).map((item) => item.id)).toEqual(['news'])
    expect(queueOrder(waitingGroups([waiting], TODAY), [news]).map((item) => item.id)).toEqual(['waiting', 'news'])
  })

  it('a request answered before the reader opened it is news: the badge counts every unread row', () => {
    // `state` says resolved before it says read; the badge reads `readAt`. Filtering
    // on `state` once left the badge at one over an empty queue.
    const answered = row('answered', { state: 'resolved', read: false })
    const answeredAndRead = row('seen', { state: 'resolved', read: true })
    const gone = row('gone', { actionable: false, state: 'inert', read: false })
    expect(newsOf([answered, answeredAndRead, gone]).map((item) => item.id)).toEqual(['answered'])
  })
})

describe('isAtHref', () => {
  const at = (search: string) => new URLSearchParams(search)
  it('is the same path with every parameter the link names, whatever else the address says', () => {
    const mark = '/app/projects/p1/files?doc=d1&review=1&mark=m4'
    expect(isAtHref(mark, '/app/projects/p1/files', at('doc=d1&review=1&mark=m4&tool=point'))).toBe(true)
    expect(isAtHref(mark, '/app/projects/p1/files', at('doc=d1&review=1&mark=m5'))).toBe(false)
    expect(isAtHref(mark, '/app/projects/p2/files', at('doc=d1&review=1&mark=m4'))).toBe(false)
  })

  it('ignores where the link returns to and where it scrolls', () => {
    expect(isAtHref('/app/projects/p1/chat?session=c1&back=%2Fapp%2Finbox#m-9', '/app/projects/p1/chat', at('session=c1'))).toBe(true)
  })
})
