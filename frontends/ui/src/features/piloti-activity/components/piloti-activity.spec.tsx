/**
 * „Was Piloti tut": what each section and row kind says, who it says it is
 * for, what the actions do, and what the view does when a read or an action
 * goes wrong.
 *
 * Rendered without an `I18nProvider`, so the words are the English ones; the
 * German is pinned by the dictionary type. The fixtures are the preview's own
 * (parsed through the contract by their spec), at a fixed instant.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'
import {
  pilotiActivityFixture,
  PILOTI_FIXTURE_PROJECT_ID,
} from '@/app/dev/_fixtures/piloti-activity'
import { AnnotationRequestError, updateAnnotation } from '@/lib/annotations/client'
import type { PilotiActivityResponse } from '@/lib/piloti-activity/types'
import { RunViewError, cancelRun } from '@/lib/runs/run-view-client'
import type { PilotiActivityFetcher } from '../hooks/use-piloti-activity'
import { PilotiActivity, type PilotiActivityActions } from './piloti-activity'

vi.mock('@/lib/annotations/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/annotations/client')>()),
  updateAnnotation: vi.fn(),
}))
vi.mock('@/lib/runs/run-view-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runs/run-view-client')>()),
  cancelRun: vi.fn(),
}))

const NOW = new Date('2026-10-13T12:00:00Z')
const PROJECT = PILOTI_FIXTURE_PROJECT_ID
const FULL = pilotiActivityFixture('full', NOW)

const serving = (...responses: PilotiActivityResponse[]) => {
  const fetcher = vi.fn<PilotiActivityFetcher>()
  for (const response of responses) fetcher.mockResolvedValueOnce(response)
  fetcher.mockResolvedValue(responses[responses.length - 1])
  return fetcher
}

const row = async (testId: string) => within(await screen.findByTestId(testId))

beforeEach(() => {
  vi.mocked(updateAnnotation).mockReset()
  vi.mocked(cancelRun).mockReset()
})

describe('PilotiActivity: the three sections', () => {
  test('names each section and counts what is in it', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const running = await row('piloti-activity-running')
    expect(running.getByRole('heading', { name: /Running now/ })).toBeInTheDocument()
    expect(running.getByText('5')).toBeInTheDocument()

    // Proposals count one each, proposed marks by the marks they hold: 3 + 5 + 1.
    const waiting = await row('piloti-activity-waiting')
    expect(waiting.getByRole('heading', { name: /Waiting for a decision/ })).toBeInTheDocument()
    expect(waiting.getByText('9')).toBeInTheDocument()
  })

  test('says a cut-off section is cut off, in words and with an „at least“ count', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const recent = await row('piloti-activity-recent')
    expect(recent.getByText(`${FULL.recent.items.length}+`)).toBeInTheDocument()
    expect(recent.getByText('There is more than fits here.')).toBeInTheDocument()
    // The other sections were not cut, so they claim no more.
    expect(screen.getAllByTestId('piloti-activity-truncated')).toHaveLength(1)
  })

  test('shows every row kind of the fixture', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)
    await screen.findByTestId('piloti-activity')

    for (const testId of [
      'activity-wake-wake-1',
      'activity-run-run-1',
      'activity-proposal-prop-1',
      'activity-proposed-marks-doc-bebauungsplan',
      'activity-wake-ended-wake-e1',
      'activity-run-finished-run-f1',
      'activity-changes-conv-einreichplan:msg-c1',
      'activity-proposal-decided-prop-d1',
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
  })
})

describe('PilotiActivity: whom a row is for', () => {
  test('„for you“ when the viewer is the person, the name for a colleague, „someone“ when the directory does not know them', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    expect((await row('activity-wake-wake-1')).getByText(/for you/)).toBeInTheDocument()
    expect((await row('activity-run-run-1')).getByText(/for Markus Klein/)).toBeInTheDocument()
    expect((await row('activity-run-run-3')).getByText(/for someone/)).toBeInTheDocument()
    expect((await row('activity-proposal-prop-3')).getByText(/for someone/)).toBeInTheDocument()
    expect(
      (await row('activity-changes-conv-einreichplan:msg-c1')).getByText(/for Markus Klein/)
    ).toBeInTheDocument()
    expect(
      (await row('activity-proposal-decided-prop-d1')).getByText(/for you/)
    ).toBeInTheDocument()
  })

  test('a group of proposed marks names the people the marks are for', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const group = await row('activity-proposed-marks-doc-bebauungsplan')
    expect(group.getByText('5 proposals from Piloti in Bebauungsplan_7B.pdf')).toBeInTheDocument()
    expect(group.getByText('for you, for Markus Klein')).toBeInTheDocument()
    // Three of five marks are listed, and the rest is said, not hidden.
    expect(group.getByText('and 2 more')).toBeInTheDocument()
    expect(group.getByText(/Annotation 11 · Defect · Bauplatzgrenze/)).toBeInTheDocument()
  })
})

describe('PilotiActivity: what a row says', () => {
  test('a woken turn names the mark, the document, how it began and the state', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const started = await row('activity-wake-wake-1')
    expect(started.getByText(/Annotation 4 · Defect · Fluchtweglänge/)).toBeInTheDocument()
    expect(started.getByText('Einreichplan_GR_EG.pdf · delegated · for you')).toBeInTheDocument()
    expect(started.getByText('Piloti is working on it')).toBeInTheDocument()

    const queued = await row('activity-wake-wake-2')
    expect(queued.getByText('Waiting for Piloti')).toBeInTheDocument()
    expect(queued.getByText(/mentioned/)).toBeInTheDocument()
  })

  test('a run names its kind and state in the task vocabulary', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const run = await row('activity-run-run-1')
    expect(run.getByText('Einreichcheck vor Abgabe')).toBeInTheDocument()
    expect(run.getByText('Submission check · for Markus Klein')).toBeInTheDocument()
    expect(run.getByText('Running')).toBeInTheDocument()
    expect((await row('activity-run-run-2')).getByText('Queued')).toBeInTheDocument()
  })

  test('a proposal names its kind and says when the reader may decide it', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const yours = await row('activity-proposal-prop-1')
    expect(yours.getByText('Bauherr bevorzugt Sichtbeton an der Nordfassade.')).toBeInTheDocument()
    expect(yours.getByText('Memory · for you')).toBeInTheDocument()
    expect(yours.getByText('You can decide')).toBeInTheDocument()
    expect(
      (await row('activity-proposal-prop-2')).queryByText('You can decide')
    ).not.toBeInTheDocument()
  })

  test.each([
    ['wake-e2', 'Piloti did not get to it in time', 'gave up waiting: job not claimed after 120s'],
    ['wake-e3', 'Budget used up', 'budget: project limit exhausted'],
    ['wake-e4', 'No permission any more', 'rejected: auth_expired'],
    ['wake-e5', 'Interrupted', 'turn ended without an answer'],
  ])(
    'a failed or refused wake (%s) is worded by its class, and the log line is only a tooltip',
    async (id, word, reason) => {
      render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

      const wake = await row(`activity-wake-ended-${id}`)
      expect(wake.getByText(word)).toHaveAttribute('title', reason)
      expect(wake.queryByText(reason)).not.toBeInTheDocument()
    }
  )

  test('a wake that answered or was stopped says so, with no tooltip', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    expect((await row('activity-wake-ended-wake-e1')).getByText('Answered')).not.toHaveAttribute(
      'title'
    )
    expect((await row('activity-wake-ended-wake-e6')).getByText('Stopped')).toBeInTheDocument()
  })

  test('a failed wake from a server that sent no class falls back to the plain status word', async () => {
    const wake = FULL.recent.items.find(
      (item) => item.kind === 'wake_ended' && item.status === 'failed'
    )
    if (wake?.kind !== 'wake_ended') throw new Error('fixture has no failed wake')
    const response = {
      ...FULL,
      recent: { ...FULL.recent, items: [{ ...wake, reasonKind: null, reason: null }] },
    }
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(response)} />)

    expect(
      (await row(`activity-wake-ended-${wake.id}`)).getByText('Not finished')
    ).toBeInTheDocument()
  })

  test('a finished run says how it ended, what it filed and what went wrong', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const done = await row('activity-run-finished-run-f1')
    expect(done.getByText('Done')).toBeInTheDocument()
    expect(done.getByText('Filed as Brandschutzkonzept_Haus_A.pdf')).toBeInTheDocument()
    const failed = await row('activity-run-finished-run-f2')
    expect(failed.getByText('Failed')).toBeInTheDocument()
    expect(failed.getByText('Der Bericht konnte nicht geschrieben werden.')).toBeInTheDocument()
  })

  test('a turn’s changes count the marks, name the documents and say what was undone', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const partly = await row('activity-changes-conv-einreichplan:msg-c1')
    expect(partly.getByText('4 changes to annotations')).toBeInTheDocument()
    expect(
      partly.getByText(
        'in Einreichplan_GR_EG.pdf, Bebauungsplan_7B.pdf, Statik_Vorbemessung.xlsx and 2 more · for Markus Klein'
      )
    ).toBeInTheDocument()
    expect(partly.getByText('1 of 4 undone')).toBeInTheDocument()
    expect(
      (await row('activity-changes-conv-brandschutz:msg-c2')).getByText('undone')
    ).toBeInTheDocument()
  })

  test.each([
    ['prop-d1', 'Applied by Markus Klein'],
    // The reader decided this one: their own decision reads "by you", as their rows read "for you".
    ['prop-d2', 'Partly applied by you'],
    ['prop-d3', 'Failed'],
    ['prop-d4', 'Discarded by Markus Klein'],
  ])('a decided proposal (%s) says how it ended', async (id, word) => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    expect((await row(`activity-proposal-decided-${id}`)).getByText(word)).toBeInTheDocument()
  })
})

describe('PilotiActivity: where a row leads', () => {
  test('a mark, its turn, a run, a task and the project chat each get the link of their target', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    const wake = await row('activity-wake-wake-1')
    expect(wake.getByRole('link', { name: 'Show in document' })).toHaveAttribute(
      'href',
      `/app/projects/${PROJECT}/files?doc=doc-einreichplan&review=1&mark=mark-4`
    )
    expect(wake.getByRole('link', { name: 'Open in the conversation' })).toHaveAttribute(
      'href',
      `/app/projects/${PROJECT}/chat?session=conv-einreichplan#message-msg-wake-1`
    )
    expect(
      (await row('activity-run-run-1')).getByRole('link', { name: 'Open in the conversation' })
    ).toHaveAttribute(
      'href',
      `/app/projects/${PROJECT}/chat?session=conv-einreich&run=run-1#message-msg-run-1`
    )
    expect(
      (await row('activity-run-run-2')).getByRole('link', { name: 'Open task' })
    ).toHaveAttribute('href', `/app/projects/${PROJECT}/automation?tab=tasks&task=task-stiegenhaus`)
    expect(
      (await row('activity-proposal-prop-2')).getByRole('link', {
        name: 'Open in the conversation',
      })
    ).toHaveAttribute('href', `/app/projects/${PROJECT}/chat`)
  })

  test('a row whose target is gone has no link, and a wake with no readable thread has only the mark', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    expect((await row('activity-run-run-3')).queryByRole('link')).not.toBeInTheDocument()
    const queued = await row('activity-wake-wake-2')
    expect(queued.getAllByRole('link')).toHaveLength(1)
  })
})

describe('PilotiActivity: empty states', () => {
  test('a project Piloti has not worked in gets one empty state instead of three', async () => {
    render(
      <PilotiActivity projectId={PROJECT} fetcher={serving(pilotiActivityFixture('empty', NOW))} />
    )

    expect(
      await screen.findByText('Piloti has not been active in this project yet.')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('piloti-activity-running')).not.toBeInTheDocument()
  })

  test('with only waiting rows, the other two sections stay and say why they are empty', async () => {
    render(
      <PilotiActivity
        projectId={PROJECT}
        fetcher={serving(pilotiActivityFixture('waiting-only', NOW))}
      />
    )

    const running = await row('piloti-activity-running')
    expect(
      running.getByText('Piloti is not working on anything in this project right now.')
    ).toBeInTheDocument()
    expect(
      running.getByText('Delegate an open annotation to Piloti and it shows up here.')
    ).toBeInTheDocument()
    expect(
      (await row('piloti-activity-recent')).getByText(
        'Piloti has not finished anything here in the last 14 days.'
      )
    ).toBeInTheDocument()
    expect((await row('piloti-activity-waiting')).getByText('9')).toBeInTheDocument()
  })

  test('the delegate hint is held back where the organization does not wake Piloti', async () => {
    const response = {
      ...pilotiActivityFixture('waiting-only', NOW),
      capabilities: { wakes: false, automation: true },
    }
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(response)} />)

    expect(
      await screen.findByText('Piloti is not working on anything in this project right now.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Delegate an open annotation/)).not.toBeInTheDocument()
  })

  test('nothing waiting says nothing waits', async () => {
    const response = { ...FULL, waiting: { items: [], truncated: false } }
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(response)} />)

    expect(
      (await row('piloti-activity-waiting')).getByText('Nothing is waiting for a decision.')
    ).toBeInTheDocument()
  })
})

describe('PilotiActivity: taking a delegation back', () => {
  test('is offered only where the server said this reader may', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    expect(
      (await row('activity-wake-wake-1')).getByRole('button', { name: 'Take back from Piloti' })
    ).toBeInTheDocument()
    expect(
      (await row('activity-wake-wake-2')).queryByRole('button', { name: 'Take back from Piloti' })
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Take back from Piloti' })).toHaveLength(1)
  })

  test('asks first, then lets the delegation go with the mark still open and reads again', async () => {
    const user = userEvent.setup()
    vi.mocked(updateAnnotation).mockResolvedValue({} as never)
    const fetcher = serving(FULL)
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    await user.click(
      (await row('activity-wake-wake-1')).getByRole('button', { name: 'Take back from Piloti' })
    )
    expect(updateAnnotation).not.toHaveBeenCalled()
    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Take annotation 4 back from Piloti?')).toBeInTheDocument()
    expect(dialog.getByText('Piloti stops working on annotation 4.')).toBeInTheDocument()

    await user.click(screen.getByTestId('piloti-activity-confirm'))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(updateAnnotation).toHaveBeenCalledWith('doc-einreichplan', 'mark-4', {
      delegateToPiloti: false,
      expectedStatus: 'open',
    })
    expect(screen.queryByTestId('piloti-activity-notice')).not.toBeInTheDocument()
  })

  test('declining the confirmation changes nothing', async () => {
    const user = userEvent.setup()
    const fetcher = serving(FULL)
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    await user.click(
      (await row('activity-wake-wake-1')).getByRole('button', { name: 'Take back from Piloti' })
    )
    await user.click(await screen.findByRole('button', { name: 'Let Piloti carry on' }))

    expect(updateAnnotation).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('a 409 says it changed in the meantime and reads again', async () => {
    const user = userEvent.setup()
    vi.mocked(updateAnnotation).mockRejectedValue(
      new AnnotationRequestError(409, 'CONFLICT', 'no longer open')
    )
    const fetcher = serving(FULL)
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    await user.click(
      (await row('activity-wake-wake-1')).getByRole('button', { name: 'Take back from Piloti' })
    )
    await user.click(await screen.findByTestId('piloti-activity-confirm'))

    expect(
      await screen.findByText('This changed in the meantime. The list shows the current state.')
    ).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('any other failure is said too, and the list is read again', async () => {
    const user = userEvent.setup()
    vi.mocked(updateAnnotation).mockRejectedValue(
      new AnnotationRequestError(500, 'UNKNOWN', 'boom')
    )
    const fetcher = serving(FULL)
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    await user.click(
      (await row('activity-wake-wake-1')).getByRole('button', { name: 'Take back from Piloti' })
    )
    await user.click(await screen.findByTestId('piloti-activity-confirm'))

    expect(
      await screen.findByText('That did not work. The list shows the current state.')
    ).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('PilotiActivity: stopping a run', () => {
  test('is offered only where the server said this reader may', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} />)

    expect(
      (await row('activity-run-run-1')).getByRole('button', { name: 'Cancel' })
    ).toBeInTheDocument()
    expect(
      (await row('activity-run-run-2')).queryByRole('button', { name: 'Cancel' })
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1)
  })

  test('asks first, naming the run, then cancels it and reads again', async () => {
    const user = userEvent.setup()
    vi.mocked(cancelRun).mockResolvedValue({} as never)
    const fetcher = serving(FULL)
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    await user.click((await row('activity-run-run-1')).getByRole('button', { name: 'Cancel' }))
    expect(cancelRun).not.toHaveBeenCalled()
    expect(
      await screen.findByText('“Einreichcheck vor Abgabe” will be cancelled.')
    ).toBeInTheDocument()

    await user.click(screen.getByTestId('piloti-activity-confirm'))

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(cancelRun).toHaveBeenCalledWith(PROJECT, 'run-1')
  })

  test('a 409 (it ended already) says so and reads again', async () => {
    const user = userEvent.setup()
    vi.mocked(cancelRun).mockRejectedValue(new RunViewError(409, 'already ended'))
    const fetcher = serving(FULL)
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    await user.click((await row('activity-run-run-1')).getByRole('button', { name: 'Cancel' }))
    await user.click(await screen.findByTestId('piloti-activity-confirm'))

    expect(
      await screen.findByText('This changed in the meantime. The list shows the current state.')
    ).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('PilotiActivity: actions that are injected', () => {
  test('a preview’s own actions replace the clients', async () => {
    const user = userEvent.setup()
    const actions: PilotiActivityActions = {
      takeBack: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} actions={actions} />)

    await user.click((await row('activity-run-run-1')).getByRole('button', { name: 'Cancel' }))
    await user.click(await screen.findByTestId('piloti-activity-confirm'))

    await waitFor(() => expect(actions.stop).toHaveBeenCalledTimes(1))
    expect(cancelRun).not.toHaveBeenCalled()
  })

  test('defaultConfirm opens the first matching confirmation once the rows are there', async () => {
    render(<PilotiActivity projectId={PROJECT} fetcher={serving(FULL)} defaultConfirm="stop" />)

    expect(await screen.findByText('Cancel this task?')).toBeInTheDocument()
  })
})

describe('PilotiActivity: loading and failing', () => {
  test('shows a placeholder until the first read lands', async () => {
    let release: (response: PilotiActivityResponse) => void = () => {}
    const fetcher = vi.fn<PilotiActivityFetcher>(
      () => new Promise((resolve) => (release = resolve))
    )
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    expect(screen.getByTestId('piloti-activity-loading')).toBeInTheDocument()
    release(FULL)
    expect(await screen.findByTestId('piloti-activity')).toBeInTheDocument()
  })

  test('a failed first read says so and retries on request', async () => {
    const user = userEvent.setup()
    const fetcher = vi
      .fn<PilotiActivityFetcher>()
      .mockRejectedValueOnce(new Error('503'))
      .mockResolvedValue(FULL)
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    expect(await screen.findByText('This could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByTestId('piloti-activity-running')).toBeInTheDocument()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('a failed re-read keeps the rows on screen and says it could not be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(updateAnnotation).mockResolvedValue({} as never)
    const fetcher = vi
      .fn<PilotiActivityFetcher>()
      .mockResolvedValueOnce(FULL)
      .mockRejectedValue(new Error('offline'))
    render(<PilotiActivity projectId={PROJECT} fetcher={fetcher} />)

    await user.click(
      (await row('activity-wake-wake-1')).getByRole('button', { name: 'Take back from Piloti' })
    )
    await user.click(await screen.findByTestId('piloti-activity-confirm'))

    expect(await screen.findByTestId('piloti-activity-stale')).toBeInTheDocument()
    expect(screen.getByTestId('activity-wake-wake-1')).toBeInTheDocument()
  })
})
