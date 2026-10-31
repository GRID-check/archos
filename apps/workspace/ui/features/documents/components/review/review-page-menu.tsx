'use client'

import type { JSX } from 'react'
import { Ellipsis } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useTranslations } from '@/i18n'
import { filesCopy } from '@/i18n/namespaces/files'
import { useReviewPageAction } from '../../preview-actions'
import { reviewToast } from './review-toaster'

/**
 * What can be done with the page in view, in the review's header: „Skizze auf
 * dieser Seite beginnen“ (S6). A page has one canvas, its review, so starting a
 * traced Skizze is an entry here rather than a second editor beside the page
 * (slice 1 of `docs/roadmap/working-on-a-plan.md`). The item is the diagrams
 * feature's, through the preview's slot (`../../preview-actions.tsx`); without
 * one, or with nowhere to open what it makes, there is no menu.
 */
export function ReviewPageMenu({
  documentId,
  page,
  onCreated,
}: {
  documentId: string
  page: number
  /** Opens what the page action made: a Skizze, with its own review. Null: nothing to offer. */
  onCreated: ((documentId: string) => void) | null
}): JSX.Element | null {
  const t = useTranslations(filesCopy)
  const Action = useReviewPageAction()
  if (!Action || !onCreated) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('review.pageMenu', { page })}
          title={t('review.pageMenu', { page })}
          data-testid="review-page-menu"
        >
          <Ellipsis aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72" data-testid="review-page-menu-content">
        <DropdownMenuLabel>{t('review.pageMenuLabel', { page })}</DropdownMenuLabel>
        <Action
          documentId={documentId}
          page={page}
          onCreated={onCreated}
          onFailed={(message) => toast.error(message, reviewToast())}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
