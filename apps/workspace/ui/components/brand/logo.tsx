/**
 * The product logo: the column mark plus the wordmark.
 * The mark is the master's path (`BRAND_MARK`, from `packages/brand/mark.svg`)
 * cropped to the column, drawn in `currentColor` so it follows light and dark.
 * The wordmark is the product's name (`PRODUCT_NAME`) set in capitals in
 * Switzer Semibold, tracked -0.02em: the one element of the app in capitals
 * and in that face (`.ui-wordmark`, packages/brand/css/components.css). The
 * face is the `@font-face` in `app/globals.css`, fetched only when this draws.
 */

import { type FC } from 'react'
import { BRAND_MARK, PRODUCT_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

interface LogoProps {
  /** 'horizontal' renders the mark + wordmark; 'logo-only' the mark alone; 'wordmark-only' the name alone */
  kind?: 'horizontal' | 'logo-only' | 'wordmark-only'
  size?: 'small' | 'medium' | 'large'
  className?: string
}

/** Mark heights; the width follows the column's 5:6. */
const markSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'h-5',
  medium: 'h-7',
  large: 'h-10',
}

const wordmarkSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'text-[15px]',
  medium: 'text-xl',
  large: 'text-[32px]',
}

export const Logo: FC<LogoProps> = ({ kind = 'horizontal', size = 'medium', className }) => {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} role="img" aria-label={PRODUCT_NAME}>
      {kind !== 'wordmark-only' && (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={BRAND_MARK.viewBox}
          fill="currentColor"
          className={cn('aspect-[5/6] w-auto shrink-0 text-primary', markSize[size])}
          aria-hidden="true"
        >
          <path d={BRAND_MARK.path} />
        </svg>
      )}
      {kind !== 'logo-only' && (
        <span
          className={cn(
            'font-logo font-semibold uppercase leading-none tracking-[-0.02em] text-foreground',
            wordmarkSize[size],
          )}
        >
          {PRODUCT_NAME}
        </span>
      )}
    </span>
  )
}
