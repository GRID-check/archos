/**
 * The product logo: the wordmark, and where it would be too small, the icon.
 * The design system's logo is the wordmark alone, never beside a pictorial
 * mark, so the two never stand together.
 * The wordmark is the product's name (`PRODUCT_NAME`) set in capitals in
 * Switzer Semibold, tracked -0.02em: the one element of the app in capitals
 * and in that face (`.ui-wordmark`, packages/brand/css/components.css). The
 * face is the `@font-face` in `app/globals.css`, fetched only when this draws.
 * The icon is the app icon's glyph, the name's initial outlined from the same
 * face (`BRAND_MARK`, from `packages/brand/mark.svg`), drawn in `currentColor`
 * so it follows light and dark: for the collapsed icon rail, where the word
 * does not fit.
 */

import { type FC } from 'react'
import { BRAND_MARK, PRODUCT_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

interface LogoProps {
  /** 'wordmark' renders the name; 'icon' the initial alone, for a slot narrower than the word */
  kind?: 'wordmark' | 'icon'
  size?: 'small' | 'medium' | 'large'
  className?: string
}

/** Icon heights (the letter's cap height; it is as wide as it is tall). */
const iconSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'h-3.5',
  medium: 'h-5',
  large: 'h-7',
}

const wordmarkSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'text-[15px]',
  medium: 'text-xl',
  large: 'text-[32px]',
}

export const Logo: FC<LogoProps> = ({ kind = 'wordmark', size = 'medium', className }) => {
  return (
    <span className={cn('inline-flex items-center', className)} role="img" aria-label={PRODUCT_NAME}>
      {kind === 'icon' ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox={BRAND_MARK.viewBox}
          fill="currentColor"
          className={cn('aspect-square w-auto shrink-0 text-foreground', iconSize[size])}
          aria-hidden="true"
        >
          <path d={BRAND_MARK.path} />
        </svg>
      ) : (
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
