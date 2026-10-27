'use client'

import type { JSX } from 'react'
import { ArrowLeft, Search } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'

/** The door into a shelf's search, in the shelf's header. */
export function ShelfSearchToggle({ onOpen }: { onOpen: () => void }): JSX.Element {
  const t = useTranslations('search.mode')
  return (
    <Button type="button" variant="outline" size="sm" onClick={onOpen} title={t('openHint')} data-testid="shelf-search-open">
      <Search aria-hidden />
      {t('open')}
    </Button>
  )
}

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
