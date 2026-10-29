import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge only knows Tailwind's stock radius names, so the semantic radii
// in tokens.css (`rounded-control`, `rounded-surface`, …) would never override a
// `rounded-*` default or a caller's `rounded-none`. Teach it the brand's ladder.
export const twMerge = extendTailwindMerge({
  extend: { classGroups: { rounded: [{ rounded: ['inline', 'control', 'surface', 'overlay', 'bubble'] }] } },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
