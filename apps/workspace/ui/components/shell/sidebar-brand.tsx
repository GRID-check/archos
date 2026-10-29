'use client'

/**
 * The rail's head: the way home to all projects (the wordmark, or the logo on
 * the icon rail) and the control that folds the rail. The product's name is
 * copy, read from one place (`PRODUCT_NAME`).
 */

import Link from 'next/link'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'

import { Logo } from '@/components/brand/logo'
import { useSidebar } from '@/components/ui/sidebar'
import { useTranslations } from '@/i18n'
import { navCopy } from '@/i18n/namespaces/nav'
import { PRODUCT_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

export function SidebarBrand({ iconRail }: { iconRail: boolean }) {
  const t = useTranslations(navCopy)
  const { state, toggleSidebar, isMobile } = useSidebar()
  const collapsed = state === 'collapsed'

  return (
    <div className={cn('flex items-center', iconRail ? 'flex-col' : 'px-1.5')}>
      <Link
        href="/app/projects"
        aria-label={t('allProjects')}
        className={cn(
          'focus-visible:ring-ring/60 rounded-control focus-visible:outline-none focus-visible:ring-2',
          iconRail
            ? 'flex h-7 items-center justify-center'
            : 'text-foreground text-[19px] font-medium'
        )}
      >
        {iconRail ? <Logo kind="logo-only" size="small" /> : PRODUCT_NAME}
      </Link>
      {!isMobile && (
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          className={cn(
            'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/60 flex items-center justify-center rounded-control transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2',
            // Icon rail: exactly a nav tile (36px square), so it lands on the same
            // column and the same grid as the items below instead of reading as a
            // loose glyph floating in the header's dead space. It was `h-9 w-10` —
            // a 40px width that matched nothing else in the rail.
            iconRail ? 'mt-2 size-9' : 'ml-auto size-7'
          )}
        >
          {collapsed ? (
            <ChevronsRight className="size-4" aria-hidden />
          ) : (
            <ChevronsLeft className="size-4" aria-hidden />
          )}
        </button>
      )}
    </div>
  )
}
