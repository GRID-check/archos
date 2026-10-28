'use client'

/**
 * Dev preview: „Arbeitsstand", the closing block of an operations turn
 * (`kind: work`, ADR-0123), in the states a turn can leave it in:
 *
 *   1. Only done: one section, no empty ones above it.
 *   2. Proposed, waiting for the person: lines that carry the proposal's ref.
 *   3. Blocked, with who it waits on.
 *   4. Next steps, with who and by when.
 *   5. The full mix, in the order the reader acts in.
 *   6. Empty lists: hidden, only the section with lines remains.
 *
 * Drawn through the real `AnatomyBlock` as an answer draws it (a `work_report`
 * card below the prose), on the answer surface. Fixtures:
 * `../_fixtures/work-report.ts`. Gated by `../layout.tsx`. Pinned to German.
 */

import type { FC } from 'react'
import { I18nProvider } from '@/i18n'
import { AnatomyBlock } from '@/features/chat/components/AnswerAnatomy'
import { WORK_REPORT_SCENARIOS } from '../_fixtures/work-report'

const Preview: FC = () => (
  <main
    data-testid="work-report-preview"
    className="text-foreground mx-auto flex w-full max-w-[680px] flex-col gap-10 p-4 sm:p-6"
  >
    {WORK_REPORT_SCENARIOS.map(({ id, title, note, work }) => (
      <section key={id} data-testid={`work-report-scenario-${id}`} className="flex flex-col gap-3">
        <div>
          <h2 className="text-foreground text-sm font-semibold">{title}</h2>
          <p className="text-muted-foreground text-xs">{note}</p>
        </div>
        <AnatomyBlock card={{ type: 'work_report', ...work }} />
      </section>
    ))}
  </main>
)

export default function WorkReportPreviewPage() {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Preview />
    </I18nProvider>
  )
}
