'use client'

import type { JSX } from 'react'
import { useCallback, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'

import { Button, type ButtonProps } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { CreateProjectForm, type CreateProjectFormProps } from './create-project-form'
import { useTranslations } from '@/i18n'
import { projectsCopy } from '@/i18n/namespaces/projects'

interface CreateProjectDialogProps {
  /** Open on mount — wired to `/app/projects?new=1` from the project switcher. */
  defaultOpen?: boolean
  label?: string
  variant?: ButtonProps['variant']
  size?: ButtonProps['size']
  /** Marks the trigger as a product-tour stop (`data-tour`). */
  tourAnchor?: string
  /** The address lookups of the form; the `/dev` preview brings fixtures. */
  addressClients?: CreateProjectFormProps['addressClients']
  /** What the form starts with; the `/dev` preview shows it filled in. */
  initial?: CreateProjectFormProps['initial']
}

export function CreateProjectDialog({
  defaultOpen = false,
  label,
  variant = 'default',
  size = 'default',
  tourAnchor,
  addressClients,
  initial,
}: CreateProjectDialogProps): JSX.Element {
  const t = useTranslations(projectsCopy)
  const router = useRouter()
  const pathname = usePathname()
  const [open, setOpen] = useState(defaultOpen)

  // When this dialog was auto-opened from `?new=1` (project switcher deep link),
  // strip the param on close so a refresh or back-navigation doesn't re-open it.
  const handleOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next)
      if (!next && defaultOpen && pathname) {
        router.replace(pathname, { scroll: false })
      }
    },
    [defaultOpen, pathname, router],
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} data-tour={tourAnchor}>
          <Plus className="size-4" />
          {label ?? t('dialog.newProject')}
        </Button>
      </DialogTrigger>
      <DialogContent
        fullScreenOnMobile
        // The mockup's 560px card: roomier padding and radius than the kit's
        // default dialog, the same on every screen that is not a phone.
        className="sm:top-[84px] sm:max-h-[calc(100dvh-84px-1.5rem)] sm:max-w-[560px] sm:translate-y-0 sm:rounded-surface sm:p-7"
        // Radix puts focus on the first field when a dialog opens, which on a
        // touch device opens the keyboard over the form before anyone has read
        // it. The dialog itself takes the focus there instead (so a screen
        // reader still lands inside it); a mouse user keeps the name field.
        onOpenAutoFocus={(event) => {
          if (typeof window.matchMedia !== 'function' || !window.matchMedia('(pointer: coarse)').matches) return
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
        }}
      >
        <DialogHeader className="mb-1 gap-1.5 pr-8">
          <DialogTitle className="text-xl tracking-tight">{t('dialog.title')}</DialogTitle>
          <DialogDescription className="text-sm">{t('dialog.description')}</DialogDescription>
        </DialogHeader>
        <CreateProjectForm onCancel={() => handleOpenChange(false)} addressClients={addressClients} initial={initial} />
      </DialogContent>
    </Dialog>
  )
}
