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
}

export function CreateProjectDialog({
  defaultOpen = false,
  label,
  variant = 'default',
  size = 'default',
  tourAnchor,
  addressClients,
}: CreateProjectDialogProps): JSX.Element {
  const t = useTranslations('projects')
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>
        <CreateProjectForm onCancel={() => handleOpenChange(false)} addressClients={addressClients} />
      </DialogContent>
    </Dialog>
  )
}
