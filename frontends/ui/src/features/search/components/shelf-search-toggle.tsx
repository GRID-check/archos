'use client'

import type { JSX } from 'react'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'

/** The way back from a shelf's search to its listing. */
export function ShelfSearchBack({ onClose, label }: { onClose: () => void; label: 'backToFiles' | 'backToShelf' }): JSX.Element {
  const t = useTranslations('search.mode')
  return (
    <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="shelf-search-close">
      <ArrowLeft aria-hidden />
      {t(label)}
    </Button>
  )
}
