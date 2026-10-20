'use client'

import type { JSX } from 'react'
import { FileText } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import type { DropInfo } from '@/features/documents/hooks/use-file-drag-drop'
import { useTranslations } from '@/i18n'
import type { DocumentRequest, IntakeDecision } from '@/lib/project-intake/types'
import { usePressed } from '../../hooks/use-pressed'
import { DocumentHandIn } from '../document-hand-in'
import { NeedAnswer } from '../question-section'

/**
 * A document the location register asks for: the document by its name, what
 * it settles and why (for this Bundesland and Gemeinde), the law it rests on,
 * and three ways to settle it in the same place: hand the document in right
 * here (Piloti reads it and the request closes when the values are found),
 * state the values directly with the wizard's own controls, or say they are
 * not known.
 */
export function DocumentRequestCard({
  request,
  canDecide,
  busy,
  onDecide,
  onFiles,
  canUpload,
}: {
  request: DocumentRequest
  canDecide: boolean
  busy: boolean
  onDecide: (decisions: IntakeDecision[]) => Promise<boolean>
  onFiles: (files: File[], info?: DropInfo) => void
  canUpload: boolean
}): JSX.Element {
  const t = useTranslations('intakeQuestionsStep')
  const tIntake = useTranslations('projectIntake')
  const [markingUnknown, markUnknown] = usePressed()
  const sources = request.sources.map((source) => source.title).join(' · ')
  const open = request.needs

  return (
    <RaisedCard data-testid={`document-request-${request.determinant}`}>
      <RaisedCardBody className="divide-border divide-y p-0">
        <div className="space-y-1.5 px-4 pt-3.5 pb-3">
          <p className="text-muted-foreground text-xs">{request.label}</p>
          <h3 className="flex items-start gap-2 text-sm font-semibold">
            <FileText className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
            {request.document}
          </h3>
          <p className="text-muted-foreground text-sm hyphens-auto">{request.reason}</p>
          {sources && <p className="text-muted-foreground text-xs">{t('request.sources', { sources })}</p>}
        </div>
        {canUpload && (
          <div className="px-2 py-1.5">
            <DocumentHandIn label={request.document} onFiles={onFiles} disabled={!canDecide} />
          </div>
        )}
        {open.length > 0 && (
          <div className="space-y-4 px-4 pt-3 pb-3.5">
            <p className="text-muted-foreground text-xs">{t('request.answerInstead')}</p>
            {open.map((need) => (
              <NeedAnswer
                key={need.key}
                need={need}
                canDecide={canDecide}
                busy={busy}
                onDecide={onDecide}
                withUnknown={false}
                showFoundIn={false}
              />
            ))}
            <BusyButton
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canDecide}
              busy={markingUnknown}
              blocked={busy}
              busyLabel={tIntake('busy.unknown')}
              aria-label={t('request.unknownAria', { label: request.label })}
              onClick={() => markUnknown(() => onDecide(open.map((need) => ({ key: need.key, action: 'unknown' }))))}
            >
              {t('request.unknown')}
            </BusyButton>
          </div>
        )}
      </RaisedCardBody>
    </RaisedCard>
  )
}
