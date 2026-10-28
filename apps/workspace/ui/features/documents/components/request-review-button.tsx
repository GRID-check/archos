'use client'

/**
 * „Prüfung anfragen" (ADR-0086): the uploader asks the people who may review
 * and allow a file held back by the content check to look at it.
 *
 * One button for every surface that shows the uploader their held file: the
 * upload summary, and the Files preview. The server refuses anyone but the
 * uploader, so a surface shows it only to them. Once sent, it says so and
 * rests: a second press would only fold into the same inbox row.
 */

import { useState, type JSX } from 'react'
import { ShieldQuestion } from 'lucide-react'
import { toast } from 'sonner'

import { requestQuarantineRelease } from '@/adapters/api/upload-screening-client'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { uploadBatchesCopy } from '@/i18n/namespaces/upload-batches'

export interface RequestReviewButtonProps {
  documentId: string
  /** The name the toasts say. */
  name: string
  className?: string
  testId?: string
}

export function RequestReviewButton({
  documentId,
  name,
  className,
  testId = `request-review-${documentId}`,
}: RequestReviewButtonProps): JSX.Element {
  const t = useTranslations(uploadBatchesCopy)
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle')

  const ask = async (): Promise<void> => {
    setState('sending')
    try {
      const { notified } = await requestQuarantineRelease(documentId)
      setState('sent')
      if (notified > 0) toast.success(t('summary.files.releaseRequestedToast', { name }))
      else toast.info(t('summary.files.releaseRequestNobody', { name }))
    } catch {
      setState('idle')
      toast.error(t('summary.files.releaseRequestError'))
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className={className}
      disabled={state !== 'idle'}
      loading={state === 'sending'}
      onClick={() => void ask()}
      data-testid={testId}
    >
      <ShieldQuestion className="size-4" aria-hidden />
      {state === 'sent' ? t('summary.files.releaseRequested') : t('summary.files.requestRelease')}
    </Button>
  )
}
