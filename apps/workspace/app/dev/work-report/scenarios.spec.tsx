import { render as rtlRender, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, test } from 'vitest'
import { I18nProvider } from '@/i18n'
import { AnatomyBlock } from '@/features/chat/components/AnswerAnatomy'
import { WORK_REPORT_SCENARIOS } from '../_fixtures/work-report'

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const sectionsOf = (id: string): (string | null)[] => {
  const scenario = WORK_REPORT_SCENARIOS.find((candidate) => candidate.id === id)
  const { container } = render(<AnatomyBlock card={{ type: 'work_report', ...scenario!.work }} />)
  return [...container.querySelectorAll('[data-testid^="work-report-"]')].map((node) => node.getAttribute('data-testid'))
}

describe('/dev/work-report scenarios', () => {
  test.each([
    ['done-only', ['work-report-done']],
    ['proposed', ['work-report-proposed']],
    ['blocked', ['work-report-blocked']],
    ['next', ['work-report-next']],
    ['full', ['work-report-proposed', 'work-report-blocked', 'work-report-next', 'work-report-done']],
    ['empty-hidden', ['work-report-next']],
  ])('%s draws exactly its sections', (id, expected) => {
    expect(sectionsOf(id)).toEqual(expected)
  })

  test('a blocked line names who, a next line who and by when', () => {
    render(<AnatomyBlock card={{ type: 'work_report', ...WORK_REPORT_SCENARIOS.find((s) => s.id === 'full')!.work }} />)
    expect(within(screen.getByTestId('work-report-blocked')).getByText(/Wer: Fachplaner Brandschutz/)).toBeInTheDocument()
    expect(within(screen.getByTestId('work-report-next')).getByText(/bis heute/)).toBeInTheDocument()
  })
})
