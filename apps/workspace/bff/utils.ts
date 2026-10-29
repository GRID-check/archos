import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge only knows Tailwind's stock radius names, so `rounded-control`
// and `rounded-surface` (tokens.css) would never override a `rounded-*` default
// or a caller's `rounded-none`. Teach it the two semantic radii.
export const twMerge = extendTailwindMerge({
  extend: { classGroups: { rounded: [{ rounded: ['control', 'surface'] }] } },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
