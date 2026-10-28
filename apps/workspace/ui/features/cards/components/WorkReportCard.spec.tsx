// @disk-inputs: ../../tests/fixtures/answer_meta/work_payload.json
import { render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { I18nProvider } from '@/i18n'
import { answerMetaToAnatomy } from '@/features/chat/lib/answer-meta-cards'
import { AnatomyBlock } from '@/features/chat/components/AnswerAnatomy'
import { sanitizeAnswerMeta } from '@/lib/conversations/message-answer-meta'
import { WorkReportCard } from './WorkReportCard'

const render = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const WORK = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../tests/fixtures/answer_meta/work_payload.json'), 'utf-8')
) as unknown

describe('WorkReportCard', () => {
  test('a work turn’s report draws after the prose, the person’s decisions first', () => {
    const anatomy = answerMetaToAnatomy(sanitizeAnswerMeta(WORK) ?? undefined)
    expect(anatomy?.below.map((card) => card.type)).toEqual(['work_report'])
    const { container } = render(<AnatomyBlock card={anatomy!.below[0]!} />)
    expect(screen.getByRole('heading', { name: 'Arbeitsstand' })).toBeInTheDocument()
    const order = [...container.querySelectorAll('[data-testid^="work-report-"]')].map((node) =>
      node.getAttribute('data-testid')
    )
    expect(order).toEqual(['work-report-proposed', 'work-report-blocked', 'work-report-next', 'work-report-done'])
    expect(screen.getByText('Vorgeschlagen, wartet auf Sie')).toBeInTheDocument()
    expect(screen.getByText('Thomas Wagner als Bearbeiter ins Projekt aufnehmen')).toBeInTheDocument()
    expect(screen.getByText(/Wer: Fachplaner Brandschutz/)).toBeInTheDocument()
    expect(screen.getByText(/bis heute/)).toBeInTheDocument()
  })

  test('draws nothing for a report with no lines, and skips a section it has nothing for', () => {
    const { container } = render(<WorkReportCard done={[{ text: '' }]} />)
    expect(container).toBeEmptyDOMElement()
    render(<WorkReportCard next={[{ text: 'Statik nachfordern' }]} />)
    expect(screen.queryByText('Erledigt')).not.toBeInTheDocument()
    expect(screen.getByText('Als Nächstes')).toBeInTheDocument()
  })
})
